import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppVars, DbUser, Env, Query } from "./env";
import { fail } from "./http";
import { looksLikeFirebaseToken, verifyFirebaseToken } from "./firebaseAuth";

type C = Context<{ Bindings: Env; Variables: AppVars }>;

const enc = new TextEncoder();
const b64u = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uDecode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const hmacKey = (env: Env, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", enc.encode(env.JWT_SECRET_KEY), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

/** Same wire format as the Python API (HS256, `sub`, `exp`) plus `tv` (revocation epoch) and `jti` (per-token id). */
export async function createAccessToken(env: Env, sub: string, tokenVersion = 0): Promise<string> {
  const hours = Number(env.JWT_EXPIRATION_HOURS) || 24;
  const head = b64u(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64u(
    enc.encode(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + hours * 3600, tv: tokenVersion, jti: crypto.randomUUID() })),
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env, "sign"), enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64u(sig)}`;
}

export interface TokenClaims { sub: string; exp: number; tv: number; jti: string | null }

/** Verifies signature (algorithm pinned to HS256) and expiry. Tokens minted before `tv`/`jti` existed read as tv=0, jti=null. */
export async function claimsFromToken(env: Env, token: string): Promise<TokenClaims | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = JSON.parse(new TextDecoder().decode(b64uDecode(parts[0])));
    if (header.alg !== "HS256") return null; // rejects alg:none and algorithm confusion
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env, "verify"), b64uDecode(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(b64uDecode(parts[1])));
    if (typeof p.exp !== "number" || p.exp <= Date.now() / 1000 || typeof p.sub !== "string") return null;
    return { sub: p.sub, exp: p.exp, tv: typeof p.tv === "number" ? p.tv : 0, jti: typeof p.jti === "string" ? p.jti : null };
  } catch {
    return null;
  }
}

/** Returns the user id (`sub`) of a cryptographically valid token, else null. Does NOT check revocation; use resolveUser. */
export async function subjectFromToken(env: Env, token: string): Promise<string | null> {
  return (await claimsFromToken(env, token))?.sub ?? null;
}

// Password hashing runs INSIDE Postgres (pgcrypto bcrypt, `$2a$` format): the
// Workers Free plan allows ~10 ms CPU per request and pure-JS bcrypt needs
// 80-300 ms. pgcrypto output is interchangeable with Python's bcrypt, so
// existing hashes keep working. Passwords travel to the database only over
// TLS, as bound query parameters (never interpolated, never logged).
export const BCRYPT_COST = 10;

const sameSite = (v: string) => (v.toLowerCase() === "none" ? "None" : v.toLowerCase() === "strict" ? "Strict" : "Lax") as "None" | "Strict" | "Lax";

export function setAuthCookie(c: C, token: string): void {
  const e = c.env;
  setCookie(c, e.AUTH_COOKIE_NAME, token, {
    maxAge: (Number(e.JWT_EXPIRATION_HOURS) || 24) * 3600,
    httpOnly: true,
    secure: e.AUTH_COOKIE_SECURE === "true",
    sameSite: sameSite(e.AUTH_COOKIE_SAMESITE),
    domain: e.AUTH_COOKIE_DOMAIN || undefined,
    path: "/",
  });
}

export function clearAuthCookie(c: C): void {
  deleteCookie(c, c.env.AUTH_COOKIE_NAME, { domain: c.env.AUTH_COOKIE_DOMAIN || undefined, path: "/" });
}

const MISSING_SCHEMA = /revoked_tokens|token_version|login_attempts|auth_tokens|audit_log|email_verified_at|mfa_/i;

/**
 * Resolves a token of either kind to the owning user row, or null. Enforces revocation:
 * a token is rejected when its jti was revoked (logout) or its `tv` no longer matches users.token_version
 * (password change/reset, "sign out everywhere"). Firebase ID tokens (RS256) are verified against Google's keys
 * and mapped through users.firebase_uid; Firebase manages their lifetime. Shared by HTTP and WebSocket auth.
 */
export async function resolveUser(env: Env, query: Query, token: string): Promise<DbUser | null> {
  if (looksLikeFirebaseToken(token)) {
    const claims = await verifyFirebaseToken(env, token);
    if (!claims) return null;
    const rows = await query("SELECT * FROM users WHERE firebase_uid = $1", [claims.uid]);
    return (rows[0] as DbUser | undefined) ?? null;
  }
  const claims = await claimsFromToken(env, token);
  if (!claims) return null;
  try {
    const rows = await query(
      "SELECT u.*, EXISTS(SELECT 1 FROM revoked_tokens r WHERE r.jti = $2) AS _revoked FROM users u WHERE u.id = $1",
      [claims.sub, claims.jti ?? ""],
    );
    const row = rows[0] as (DbUser & { _revoked?: boolean }) | undefined;
    if (!row || row._revoked || claims.tv !== (row.token_version ?? 0)) return null;
    delete row._revoked;
    return row;
  } catch (e) {
    // Rollout safety only: before migration 003 exists the revocation columns are absent. Any other error stays an error.
    if (!MISSING_SCHEMA.test(String((e as Error)?.message))) throw e;
    console.error("revocation_schema_missing: apply migration 003");
    const rows = await query("SELECT * FROM users WHERE id = $1", [claims.sub]);
    return (rows[0] as DbUser | undefined) ?? null;
  }
}

export async function userIdFromToken(env: Env, query: Query, token: string): Promise<string | null> {
  return (await resolveUser(env, query, token))?.id ?? null;
}

export function tokenFromRequest(c: C): string | undefined {
  const auth = c.req.header("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.split(/\s+/, 2)[1]?.trim();
  return getCookie(c, c.env.AUTH_COOKIE_NAME);
}

/** Bearer header first, then the httpOnly cookie. Sets c.var.user (or null). */
export const loadUser: MiddlewareHandler<{ Bindings: Env; Variables: AppVars }> = async (c, next) => {
  const token = tokenFromRequest(c);
  c.set("user", token ? await resolveUser(c.env, c.var.query, token) : null);
  await next();
};

export const requireUser: MiddlewareHandler<{ Bindings: Env; Variables: AppVars }> = async (c, next) => {
  const user = c.var.user;
  if (!user) fail(401, "Not authenticated", { "WWW-Authenticate": "Bearer" });
  if (!user!.is_active) fail(403, "Inactive user");
  await next();
};
