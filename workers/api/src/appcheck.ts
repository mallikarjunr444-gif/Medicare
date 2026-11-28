import type { MiddlewareHandler } from "hono";
import type { Env } from "./env";

// Firebase App Check (free): proves a request comes from the genuine MediCare web app, not a script.
// Verified exactly like the Admin SDK does it: RS256 against Google's App Check keys + iss/aud/exp checks.
// https://firebase.google.com/docs/app-check/custom-resource-backend
const JWKS_URL = "https://firebaseappcheck.googleapis.com/v1/jwks";
type Jwk = JsonWebKey & { kid?: string };
type KeyFetcher = () => Promise<Jwk[]>;
const dec = new TextDecoder();
const bytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const json = (s: string) => JSON.parse(dec.decode(bytes(s)));

let fetcher: KeyFetcher = async () => {
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new Error(`jwks_${r.status}`);
  return ((await r.json()) as { keys: Jwk[] }).keys;
};
let cache: { keys: Map<string, CryptoKey>; at: number } | null = null;
export function setAppCheckKeyFetcherForTests(f: KeyFetcher | null) {
  fetcher = f ?? fetcher;
  cache = null;
}

async function keyFor(kid: string): Promise<CryptoKey | null> {
  const now = Date.now();
  if (cache && now - cache.at < 3_600_000 && cache.keys.has(kid)) return cache.keys.get(kid)!;
  if (cache && now - cache.at < 60_000) return null; // bound refetches caused by forged kids
  const map = new Map<string, CryptoKey>();
  for (const k of await fetcher()) if (k.kid) map.set(k.kid, await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  cache = { keys: map, at: now };
  return map.get(kid) ?? null;
}

export async function verifyAppCheckToken(env: Env, token: string): Promise<boolean> {
  const num = env.APPCHECK_PROJECT_NUMBER;
  if (!num) return false;
  try {
    const [h, p, s] = token.split(".");
    const header = json(h);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return false;
    const key = await keyFor(header.kid);
    if (!key || !(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, bytes(s), new TextEncoder().encode(`${h}.${p}`)))) return false;
    const c = json(p);
    const now = Date.now() / 1000;
    return c.iss === `https://firebaseappcheck.googleapis.com/${num}` && Array.isArray(c.aud) && c.aud.includes(`projects/${num}`) &&
      typeof c.exp === "number" && c.exp > now - 60 && typeof c.sub === "string" && !!c.sub;
  } catch {
    return false;
  }
}

/** Enforced only when APPCHECK_ENFORCE="true" (so the site is not locked out before the frontend sends tokens). */
export const appCheckGuard: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.env.APPCHECK_ENFORCE === "true" && c.req.method !== "OPTIONS") {
    const t = c.req.header("x-firebase-appcheck");
    if (!t || !(await verifyAppCheckToken(c.env, t))) return c.json({ detail: "App attestation failed" }, 401);
  }
  await next();
};
