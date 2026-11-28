import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";

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
};
const GOOD = "https://app.example.web.app";
let db: PGlite;
let app: ReturnType<typeof createApp>;
const call = (path: string, init: RequestInit = {}) => app.request(path, init, env);

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  await db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  await db.exec(readFileSync(new URL("../migrations/003_account_protection.sql", import.meta.url), "utf8"));
  await db.exec(readFileSync(new URL("../migrations/004_open_source_integrations.sql", import.meta.url), "utf8"));
  app = createApp(() => async (text, params = []) => (await db.query(text, params as any[])).rows as any[]);
});

describe("CSRF / Origin guard", () => {
  it("blocks a state-changing request from an unknown Origin", async () => {
    const r = await call("/api/v1/users/guest", { method: "POST", headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });
  it("blocks cross-site requests that carry no Origin", async () => {
    const r = await call("/api/v1/users/guest", { method: "POST", headers: { "sec-fetch-site": "cross-site" } });
    expect(r.status).toBe(403);
  });
  it("allows the configured frontend Origin and header-less API clients", async () => {
    expect((await call("/api/v1/users/guest", { method: "POST", headers: { origin: GOOD } })).status).toBe(201);
    expect((await call("/api/v1/users/guest", { method: "POST" })).status).toBe(201);
  });
  it("does not affect safe methods", async () => {
    expect((await call("/api/v1/doctors", { headers: { origin: "https://evil.example" } })).status).not.toBe(403);
  });
});

describe("security headers", () => {
  it("sets HSTS, a deny-all CSP, nosniff and no-store", async () => {
    const r = await call("/api/v1/doctors");
    expect(r.headers.get("strict-transport-security")).toContain("max-age=63072000");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("authentication enforcement", () => {
  it("rejects protected routes without credentials", async () => {
    for (const p of ["/api/v1/users/me", "/api/v1/profile", "/api/v1/reports", "/api/v1/health-records", "/api/v1/sessions", "/api/v1/admin/knowledge/books"]) {
      const r = await call(p);
      expect([401, 403, 404, 405]).toContain(r.status);
      expect(r.status).not.toBe(200);
    }
  });
  it("rejects a forged alg=none JWT and a tampered token", async () => {
    const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "x", exp: 9999999999 })}.`;
    expect((await call("/api/v1/users/me", { headers: { authorization: `Bearer ${none}` } })).status).toBe(401);
    expect((await call("/api/v1/users/me", { headers: { authorization: "Bearer medicare-direct-token" } })).status).toBe(401);
  });
});

describe("login brute-force throttle", () => {
  const form = (u: string, p: string): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.9" },
    body: new URLSearchParams({ username: u, password: p }),
  });
  it("locks out after 5 failures even when the 6th password is correct", async () => {
    await call("/api/v1/users/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "lock@example.com", username: "lockme", password: "Correct-Horse-9" }),
    });
    for (let i = 0; i < 5; i++) expect((await call("/api/v1/users/login", form("lock@example.com", "wrong-pass-1"))).status).toBe(401);
    const blocked = await call("/api/v1/users/login", form("lock@example.com", "Correct-Horse-9"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });
  it("does not lock a different account from the same IP", async () => {
    await call("/api/v1/users/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "other@example.com", username: "otheruser", password: "Correct-Horse-9" }),
    });
    expect((await call("/api/v1/users/login", form("other@example.com", "Correct-Horse-9"))).status).toBe(200);
  });
});

describe("injection resistance", () => {
  it("treats SQL metacharacters in login and register as data", async () => {
    const r = await call("/api/v1/users/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "' OR '1'='1' --", password: "x" }),
    });
    expect(r.status).toBe(401);
    const reg = await call("/api/v1/users/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.co'; DROP TABLE users;--", username: "x'y", password: "Correct-Horse-9" }),
    });
    expect(reg.status).toBe(422);
    expect((await db.query("SELECT count(*)::int AS n FROM users")).rows[0]).toBeTruthy();
  });
});
