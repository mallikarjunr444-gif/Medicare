import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { setAppCheckKeyFetcherForTests } from "../src/appcheck";
import { sha256Hex } from "../src/crypto";
import type { Env } from "../src/env";

const base: Env = {
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
const withCaptcha: Env = { ...base, CAPTCHA_SECRET: "captcha-secret-captcha-secret-123456" };
const withAppCheck: Env = { ...base, APPCHECK_ENFORCE: "true", APPCHECK_PROJECT_NUMBER: "123456789" };

let db: PGlite;
let app: ReturnType<typeof createApp>;
const call = (path: string, init: RequestInit = {}, env: Env = base) => app.request(path, init, env);
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
  const email = `int${i}@example.com`;
  const r = await call("/api/v1/users/register", jsonReq("POST", { email, username: `intuser${i}`, password }, undefined, { "cf-connecting-ip": `192.0.2.${i}` }));
  expect(r.status).toBe(201);
  const id = (await r.json()).id as string;
  const lr = await call("/api/v1/users/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": `203.0.113.${i}` },
    body: new URLSearchParams({ username: email, password }),
  });
  expect(lr.status).toBe(200);
  return { email, password, id, token: (await lr.json()).access_token as string };
}
const makeDoctor = async () => {
  const d = await newUser();
  await db.query("UPDATE users SET role='doctor' WHERE id=$1", [d.id]);
  return d;
};
const auditActions = async (userId: string) => (await db.query("SELECT action, detail FROM audit_log WHERE user_id=$1 ORDER BY id", [userId])).rows as { action: string; detail: any }[];

// Solve an ALTCHA challenge exactly as the browser widget does.
async function solve(ch: { challenge: string; salt: string; signature: string; maxnumber: number; algorithm: string }) {
  for (let i = 0; i <= ch.maxnumber; i++) {
    if ((await sha256Hex(`${ch.salt}${i}`)) === ch.challenge) {
      return btoa(JSON.stringify({ algorithm: ch.algorithm, challenge: ch.challenge, number: i, salt: ch.salt, signature: ch.signature }));
    }
  }
  throw new Error("unsolvable");
}
const freshChallenge = async () => (await (await call("/api/v1/users/captcha/challenge", {}, withCaptcha)).json()) as any;

describe("ALTCHA captcha", () => {
  it("is off (no challenge, no requirement) when CAPTCHA_SECRET is unset", async () => {
    expect((await call("/api/v1/users/captcha/challenge")).status).toBe(204); // 204 = feature off; the widget only renders on 200
    const u = await newUser(); // registered without any captcha field
    expect(u.id).toBeTruthy();
  });

  it("when on: refuses registration without a solution, accepts a valid one once, rejects replay", async () => {
    const reg = (captcha?: string, i = Math.random()) =>
      call("/api/v1/users/register", jsonReq("POST", { email: `cap${i}@example.com`, username: `cap${String(i).slice(2, 10)}`, password: "Correct-Horse-9", captcha }), withCaptcha);
    const none = await reg(undefined);
    expect(none.status).toBe(400);
    expect((await none.json()).detail).toBe("captcha_required");

    const solution = await solve(await freshChallenge());
    expect((await reg(solution)).status).toBe(201);
    expect((await reg(solution)).status).toBe(400); // same solution cannot be replayed
  }, 60_000);

  it("rejects a tampered signature, a wrong number and an expired challenge", async () => {
    const reg = (captcha: string) =>
      call("/api/v1/users/forgot-password", jsonReq("POST", { email: "x@example.com", captcha }), withCaptcha);
    const ch = await freshChallenge();
    const good = JSON.parse(atob(await solve(ch)));
    const enc = (o: unknown) => btoa(JSON.stringify(o));
    expect((await reg(enc({ ...good, signature: "0".repeat(64) }))).status).toBe(400);
    expect((await reg(enc({ ...good, number: (good.number + 1) % ch.maxnumber }))).status).toBe(400);
    expect((await reg("not-base64-json")).status).toBe(400);
    // Re-sign nothing: an expired salt can only come with a signature we never issued, so it fails the HMAC check too.
    const expiredSalt = ch.salt.replace(/expires=\d+/, "expires=1");
    expect((await reg(enc({ ...good, salt: expiredSalt }))).status).toBe(400);
    expect((await reg(enc(good))).status).toBe(200); // untouched solution still works once
  }, 60_000);

  it("never reveals the secret or the answer number in the challenge", async () => {
    const ch = await freshChallenge();
    expect(JSON.stringify(ch)).not.toContain("captcha-secret");
    expect(Object.keys(ch).sort()).toEqual(["algorithm", "challenge", "maxnumber", "salt", "signature"]);
  });
});

describe("Firebase App Check enforcement", () => {
  async function keys() {
    const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1" };
    return { kp, jwk };
  }
  const b64u = (b: ArrayBuffer | string) => {
    const s = typeof b === "string" ? btoa(b) : btoa(String.fromCharCode(...new Uint8Array(b)));
    return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  async function sign(kp: CryptoKeyPair, claims: Record<string, unknown>, kid = "k1") {
    const h = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
    const p = b64u(JSON.stringify(claims));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64u(sig)}`;
  }
  const good = (over: Record<string, unknown> = {}) => ({
    iss: "https://firebaseappcheck.googleapis.com/123456789",
    aud: ["projects/123456789", "projects/medicus-labs"],
    sub: "1:123456789:web:abc",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  });
  let userToken = "";
  beforeAll(async () => { userToken = (await newUser()).token; });
  const ping = (token?: string) =>
    call("/api/v1/users/me", { headers: { authorization: `Bearer ${userToken}`, ...(token ? { "x-firebase-appcheck": token } : {}) } }, withAppCheck);
  const blocked = async (r: Response) => r.status === 401 && (await r.json()).detail === "App attestation failed";

  it("is not enforced unless APPCHECK_ENFORCE=true", async () => {
    expect((await call("/api/v1/users/me", bearer(userToken))).status).toBe(200);
  });

  it("enforced: missing, forged, wrong-audience, wrong-issuer and expired tokens are all 401; a genuine one passes", async () => {
    const { kp, jwk } = await keys();
    setAppCheckKeyFetcherForTests(async () => [jwk]);
    expect(await blocked(await ping())).toBe(true);
    expect(await blocked(await ping("a.b.c"))).toBe(true);
    expect((await ping(await sign(kp, good()))).status).toBe(200);
    expect(await blocked(await ping(await sign(kp, good({ aud: ["projects/999"] }))))).toBe(true);
    expect(await blocked(await ping(await sign(kp, good({ iss: "https://evil.example/123456789" }))))).toBe(true);
    expect(await blocked(await ping(await sign(kp, good({ exp: Math.floor(Date.now() / 1000) - 3600 }))))).toBe(true);
    // Signed by a different key than the one Google publishes
    const other = await keys();
    expect(await blocked(await ping(await sign(other.kp, good())))).toBe(true);
    // Unknown key id
    expect(await blocked(await ping(await sign(kp, good(), "nope")))).toBe(true);
    setAppCheckKeyFetcherForTests(null);
  });

  it("CORS preflight is not blocked by App Check and allows the header", async () => {
    const r = await call("/api/v1/users/me", { method: "OPTIONS", headers: { origin: "https://app.example.web.app", "access-control-request-method": "GET", "access-control-request-headers": "x-firebase-appcheck" } }, withAppCheck);
    expect(r.status).toBeLessThan(300);
    expect(r.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-firebase-appcheck");
  });
});

describe("email one-time code sign-in", () => {
  const request = (email: string, ip = "198.51.100.50") => call("/api/v1/users/otp/request", jsonReq("POST", { email }, undefined, { "cf-connecting-ip": ip }));
  const verify = (email: string, code: string, ip = "198.51.100.50") => call("/api/v1/users/otp/verify", jsonReq("POST", { email, code }, undefined, { "cf-connecting-ip": ip }));
  const codeFrom = (m: { text: string }) => m.text.match(/code is (\d{6})/)![1];

  it("emails a 6-digit code, stores only a hash, signs in once, and the code cannot be reused", async () => {
    const u = await newUser();
    mails = [];
    expect((await request(u.email, "198.51.100.51")).status).toBe(200);
    expect(mails.length).toBe(1);
    const code = codeFrom(mails[0]);
    expect(await db.query("SELECT token_hash FROM auth_tokens WHERE kind='email_otp'").then((r) => JSON.stringify(r.rows))).not.toContain(code);
    const ok = await verify(u.email, code, "198.51.100.51");
    expect(ok.status).toBe(200);
    const token = (await ok.json()).access_token as string;
    expect((await call("/api/v1/users/me", bearer(token))).status).toBe(200);
    expect((await verify(u.email, code, "198.51.100.51")).status).toBe(401); // single use
    expect((await auditActions(u.id)).some((a) => a.action === "login_success" && a.detail.method === "email_otp")).toBe(true);
    expect(JSON.stringify(await auditActions(u.id))).not.toContain(code);
  });

  it("locks the code after 5 wrong guesses — even the correct code is then refused", async () => {
    const u = await newUser();
    mails = [];
    await request(u.email, "198.51.100.52");
    const code = codeFrom(mails[0]);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await verify(u.email, wrong, `198.51.100.${60 + i}`)).status).toBe(401);
    expect((await verify(u.email, code, "198.51.100.70")).status).toBe(401);
  });

  it("expires after 10 minutes", async () => {
    const u = await newUser();
    mails = [];
    await request(u.email, "198.51.100.53");
    const code = codeFrom(mails[0]);
    await db.query("UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE kind='email_otp' AND user_id=$1", [u.id]);
    expect((await verify(u.email, code, "198.51.100.53")).status).toBe(401);
  });

  it("a new request invalidates the previous code", async () => {
    const u = await newUser();
    mails = [];
    await request(u.email, "198.51.100.54");
    const first = codeFrom(mails[0]);
    await request(u.email, "198.51.100.54");
    const second = codeFrom(mails[1]);
    if (first !== second) expect((await verify(u.email, first, "198.51.100.54")).status).toBe(401);
    expect((await verify(u.email, second, "198.51.100.54")).status).toBe(200);
  });

  it("gives the same answer for unknown emails (no enumeration) and sends nothing", async () => {
    const r = await request("ghost@example.com", "198.51.100.55");
    const u = await newUser();
    mails = [];
    const known = await request(u.email, "198.51.100.56");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(await known.json());
    expect(mails.map((m) => m.to[0])).toEqual([u.email]); // only the real account got mail
    expect((await verify("ghost@example.com", "123456", "198.51.100.55")).status).toBe(401);
  });

  it("is refused for accounts with two-step verification enabled (a mailbox must not bypass MFA)", async () => {
    const u = await newUser();
    await db.query("UPDATE users SET mfa_enabled = true WHERE id=$1", [u.id]);
    mails = [];
    await request(u.email, "198.51.100.57");
    expect(mails.length).toBe(0);
    expect((await verify(u.email, "123456", "198.51.100.57")).status).toBe(401);
  });

  it("rejects malformed codes without touching the database state", async () => {
    const u = await newUser();
    for (const bad of ["", "12345", "1234567", "abcdef", " "]) expect((await verify(u.email, bad, "198.51.100.58")).status).toBe(401);
  });
});

describe("consent records", () => {
  it("records decisions append-only, reports the latest, and audits them", async () => {
    const u = await newUser();
    expect((await call("/api/v1/consents", jsonReq("POST", { purpose: "analytics", granted: true }, u.token))).status).toBe(201);
    expect((await call("/api/v1/consents", jsonReq("POST", { purpose: "analytics", granted: false }, u.token))).status).toBe(201);
    const list = await (await call("/api/v1/consents", bearer(u.token))).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ purpose: "analytics", granted: false });
    expect((await db.query("SELECT count(*)::int n FROM consents WHERE user_id=$1", [u.id])).rows[0].n).toBe(2); // history kept
    const acts = (await auditActions(u.id)).map((a) => a.action);
    expect(acts).toContain("consent_granted");
    expect(acts).toContain("consent_withdrawn");
  });
  it("validates input and requires sign-in", async () => {
    const u = await newUser();
    expect((await call("/api/v1/consents", jsonReq("POST", { purpose: "marketing", granted: true }, u.token))).status).toBe(422);
    expect((await call("/api/v1/consents", jsonReq("POST", { purpose: "terms", granted: "yes" }, u.token))).status).toBe(422);
    expect((await call("/api/v1/consents")).status).toBe(401);
  });
  it("one user cannot see another user's consents", async () => {
    const a = await newUser();
    const b = await newUser();
    await call("/api/v1/consents", jsonReq("POST", { purpose: "privacy", granted: true }, a.token));
    expect(await (await call("/api/v1/consents", bearer(b.token))).json()).toEqual([]);
  });
});

describe("roles (RBAC)", () => {
  it("new accounts are patients and no endpoint lets a user set their own role", async () => {
    const u = await newUser();
    expect((await db.query("SELECT role FROM users WHERE id=$1", [u.id])).rows[0].role).toBe("patient");
    await call("/api/v1/users/me", jsonReq("PUT", { role: "doctor", full_name: "Sneaky" }, u.token));
    await call("/api/v1/profile", jsonReq("PUT", { role: "doctor" }, u.token));
    const reg = await call("/api/v1/users/register", jsonReq("POST", { email: "sneak@example.com", username: "sneak1", password: "Correct-Horse-9", role: "doctor" }));
    expect(reg.status).toBe(201);
    expect((await db.query("SELECT role FROM users WHERE email='sneak@example.com'")).rows[0].role).toBe("patient");
    expect((await db.query("SELECT role FROM users WHERE id=$1", [u.id])).rows[0].role).toBe("patient");
  });
  it("only an administrator can change a role; non-admins get 403", async () => {
    const admin = await newUser();
    await db.query("UPDATE users SET is_superuser=true WHERE id=$1", [admin.id]);
    const target = await newUser();
    const plain = await newUser();
    expect((await call(`/api/v1/admin/users/${target.id}/role`, jsonReq("PUT", { role: "doctor" }, plain.token))).status).toBe(403);
    expect((await call(`/api/v1/admin/users/${target.id}/role`, jsonReq("PUT", { role: "root" }, admin.token))).status).toBe(422);
    expect((await call(`/api/v1/admin/users/${target.id}/role`, jsonReq("PUT", { role: "doctor" }, admin.token))).status).toBe(200);
    expect((await db.query("SELECT role FROM users WHERE id=$1", [target.id])).rows[0].role).toBe("doctor");
    expect((await auditActions(admin.id)).some((a) => a.action === "role_changed")).toBe(true);
  });
});

describe("doctor access to patient records", () => {
  async function setup() {
    const patient = await newUser();
    const doctor = await makeDoctor();
    const rec = await call("/api/v1/health-records", jsonReq("POST", { record_type: "condition", title: "Asthma", data: { note: "mild" } }, patient.token));
    expect(rec.status).toBe(201);
    return { patient, doctor };
  }
  const grant = (patientToken: string, email: string, body: Record<string, unknown> = {}) =>
    call("/api/v1/access-grants", jsonReq("POST", { doctor_email: email, scopes: ["health_records"], days: 7, ...body }, patientToken));
  const read = (doctorToken: string, pid: string, what = "health-records") => call(`/api/v1/doctor/patients/${pid}/${what}`, bearer(doctorToken));

  it("a patient (non-doctor) cannot use doctor endpoints", async () => {
    const { patient } = await setup();
    expect((await call("/api/v1/doctor/patients", bearer(patient.token))).status).toBe(403);
  });

  it("denies by default: a doctor with no grant gets 403 and the attempt is audited", async () => {
    const { patient, doctor } = await setup();
    expect((await read(doctor.token, patient.id)).status).toBe(403);
    expect((await auditActions(doctor.id)).some((a) => a.action === "doctor_access_denied")).toBe(true);
  });

  it("needs the patient's doctor_sharing consent before a grant can be made", async () => {
    const { patient, doctor } = await setup();
    expect((await grant(patient.token, doctor.email)).status).toBe(409);
  });

  it("grant + consent -> read works, scoped, and is audited for both doctor and patient (no record content in the log)", async () => {
    const { patient, doctor } = await setup();
    await call("/api/v1/consents", jsonReq("POST", { purpose: "doctor_sharing", granted: true }, patient.token));
    expect((await grant(patient.token, doctor.email)).status).toBe(201);
    const r = await read(doctor.token, patient.id);
    expect(r.status).toBe(200);
    expect((await r.json())[0].title).toBe("Asthma");
    expect((await read(doctor.token, patient.id, "reports")).status).toBe(403); // reports scope was not granted
    const patientLog = await auditActions(patient.id);
    expect(patientLog.some((a) => a.action === "record_accessed_by_doctor" && a.detail.doctor_id === doctor.id)).toBe(true);
    expect((await auditActions(doctor.id)).some((a) => a.action === "doctor_record_access")).toBe(true);
    expect(JSON.stringify(patientLog)).not.toContain("Asthma");
  });

  it("another doctor, or another patient's id, gets nothing", async () => {
    const { patient, doctor } = await setup();
    const other = await makeDoctor();
    const otherPatient = await newUser();
    await call("/api/v1/consents", jsonReq("POST", { purpose: "doctor_sharing", granted: true }, patient.token));
    await grant(patient.token, doctor.email);
    expect((await read(other.token, patient.id)).status).toBe(403);
    expect((await read(doctor.token, otherPatient.id)).status).toBe(403);
  });

  it("revoking a grant, expiry, and withdrawing consent each end access immediately", async () => {
    const { patient, doctor } = await setup();
    await call("/api/v1/consents", jsonReq("POST", { purpose: "doctor_sharing", granted: true }, patient.token));
    const g = await (await grant(patient.token, doctor.email)).json();
    expect((await read(doctor.token, patient.id)).status).toBe(200);
    expect((await call(`/api/v1/access-grants/${g.id}`, { method: "DELETE", headers: { authorization: `Bearer ${patient.token}` } })).status).toBe(204);
    expect((await read(doctor.token, patient.id)).status).toBe(403);

    const g2 = await (await grant(patient.token, doctor.email)).json();
    expect((await read(doctor.token, patient.id)).status).toBe(200);
    await db.query("UPDATE access_grants SET expires_at = now() - interval '1 second' WHERE id=$1", [g2.id]);
    expect((await read(doctor.token, patient.id)).status).toBe(403);

    await grant(patient.token, doctor.email);
    expect((await read(doctor.token, patient.id)).status).toBe(200);
    await call("/api/v1/consents", jsonReq("POST", { purpose: "doctor_sharing", granted: false }, patient.token));
    expect((await read(doctor.token, patient.id)).status).toBe(403);
    expect((await db.query("SELECT count(*)::int n FROM access_grants WHERE patient_id=$1 AND revoked_at IS NULL", [patient.id])).rows[0].n).toBe(0);
  });

  it("consent is re-checked on every read, independently of grant revocation", async () => {
    const { patient, doctor } = await setup();
    await call("/api/v1/consents", jsonReq("POST", { purpose: "doctor_sharing", granted: true }, patient.token));
    await grant(patient.token, doctor.email);
    expect((await read(doctor.token, patient.id)).status).toBe(200);
    // Withdraw consent behind the API's back (grant stays active): the read path itself must still refuse.
    await db.query("INSERT INTO consents (user_id, purpose, granted) VALUES ($1,'doctor_sharing',false)", [patient.id]);
    expect((await read(doctor.token, patient.id)).status).toBe(403);
  });

  it("a patient can only grant to real doctors, only revoke their own grants, and cannot grant to themselves", async () => {
    const { patient, doctor } = await setup();
    const stranger = await newUser();
    await call("/api/v1/consents", jsonReq("POST", { purpose: "doctor_sharing", granted: true }, patient.token));
    expect((await grant(patient.token, stranger.email)).status).toBe(404); // not a doctor
    expect((await grant(patient.token, "nobody@example.com")).status).toBe(404);
    expect((await grant(patient.token, doctor.email, { scopes: ["everything"] })).status).toBe(422);
    expect((await grant(patient.token, doctor.email, { days: 9999 })).status).toBe(422);
    const g = await (await grant(patient.token, doctor.email)).json();
    expect((await call(`/api/v1/access-grants/${g.id}`, { method: "DELETE", headers: { authorization: `Bearer ${stranger.token}` } })).status).toBe(404);
    expect((await read(doctor.token, patient.id)).status).toBe(200);
  });

  it("demoting a doctor to patient revokes all their grants", async () => {
    const { patient, doctor } = await setup();
    const admin = await newUser();
    await db.query("UPDATE users SET is_superuser=true WHERE id=$1", [admin.id]);
    await call("/api/v1/consents", jsonReq("POST", { purpose: "doctor_sharing", granted: true }, patient.token));
    await grant(patient.token, doctor.email);
    await call(`/api/v1/admin/users/${doctor.id}/role`, jsonReq("PUT", { role: "patient" }, admin.token));
    expect((await call("/api/v1/doctor/patients", bearer(doctor.token))).status).toBe(403);
    expect((await db.query("SELECT count(*)::int n FROM access_grants WHERE doctor_id=$1 AND revoked_at IS NULL", [doctor.id])).rows[0].n).toBe(0);
  });
});

describe("owner record-read audit", () => {
  it("listing and reading your own records is audited with ids/counts only", async () => {
    const u = await newUser();
    const created = await (await call("/api/v1/health-records", jsonReq("POST", { record_type: "allergy", title: "Penicillin allergy" }, u.token))).json();
    await call("/api/v1/health-records", bearer(u.token));
    await call(`/api/v1/health-records/${created.id}`, bearer(u.token));
    const acts = await auditActions(u.id);
    expect(acts.some((a) => a.action === "records_listed")).toBe(true);
    expect(acts.some((a) => a.action === "record_read" && a.detail.id === created.id)).toBe(true);
    expect(JSON.stringify(acts)).not.toContain("Penicillin");
  });
});

describe("FHIR R4 export", () => {
  it("returns only the caller's own data as a Bundle, uncoded, and audits the export", async () => {
    const u = await newUser();
    const other = await newUser();
    await call("/api/v1/health-records", jsonReq("POST", { record_type: "condition", title: "Hypertension" }, u.token));
    await call("/api/v1/health-records", jsonReq("POST", { record_type: "medication", title: "Amlodipine 5mg" }, u.token));
    await call("/api/v1/health-records", jsonReq("POST", { record_type: "condition", title: "OTHER-PERSON-SECRET" }, other.token));
    const r = await call("/api/v1/fhir/me", bearer(u.token));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/fhir+json");
    const b = await r.json();
    expect(b.resourceType).toBe("Bundle");
    const types = b.entry.map((e: any) => e.resource.resourceType).sort();
    expect(types).toEqual(["Condition", "MedicationStatement", "Patient"]);
    expect(JSON.stringify(b)).not.toContain("OTHER-PERSON-SECRET");
    expect(JSON.stringify(b)).not.toContain("hashed_password");
    expect(b.entry.find((e: any) => e.resource.resourceType === "Condition").resource.code).toEqual({ text: "Hypertension" }); // free text only, no invented codes
    expect((await auditActions(u.id)).some((a) => a.action === "fhir_export")).toBe(true);
    expect((await call("/api/v1/fhir/me")).status).toBe(401);
  });
});

describe("Sentry scrubbing", () => {
  it("strips request bodies, cookies, auth headers and user data before an event leaves the Worker", async () => {
    const { scrubEvent } = await import("../src/scrub");
    const out = scrubEvent({
      request: { data: "secret body", cookies: { a: "b" }, headers: { authorization: "Bearer x", "x-ok": "1" }, query_string: "token=abc", url: "https://x/y" },
      user: { email: "a@b.c", ip_address: "1.2.3.4" },
    } as any) as any;
    expect(out.request.data).toBeUndefined();
    expect(out.request.cookies).toBeUndefined();
    expect(out.request.query_string).toBeUndefined();
    expect(out.request.headers?.authorization).toBeUndefined();
    expect(out.user).toBeUndefined();
  });
});
