import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { base32Encode, hotp, totpStep, verifyTotp } from "../src/totp";

const env: Env = {
  DATABASE_URL: "unused",
  JWT_SECRET_KEY: "test-secret-test-secret-test-secret-123456",
  ENVIRONMENT: "test",
  CORS_ORIGINS: "https://app.example.web.app",
  AUTH_COOKIE_NAME: "access_token",
  AUTH_COOKIE_SECURE: "false",
  AUTH_COOKIE_SAMESITE: "lax",
  JWT_EXPIRATION_HOURS: "24",
  GUEST_ACCOUNTS_ENABLED: "true",
  EMAIL_API_KEY: "test-key",
  EMAIL_FROM: "MediCare <no-reply@example.com>",
};
let db: PGlite;
let app: ReturnType<typeof createApp>;
const call = (path: string, init: RequestInit = {}) => app.request(path, init, env);
const jsonReq = (method: string, body?: unknown, token?: string, extra: Record<string, string> = {}): RequestInit => ({
  method,
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const bearer = (t: string): RequestInit => ({ headers: { authorization: `Bearer ${t}` } });

let mails: { to: string[]; subject: string; text: string }[] = [];
beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  await db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  await db.exec(readFileSync(new URL("../migrations/003_account_protection.sql", import.meta.url), "utf8"));
  await db.exec(readFileSync(new URL("../migrations/004_open_source_integrations.sql", import.meta.url), "utf8"));
  app = createApp(() => async (text, params = []) => (await db.query(text, params as any[])).rows as any[]);
  vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
    mails.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 200 });
  });
});
afterEach(() => { mails = []; });

let n = 0;
async function newUser(password = "Correct-Horse-9") {
  const i = ++n;
  const email = `u${i}@example.com`;
  const r = await call("/api/v1/users/register", jsonReq("POST", { email, username: `user${i}`, password }));
  expect(r.status).toBe(201);
  return { email, password, id: (await r.json()).id as string };
}
async function login(email: string, password: string, otp?: string, ip = "198.51.100.1") {
  const body = new URLSearchParams({ username: email, password, ...(otp ? { otp } : {}) });
  return call("/api/v1/users/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip }, body });
}
const tokenOf = async (r: Response) => (await r.json()).access_token as string;
const tokenFromMail = (m: { text: string }, key: string) => m.text.match(new RegExp(`#${key}=([\\w-]+)`))![1];

describe("TOTP (RFC 6238)", () => {
  it("matches the RFC test vector and rejects wrong/old codes", async () => {
    const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));
    expect(await hotp(secret, Math.floor(59 / 30))).toBe("287082"); // RFC 6238 App. B, T=59 -> 94287082
    expect(await verifyTotp(secret, "287082", 59_000)).toBe(1);
    expect(await verifyTotp(secret, "000000", 59_000)).toBeNull();
    expect(await verifyTotp(secret, "287082", 59_000 + 120_000)).toBeNull(); // 4 steps later
  });
});

describe("durable login throttle", () => {
  it("still blocks after the in-process state is gone (state lives in Postgres)", async () => {
    const u = await newUser();
    for (let i = 0; i < 5; i++) expect((await login(u.email, "wrong-password", undefined, "198.51.100.77")).status).toBe(401);
    const row = await db.query("SELECT count(*)::int AS n FROM login_attempts");
    expect(row.rows[0].n).toBeGreaterThan(0);
    expect(JSON.stringify((await db.query("SELECT key FROM login_attempts")).rows)).not.toContain(u.email); // hashed
    vi.resetModules();
    const fresh = (await import("../src/app")).createApp(() => async (t, p = []) => (await db.query(t, p as any[])).rows as any[]);
    const r = await fresh.request("/api/v1/users/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.77" },
      body: new URLSearchParams({ username: u.email, password: u.password }),
    }, env);
    expect(r.status).toBe(429);
  });
});

describe("session revocation", () => {
  it("logout revokes the token server-side", async () => {
    const u = await newUser();
    const t = await tokenOf(await login(u.email, u.password));
    expect((await call("/api/v1/users/me", bearer(t))).status).toBe(200);
    expect((await call("/api/v1/users/logout", jsonReq("POST", undefined, t))).status).toBe(200);
    expect((await call("/api/v1/users/me", bearer(t))).status).toBe(401);
  });
  it("logout-all kills every token; password change needs the current password and keeps only the new token", async () => {
    const u = await newUser();
    const a = await tokenOf(await login(u.email, u.password, undefined, "198.51.100.2"));
    const b = await tokenOf(await login(u.email, u.password, undefined, "198.51.100.3"));
    const noCur = await call("/api/v1/users/me", jsonReq("PUT", { password: "New-Password-77" }, a));
    expect(noCur.status).toBe(403);
    const wrongCur = await call("/api/v1/users/me", jsonReq("PUT", { password: "New-Password-77", current_password: "nope-nope-nope" }, a));
    expect(wrongCur.status).toBe(403);
    const ok = await call("/api/v1/users/me", jsonReq("PUT", { password: "New-Password-77", current_password: u.password }, a));
    expect(ok.status).toBe(200);
    const fresh = (await ok.json()).access_token as string;
    expect((await call("/api/v1/users/me", bearer(a))).status).toBe(401);
    expect((await call("/api/v1/users/me", bearer(b))).status).toBe(401);
    expect((await call("/api/v1/users/me", bearer(fresh))).status).toBe(200);
    expect((await call("/api/v1/users/logout-all", jsonReq("POST", undefined, fresh))).status).toBe(200);
    expect((await call("/api/v1/users/me", bearer(fresh))).status).toBe(401);
  });
});

describe("email verification", () => {
  it("sends a link on register, verifies once, rejects reuse and expiry", async () => {
    const u = await newUser();
    const m = mails.find((x) => x.to[0] === u.email)!;
    expect(m.subject).toMatch(/Verify/);
    const token = tokenFromMail(m, "verify");
    const stored = JSON.stringify((await db.query("SELECT token_hash FROM auth_tokens WHERE kind='verify_email'")).rows);
    expect(stored).not.toContain(token); // only a hash is stored
    expect((await call("/api/v1/users/verify-email", jsonReq("POST", { token }))).status).toBe(200);
    expect((await db.query("SELECT email_verified_at FROM users WHERE id=$1", [u.id])).rows[0].email_verified_at).toBeTruthy();
    expect((await call("/api/v1/users/verify-email", jsonReq("POST", { token }))).status).toBe(400);
    const t2 = await tokenOf(await login(u.email, u.password));
    await db.query("UPDATE users SET email_verified_at=NULL WHERE id=$1", [u.id]);
    mails = [];
    expect((await (await call("/api/v1/users/request-verification", jsonReq("POST", {}, t2))).json()).sent).toBe(true);
    const token2 = tokenFromMail(mails[0], "verify");
    await db.query("UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE kind='verify_email'");
    expect((await call("/api/v1/users/verify-email", jsonReq("POST", { token: token2 }))).status).toBe(400);
  });
});

describe("password reset", () => {
  it("is generic for unknown emails, single-use, revokes sessions, and the new password works", async () => {
    const u = await newUser();
    const old = await tokenOf(await login(u.email, u.password, undefined, "198.51.100.10"));
    const unknown = await call("/api/v1/users/forgot-password", jsonReq("POST", { email: "nobody@example.com" }));
    const known = await call("/api/v1/users/forgot-password", jsonReq("POST", { email: u.email }));
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual(await known.json()); // no account enumeration
    const resetMail = mails.filter((x) => /Reset/.test(x.subject));
    expect(resetMail.length).toBe(1);
    expect(resetMail[0].to[0]).toBe(u.email);
    const token = tokenFromMail(resetMail[0], "reset");
    expect((await call("/api/v1/users/reset-password", jsonReq("POST", { token, password: "short" }))).status).toBe(422);
    expect((await call("/api/v1/users/reset-password", jsonReq("POST", { token: "x".repeat(40), password: "Brand-New-Pass-1" }))).status).toBe(400);
    expect((await call("/api/v1/users/reset-password", jsonReq("POST", { token, password: "Brand-New-Pass-1" }))).status).toBe(200);
    expect((await call("/api/v1/users/reset-password", jsonReq("POST", { token, password: "Another-Pass-22" }))).status).toBe(400); // single use
    expect((await call("/api/v1/users/me", bearer(old))).status).toBe(401); // old sessions revoked
    expect((await login(u.email, u.password, undefined, "198.51.100.11")).status).toBe(401);
    expect((await login(u.email, "Brand-New-Pass-1", undefined, "198.51.100.12")).status).toBe(200);
  });
  it("does not send reset mail for guests or Google-only (no password) accounts", async () => {
    const g = await (await call("/api/v1/users/guest", { method: "POST" })).json();
    expect(g.access_token).toBeTruthy();
    await db.query("INSERT INTO users (id,email,username,hashed_password) VALUES ('g1','google@example.com','googleuser','*')");
    mails = [];
    await call("/api/v1/users/forgot-password", jsonReq("POST", { email: "google@example.com" }));
    expect(mails.length).toBe(0);
  });
});

describe("MFA (TOTP + recovery codes)", () => {
  it("full lifecycle: setup, enable, login challenge, replay protection, recovery code single use, disable", async () => {
    const u = await newUser();
    const t = await tokenOf(await login(u.email, u.password, undefined, "198.51.100.20"));
    expect((await call("/api/v1/users/me/mfa/setup", jsonReq("POST", { password: "wrong-wrong" }, t))).status).toBe(403);
    const setup = await (await call("/api/v1/users/me/mfa/setup", jsonReq("POST", { password: u.password }, t))).json();
    expect(setup.otpauth_uri).toContain("otpauth://totp/");
    const enc = (await db.query("SELECT mfa_secret_enc FROM users WHERE id=$1", [u.id])).rows[0].mfa_secret_enc as string;
    expect(enc.startsWith("v1.")).toBe(true);
    expect(enc).not.toContain(setup.secret); // secret encrypted at rest
    expect((await call("/api/v1/users/me/mfa/enable", jsonReq("POST", { code: "000000" }, t))).status).toBe(403);
    const code1 = await hotp(setup.secret, totpStep());
    const en = await call("/api/v1/users/me/mfa/enable", jsonReq("POST", { code: code1 }, t));
    expect(en.status).toBe(200);
    const recovery = (await en.json()).recovery_codes as string[];
    expect(recovery.length).toBe(10);
    expect(JSON.stringify((await db.query("SELECT code_hash FROM mfa_recovery_codes")).rows)).not.toContain(recovery[0].replace("-", ""));
    expect((await call("/api/v1/users/me", bearer(t))).status).toBe(401); // enabling signs other sessions out

    // password alone is no longer enough, and the challenge is only revealed after the password is right
    const wrongPw = await login(u.email, "bad-bad-bad", undefined, "198.51.100.21");
    expect(wrongPw.status).toBe(401);
    const need = await login(u.email, u.password, undefined, "198.51.100.22");
    expect(need.status).toBe(403);
    expect((await need.json()).detail).toBe("mfa_required");
    expect((await login(u.email, u.password, "123456", "198.51.100.23")).status).toBe(401);
    // the code already consumed by /enable cannot be replayed at login
    expect((await login(u.email, u.password, code1, "198.51.100.24")).status).toBe(401);
    // a recovery code works exactly once
    const rc = recovery[0];
    const okLogin = await login(u.email, u.password, rc, "198.51.100.25");
    expect(okLogin.status).toBe(200);
    expect((await login(u.email, u.password, rc, "198.51.100.26")).status).toBe(401);
    const t2 = await tokenOf(okLogin);
    // disable needs password AND a valid second factor
    expect((await call("/api/v1/users/me/mfa/disable", jsonReq("POST", { password: u.password, code: "999999" }, t2))).status).toBe(403);
    const dis = await call("/api/v1/users/me/mfa/disable", jsonReq("POST", { password: u.password, code: recovery[1] }, t2));
    expect(dis.status).toBe(200);
    expect((await login(u.email, u.password, undefined, "198.51.100.27")).status).toBe(200);
  });
});

describe("audit log, export and deletion", () => {
  it("records security events without secrets and exposes only the caller's own", async () => {
    const a = await newUser();
    const b = await newUser();
    const ta = await tokenOf(await login(a.email, a.password, undefined, "198.51.100.30"));
    await login(a.email, "wrong-wrong-1", undefined, "198.51.100.31");
    const mine = await (await call("/api/v1/users/me/audit", bearer(ta))).json();
    const actions = mine.map((r: any) => r.action);
    expect(actions).toContain("register");
    expect(actions).toContain("login_success");
    expect(JSON.stringify(mine)).not.toMatch(/Correct-Horse|wrong-wrong|\$2[aby]\$/);
    expect(mine.every((r: any) => r.action)).toBe(true);
    const all = (await db.query("SELECT DISTINCT user_id FROM audit_log WHERE action='register'")).rows.map((r: any) => r.user_id);
    expect(all).toContain(b.id);
    expect(JSON.stringify(mine)).not.toContain(b.id);
  });

  it("export contains only the caller's data; delete needs confirmation + password and removes everything", async () => {
    const a = await newUser();
    const b = await newUser();
    const ta = await tokenOf(await login(a.email, a.password, undefined, "198.51.100.40"));
    const tb = await tokenOf(await login(b.email, b.password, undefined, "198.51.100.41"));
    await db.query("INSERT INTO health_records (id,user_id,title) VALUES ('hr-a',$1,'A-private'),('hr-b',$2,'B-private')", [a.id, b.id]);
    await db.query("INSERT INTO reports (id,user_id,title) VALUES ('rp-a',$1,'A-report')", [a.id]);
    const ex = await call("/api/v1/users/me/export", bearer(ta));
    expect(ex.headers.get("content-disposition")).toContain("attachment");
    const dump = JSON.stringify(await ex.json());
    expect(dump).toContain("A-private");
    expect(dump).toContain("A-report");
    expect(dump).not.toContain("B-private");
    expect(dump).not.toMatch(/hashed_password|\$2[aby]\$|mfa_secret/);

    expect((await call("/api/v1/users/me", jsonReq("DELETE", { password: a.password }, ta))).status).toBe(400);
    expect((await call("/api/v1/users/me", jsonReq("DELETE", { confirm: "DELETE", password: "wrong-wrong-1" }, ta))).status).toBe(403);
    expect((await call("/api/v1/users/me", jsonReq("DELETE", { confirm: "DELETE", password: a.password }, ta))).status).toBe(200);
    expect((await db.query("SELECT count(*)::int n FROM users WHERE id=$1", [a.id])).rows[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::int n FROM health_records WHERE user_id=$1", [a.id])).rows[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::int n FROM health_records WHERE user_id=$1", [b.id])).rows[0].n).toBe(1); // other user untouched
    expect((await call("/api/v1/users/me", bearer(ta))).status).toBe(401);
    expect((await call("/api/v1/users/me", bearer(tb))).status).toBe(200);
    expect((await db.query("SELECT 1 FROM audit_log WHERE user_id=$1 AND action='account_deleted'", [a.id])).rows.length).toBe(1);
  });
});

describe("WebSocket ticket issuance", () => {
  // Consumption happens in the WebSocket handler (needs the Workers runtime); only issuance is unit-tested here.
  it("is authenticated and stored hashed", async () => {
    const u = await newUser();
    const t = await tokenOf(await login(u.email, u.password, undefined, "198.51.100.50"));
    const r = await call("/api/v1/users/ws-ticket", jsonReq("POST", {}, t));
    expect(r.status).toBe(200);
    const { ticket } = await r.json();
    expect(ticket.length).toBeGreaterThan(20);
    const stored = JSON.stringify((await db.query("SELECT token_hash FROM auth_tokens WHERE kind='ws_ticket'")).rows);
    expect(stored).not.toContain(ticket);
    expect((await call("/api/v1/users/ws-ticket", jsonReq("POST", {}))).status).toBe(401);
  });
});
