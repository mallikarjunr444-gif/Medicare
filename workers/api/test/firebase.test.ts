import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { setKeyFetcherForTests } from "../src/firebaseAuth";

const PROJECT = "medicus-test";
const env: Env = {
  DATABASE_URL: "unused",
  JWT_SECRET_KEY: "test-secret-test-secret-test-secret-123456",
  FIREBASE_PROJECT_ID: PROJECT,
  ENVIRONMENT: "test",
  CORS_ORIGINS: "https://app.example.web.app",
  AUTH_COOKIE_NAME: "access_token",
  AUTH_COOKIE_SECURE: "false",
  AUTH_COOKIE_SAMESITE: "lax",
  JWT_EXPIRATION_HOURS: "24",
  GUEST_ACCOUNTS_ENABLED: "true",
};

const enc = new TextEncoder();
const b64u = (b: Uint8Array | string) =>
  btoa(typeof b === "string" ? b : String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let db: PGlite;
let app: ReturnType<typeof createApp>;
let signKey: CryptoKey;
let otherKey: CryptoKey; // a key Google never published

const call = (path: string, init: RequestInit = {}, e: Env = env) => app.request(path, init, e);
const bearer = (t: string | null, body?: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

/** Mints a Firebase-shaped ID token. Override any claim, the signing key or the kid to build bad tokens. */
async function mint(uid: string, claims: Record<string, unknown> = {}, key: CryptoKey = signKey, kid = "kid-1") {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, auth_time: now - 5, iat: now - 5, exp: now + 3600,
    sub: uid, email: `${uid}@gmail.com`, email_verified: true, name: `User ${uid}`, picture: `https://lh3.googleusercontent.com/${uid}`,
    ...claims,
  };
  const head = b64u(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64u(sig)}`;
}

const signin = (t: string) => call("/api/v1/auth/firebase", bearer(t));

beforeAll(async () => {
  const gen = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
  const good = await gen();
  signKey = good.privateKey;
  otherKey = (await gen()).privateKey;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", good.publicKey)), kid: "kid-1" };
  setKeyFetcherForTests(async () => ({ keys: [jwk], maxAgeS: 3600 }));

  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  await db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  app = createApp(() => async (text, params = []) => (await db.query(text, params as any[])).rows as any[]);
});

describe("token verification", () => {
  it("rejects missing, garbage, expired, wrong-project, wrong-issuer and forged tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await call("/api/v1/auth/firebase", { method: "POST" })).status).toBe(401);
    expect((await signin("not.a.jwt")).status).toBe(401);
    expect((await signin(await mint("u1", { exp: now - 600 }))).status).toBe(401);
    expect((await signin(await mint("u1", { aud: "someone-elses-project" }))).status).toBe(401);
    expect((await signin(await mint("u1", { iss: "https://securetoken.google.com/other" }))).status).toBe(401);
    expect((await signin(await mint("u1", { iat: now + 3600 }))).status).toBe(401);
    expect((await signin(await mint("u1", { sub: "" }))).status).toBe(401);
    // signed by a key Google never published
    expect((await signin(await mint("u1", {}, otherKey))).status).toBe(401);
    // unknown key id
    expect((await signin(await mint("u1", {}, signKey, "kid-unknown"))).status).toBe(401);
    expect((await db.query("SELECT 1 FROM users WHERE firebase_uid = 'u1'")).rows).toHaveLength(0);
  });

  it("does not accept our own HS256 token, or alg:none, as a Firebase identity", async () => {
    const guest = (await (await call("/api/v1/users/guest", bearer(null))).json()).access_token as string;
    expect((await signin(guest)).status).toBe(401);
    const none = `${b64u(JSON.stringify({ alg: "none" }))}.${b64u(JSON.stringify({ sub: "x" }))}.`;
    expect((await signin(none)).status).toBe(401);
    expect((await call("/api/v1/profile", bearer(none, undefined, "GET"))).status).toBe(401);
  });

  it("is disabled (503) until FIREBASE_PROJECT_ID is set, and never authenticates then", async () => {
    const t = await mint("u-off");
    const off = { ...env, FIREBASE_PROJECT_ID: undefined };
    expect((await call("/api/v1/auth/firebase", bearer(t), off)).status).toBe(503);
    expect((await call("/api/v1/profile", bearer(t, undefined, "GET"), off)).status).toBe(401);
  });

  it("requires a verified email", async () => {
    expect((await signin(await mint("u-unv", { email_verified: false }))).status).toBe(403);
    expect((await signin(await mint("u-noemail", { email: undefined }))).status).toBe(403);
  });
});

describe("sign-in creates and updates the profile", () => {
  it("first sign-in creates it (201), later sign-ins return the same profile (200)", async () => {
    const t = await mint("alice");
    const first = await signin(t);
    expect(first.status).toBe(201);
    const a = await first.json();
    expect(a.created).toBe(true);
    expect(a.profile).toMatchObject({ firebase_uid: "alice", email: "alice@gmail.com", full_name: "User alice", photo_url: "https://lh3.googleusercontent.com/alice", is_guest: false });
    expect(a.profile.created_at).toBeTruthy();
    expect(JSON.stringify(a)).not.toMatch(/hashed_password|is_superuser/);

    const second = await signin(await mint("alice"));
    expect(second.status).toBe(200);
    const b = await second.json();
    expect(b.created).toBe(false);
    expect(b.profile.id).toBe(a.profile.id);
    expect((await db.query("SELECT 1 FROM users WHERE firebase_uid = 'alice'")).rows).toHaveLength(1);
  });

  it("uses the UID from the verified token, ignoring anything in the request body", async () => {
    const r = await call("/api/v1/auth/firebase", bearer(await mint("mallory"), { uid: "alice", firebase_uid: "alice", email: "alice@gmail.com", id: "x" }));
    const b = await r.json();
    expect(b.profile.firebase_uid).toBe("mallory");
    expect(b.profile.email).toBe("mallory@gmail.com");
  });

  it("refreshes Google-owned fields but keeps edits the user made", async () => {
    const t = await mint("bob");
    await signin(t);
    const put = await call("/api/v1/profile", bearer(t, { full_name: "Robert B", phone: "+91 98765 43210", date_of_birth: "1999-04-12", gender: "male" }, "PUT"));
    expect(put.status).toBe(200);
    const again = await (await signin(await mint("bob", { name: "Google Changed", picture: "https://lh3.googleusercontent.com/new" }))).json();
    expect(again.profile).toMatchObject({ full_name: "Robert B", phone: "+91 98765 43210", date_of_birth: "1999-04-12", gender: "male", photo_url: "https://lh3.googleusercontent.com/new" });
  });

  it("links an existing password account with the same verified email and revokes its password", async () => {
    const reg = await call("/api/v1/users/register", bearer(null, { email: "carol@gmail.com", username: "carol", password: "Squatter-pass-1" }));
    expect(reg.status).toBe(201);
    const oldId = (await reg.json()).id;
    const r = await (await signin(await mint("carol"))).json();
    expect(r.created).toBe(false);
    expect(r.profile.id).toBe(oldId);
    const form = new URLSearchParams({ username: "carol@gmail.com", password: "Squatter-pass-1" });
    const login = await call("/api/v1/users/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
    expect(login.status).toBe(401);
  });
});

describe("profile API", () => {
  let t: string;
  beforeAll(async () => {
    t = await mint("dana");
    await signin(t);
  });
  it("requires authentication", async () => {
    expect((await call("/api/v1/profile")).status).toBe(401);
    expect((await call("/api/v1/profile", bearer(null, { full_name: "x" }, "PUT"))).status).toBe(401);
    expect((await call("/api/v1/profile/consultations")).status).toBe(401);
  });
  it("reads and updates, clears optional fields, and validates input", async () => {
    expect((await (await call("/api/v1/profile", bearer(t, undefined, "GET"))).json()).email).toBe("dana@gmail.com");
    const ok = await call("/api/v1/profile", bearer(t, { full_name: "  Dana D  ", phone: "9876543210", date_of_birth: "2000-01-31", gender: "female" }, "PUT"));
    expect((await ok.json())).toMatchObject({ full_name: "Dana D", phone: "9876543210", date_of_birth: "2000-01-31", gender: "female" });
    const cleared = await (await call("/api/v1/profile", bearer(t, { phone: null, gender: "" }, "PUT"))).json();
    expect(cleared.phone).toBeNull();
    expect(cleared.gender).toBeNull();
    for (const bad of [{ full_name: "" }, { full_name: "x".repeat(201) }, { phone: "abc" }, { date_of_birth: "31-01-2000" }, { date_of_birth: "2000-02-30" }, { date_of_birth: "2999-01-01" }, { date_of_birth: "1800-01-01" }, { gender: "robot" }]) {
      expect((await call("/api/v1/profile", bearer(t, bad, "PUT"))).status).toBe(422);
    }
  });
  it("cannot change identity or privilege fields", async () => {
    await call("/api/v1/profile", bearer(t, { email: "evil@x.com", firebase_uid: "other", is_superuser: true, id: "x" }, "PUT"));
    const row = (await db.query("SELECT email, firebase_uid, is_superuser FROM users WHERE firebase_uid = 'dana'")).rows[0] as any;
    expect(row).toMatchObject({ email: "dana@gmail.com", firebase_uid: "dana", is_superuser: false });
  });
  it("Firebase users can use the existing session API and get a working consultation history", async () => {
    const doc = await (await call("/api/v1/doctors/dr_arjun/avatar", bearer(t))).json();
    const s = await call("/api/v1/sessions/create", bearer(t, { avatar_id: doc.id }));
    expect(s.status).toBe(201);
    const sid = (await s.json()).id as string;
    await call("/api/v1/messages/send", bearer(t, { session_id: sid, content: "I have a headache" }));
    const list = await (await call("/api/v1/profile/consultations", bearer(t, undefined, "GET"))).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: sid, doctor_name: "Dr. Smit", doctor_id: "dr_arjun", status: "active", has_report: false });
    expect(list[0].message_count).toBeGreaterThanOrEqual(1);
  });
});

describe("one user can never reach another user's data", () => {
  let a: string, b: string, aSession: string, aRecord: string, aReport: string, aReportSession: string;
  beforeAll(async () => {
    a = await mint("user-a");
    b = await mint("user-b");
    await signin(a);
    await signin(b);
    const doc = await (await call("/api/v1/doctors/dr_ananya/avatar", bearer(a))).json();
    aSession = (await (await call("/api/v1/sessions/create", bearer(a, { avatar_id: doc.id }))).json()).id;
    await call("/api/v1/messages/send", bearer(a, { session_id: aSession, content: "private chat" }));
    await call(`/api/v1/consultation-reports/${aSession}`, bearer(a, { report: { note: "secret" }, triage_level: 2 }, "PUT"));
    aRecord = (await (await call("/api/v1/health-records", bearer(a, { title: "Penicillin allergy", record_type: "allergy", data: { severity: "high" } }))).json()).id;
    const rep = await (await call("/api/v1/reports", bearer(a, { title: "CBC", report_type: "lab", content: "Hb 13.5", session_id: aSession }))).json();
    aReport = rep.id;
    aReportSession = rep.session_id;
  });

  it("saves and returns the owner's own data", async () => {
    expect(aReportSession).toBe(aSession);
    const recs = await (await call("/api/v1/health-records", bearer(a, undefined, "GET"))).json();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ title: "Penicillin allergy", record_type: "allergy", data: { severity: "high" } });
    expect((await (await call("/api/v1/profile/consultations", bearer(a, undefined, "GET"))).json())[0]).toMatchObject({ id: aSession, has_report: true, triage_level: 2 });
    expect((await call(`/api/v1/messages/session/${aSession}`, bearer(a, undefined, "GET"))).status).toBe(200);
  });

  it("hides A's consultations, chats, reports, records and reports list from B", async () => {
    expect(await (await call("/api/v1/profile/consultations", bearer(b, undefined, "GET"))).json()).toEqual([]);
    expect(await (await call("/api/v1/health-records", bearer(b, undefined, "GET"))).json()).toEqual([]);
    expect(await (await call("/api/v1/reports", bearer(b, undefined, "GET"))).json()).toEqual([]);
    expect(await (await call("/api/v1/conversations", bearer(b, undefined, "GET"))).json()).toEqual([]);
    expect([401, 403, 404]).toContain((await call(`/api/v1/messages/session/${aSession}`, bearer(b, undefined, "GET"))).status);
    expect([401, 403, 404]).toContain((await call(`/api/v1/sessions/${aSession}`, bearer(b, undefined, "GET"))).status);
    expect((await call(`/api/v1/consultation-reports/${aSession}`, bearer(b, undefined, "GET"))).status).toBe(404);
  });

  it("answers 404 when B reads, edits or deletes A's record or report by id", async () => {
    for (const [base, id] of [["health-records", aRecord], ["reports", aReport]] as const) {
      expect((await call(`/api/v1/${base}/${id}`, bearer(b, undefined, "GET"))).status).toBe(404);
      expect((await call(`/api/v1/${base}/${id}`, bearer(b, { title: "hijacked" }, "PUT"))).status).toBe(404);
      expect((await call(`/api/v1/${base}/${id}`, bearer(b, undefined, "DELETE"))).status).toBe(404);
    }
    const intact = (await db.query("SELECT title FROM health_records WHERE id = $1", [aRecord])).rows[0] as any;
    expect(intact.title).toBe("Penicillin allergy");
    expect((await db.query("SELECT 1 FROM reports WHERE id = $1", [aReport])).rows).toHaveLength(1);
  });

  it("stamps new rows with the verified user, not a user_id sent in the body", async () => {
    const r = await call("/api/v1/health-records", bearer(b, { title: "B's note", user_id: "whatever", id: "fixed-id" }));
    expect(r.status).toBe(201);
    const id = (await r.json()).id as string;
    expect(id).not.toBe("fixed-id");
    const owner = (await db.query("SELECT u.firebase_uid FROM health_records h JOIN users u ON u.id = h.user_id WHERE h.id = $1", [id])).rows[0] as any;
    expect(owner.firebase_uid).toBe("user-b");
  });

  it("will not attach B's report to A's consultation", async () => {
    expect((await call("/api/v1/reports", bearer(b, { title: "x", session_id: aSession }))).status).toBe(404);
    expect((await call(`/api/v1/reports/${aReport}`, bearer(a, { session_id: "does-not-exist" }, "PUT"))).status).toBe(404);
  });

  it("lets the owner update and delete, and validates input", async () => {
    const up = await call(`/api/v1/health-records/${aRecord}`, bearer(a, { title: "Penicillin allergy (severe)" }, "PUT"));
    expect((await up.json()).title).toBe("Penicillin allergy (severe)");
    expect((await call("/api/v1/health-records", bearer(a, { title: "" }))).status).toBe(422);
    expect((await call("/api/v1/health-records", bearer(a, { title: "x", record_type: "bogus" }))).status).toBe(422);
    expect((await call("/api/v1/health-records", bearer(a, { title: "x", data: [1] }))).status).toBe(422);
    expect((await call(`/api/v1/health-records/${aRecord}`, bearer(a, undefined, "DELETE"))).status).toBe(204);
    expect((await call(`/api/v1/health-records/${aRecord}`, bearer(a, undefined, "GET"))).status).toBe(404);
  });

  it("requires authentication on every new endpoint", async () => {
    for (const p of ["/api/v1/health-records", "/api/v1/reports", "/api/v1/profile", "/api/v1/profile/consultations", `/api/v1/health-records/${aRecord}`]) {
      expect((await call(p)).status).toBe(401);
    }
    expect((await call("/api/v1/health-records", bearer(null, { title: "x" }))).status).toBe(401);
  });
});
