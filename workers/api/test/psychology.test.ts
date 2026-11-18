import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createAccessToken } from "../src/auth";
import type { Env } from "../src/env";
import { INSTRUMENTS, score, validateAnswers } from "../src/psychScoring";
import { PSYCH_SCHEMA } from "../src/psychSchema";

const env: Env = {
  DATABASE_URL: "unused", JWT_SECRET_KEY: "test-secret-test-secret-test-secret-123456", ENVIRONMENT: "test",
  CORS_ORIGINS: "https://app.example", AUTH_COOKIE_NAME: "access_token", AUTH_COOKIE_SECURE: "false",
  AUTH_COOKIE_SAMESITE: "lax", JWT_EXPIRATION_HOURS: "24", GUEST_ACCOUNTS_ENABLED: "true",
  PSYCHOLOGIST_EMAILS: "listed@clinic.test",
};

const all = (n: number, v: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), v]));
const withItem = (n: number, base: number, idx: number, v: number) => ({ ...all(n, base), [String(idx)]: v });

describe("schema", () => {
  it("the embedded statements match migrations/001_psychology.sql", () => {
    const strip = (x: string) => x.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").replace(/\s*;\s*/g, ";").trim();
    const file = strip(readFileSync(new URL("../migrations/001_psychology.sql", import.meta.url), "utf8"));
    expect(strip(PSYCH_SCHEMA.join(";") + ";")).toBe(file);
  });
});

describe("validated scoring", () => {
  it("GAD-7 severity bands", () => {
    const t = (total: number) => { const a: Record<string, number> = all(7, 0); let left = total; for (let i = 0; i < 7; i++) { const v = Math.min(3, left); a[String(i)] = v; left -= v; } return score("gad7", a); };
    expect([t(0), t(4)].map((r) => r.severity)).toEqual(["minimal", "minimal"]);
    expect([t(5), t(9)].map((r) => r.severity)).toEqual(["mild", "mild"]);
    expect([t(10), t(14)].map((r) => r.severity)).toEqual(["moderate", "moderate"]);
    expect([t(15), t(21)].map((r) => r.severity)).toEqual(["severe", "severe"]);
    expect(t(21).total).toBe(21);
  });
  it("PHQ-9 severity bands and the item-9 flag", () => {
    const t = (total: number, item9 = 0) => { const a: Record<string, number> = all(9, 0); a["8"] = item9; let left = total - item9; for (let i = 0; i < 8; i++) { const v = Math.min(3, left); a[String(i)] = v; left -= v; } return score("phq9", a); };
    expect([0, 4, 5, 9, 10, 14, 15, 19, 20, 27].map((n) => t(n, n === 27 ? 3 : 0).severity)).toEqual(
      ["minimal", "minimal", "mild", "mild", "moderate", "moderate", "moderately_severe", "moderately_severe", "severe", "severe"]);
    expect(t(0).flags.item9Positive).toBe(false);
    expect(t(1, 1).flags.item9Positive).toBe(true);
  });
  it("ASRS-v1.1 Part A shading: items 1-3 at Sometimes+, items 4-6 at Often+, four or more is a positive screen", () => {
    expect(score("asrs6", all(6, 2)).flags.shadedCount).toBe(3); // items 4-6 need Often
    expect(score("asrs6", all(6, 2)).screening).toBe("negative");
    expect(score("asrs6", { 0: 2, 1: 2, 2: 2, 3: 3, 4: 0, 5: 0 } as any).screening).toBe("positive");
    expect(score("asrs6", all(6, 3)).screening).toBe("positive");
    expect(score("asrs6", all(6, 1)).total).toBeNull(); // no summed severity score
  });
  it("rejects incomplete or out-of-range answers", () => {
    expect(validateAnswers("phq9", all(9, 0))).toBeNull();
    expect(validateAnswers("phq9", all(8, 0))).toMatch(/Item 9/);
    expect(validateAnswers("phq9", withItem(9, 0, 3, 4))).toMatch(/Item 4/);
    expect(validateAnswers("asrs6", withItem(6, 0, 0, 4))).toBeNull(); // ASRS is a 5-point scale
    expect(validateAnswers("gad7", { ...all(7, 0), extra: 1 })).toMatch(/unknown/);
    expect(validateAnswers("gad7", null)).toMatch(/object/);
  });
  it("contains no proprietary instruments", () => {
    expect(Object.keys(INSTRUMENTS).sort()).toEqual(["asrs6", "gad7", "phq9"]);
  });
});

describe("psychology workflow and permissions", () => {
  let db: PGlite;
  let app: ReturnType<typeof createApp>;
  const call = (path: string, init: RequestInit = {}) => app.request("/api/v1/psych" + path, init, env);
  const req = (tok: string | null, method = "GET", body?: unknown): RequestInit => ({
    method, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let psy: string, patient: string, outsider: string, guestPsy: string, listed: string, plain: string;

  async function user(id: string, email: string) {
    await db.query("INSERT INTO users (id,email,username,hashed_password,is_guest) VALUES ($1,$2,$3,'x',false)", [id, email, id]);
    return createAccessToken(env, id);
  }

  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } });
    await db.exec("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
    await db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    // No manual migration: the first API call must create the tables itself.
    app = createApp(() => async (text, params = []) => (await db.query(text, params as any[])).rows as any[]);
    psy = await user("psy1", "psy@clinic.test");
    patient = await user("pat1", "pat@x.test");
    outsider = await user("out1", "out@x.test");
    guestPsy = await user("gp1", "gp@x.test");
    listed = await user("lst1", "listed@clinic.test");
    plain = await user("pln1", "plain@x.test");
    // The first API call creates the psychology tables and the users.is_psychologist column by itself.
    expect((await call("/me", req(plain))).status).toBe(200);
    await db.query("UPDATE users SET is_psychologist = true WHERE id IN ('psy1','gp1')");
    await db.query("UPDATE users SET is_guest = true WHERE id = 'gp1'");
  });

  let cid = "", code = "", aid = "";
  const state = async (tok: string) => (await (await call(`/consultations/${cid}`, req(tok))).json()) as any;
  const consent = (kind: string, granted = true) => call(`/consultations/${cid}/consents`, req(patient, "PUT", { kind, granted }));

  it("only psychologists can create a consultation (flag or configured email; never a guest)", async () => {
    expect((await call("/consultations", req(patient, "POST"))).status).toBe(403);
    expect((await call("/consultations", req(guestPsy, "POST"))).status).toBe(403);
    expect((await call("/consultations", req(null, "POST"))).status).toBe(401);
    expect((await call("/consultations", req(listed, "POST"))).status).toBe(201);
    const r = await call("/consultations", req(psy, "POST"));
    expect(r.status).toBe(201);
    const b: any = await r.json();
    cid = b.id; code = b.join_code;
    expect(b.room).toMatch(/^medicare-psych-[a-z0-9]{24}$/);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });

  it("a patient joins with the code; no one else can use it", async () => {
    expect((await call("/consultations/join", req(patient, "POST", { code: "WRONGCODE" }))).status).toBe(404);
    expect((await call("/consultations/join", req(psy, "POST", { code }))).status).toBe(404); // not your own
    expect((await call("/consultations/join", req(patient, "POST", { code: code.toLowerCase().replace(/^(.{4})/, "$1-") }))).status).toBe(200);
    expect((await call("/consultations/join", req(patient, "POST", { code }))).status).toBe(200); // idempotent
    expect((await call("/consultations/join", req(outsider, "POST", { code }))).status).toBe(404); // already claimed
    expect((await call(`/consultations/${cid}`, req(outsider))).status).toBe(404);
  });

  it("patient intake computes age and validates; the psychologist cannot fill it in", async () => {
    const dob = new Date(); dob.setUTCFullYear(dob.getUTCFullYear() - 30); dob.setUTCDate(dob.getUTCDate() - 2);
    const ok = await call(`/consultations/${cid}/intake`, req(patient, "PUT", { full_name: "A B", date_of_birth: dob.toISOString().slice(0, 10), preferred_language: "kn" }));
    expect(((await ok.json()) as any).age).toBe(30);
    expect((await call(`/consultations/${cid}/intake`, req(patient, "PUT", { date_of_birth: "2999-01-01" }))).status).toBe(422);
    expect((await call(`/consultations/${cid}/intake`, req(patient, "PUT", { date_of_birth: "not a date" }))).status).toBe(422);
    expect((await call(`/consultations/${cid}/intake`, req(psy, "PUT", { full_name: "x" }))).status).toBe(403);
    expect((await state(psy)).intake.age).toBe(30);
  });

  it("assignment needs the patient's consent, is psychologist-only and cannot be duplicated", async () => {
    const assign = (tok: string, instrument: string) => call(`/consultations/${cid}/assignments`, req(tok, "POST", { instrument }));
    expect((await assign(psy, "phq9")).status).toBe(409); // no consent yet
    await consent("assessment");
    expect((await assign(psy, "phq9")).status).toBe(409); // still needs data-processing consent
    await consent("data_processing");
    expect((await assign(patient, "phq9")).status).toBe(403);
    expect((await assign(psy, "wais4")).status).toBe(422); // proprietary tests are not offered
    const r = await assign(psy, "phq9");
    expect(r.status).toBe(201);
    aid = ((await r.json()) as any).id;
    expect((await assign(psy, "phq9")).status).toBe(409);
    expect((await state(psy)).consents.recording).toBe(false); // recording stays off by default
  });

  it("the patient cannot answer until the psychologist starts; progress is saved", async () => {
    const draft = (answers: any) => call(`/assignments/${aid}/draft`, req(patient, "PUT", { answers }));
    expect((await draft({ 0: 1 })).status).toBe(409);
    expect((await call(`/assignments/${aid}/action`, req(patient, "POST", { action: "start" }))).status).toBe(403);
    expect((await call(`/assignments/${aid}/action`, req(psy, "POST", { action: "start" }))).status).toBe(200);
    expect(((await (await draft({ 0: 2, 1: 1, 99: 3, 2: 9 })).json()) as any).answered_count).toBe(2); // junk dropped
    const s = await state(patient);
    expect(s.assignments[0].draft).toEqual({ "0": 2, "1": 1 });
    expect((await state(psy)).assignments[0].answered_count).toBe(2);
    // pause / resume
    await call(`/assignments/${aid}/action`, req(psy, "POST", { action: "pause" }));
    expect((await draft({ 0: 1 })).status).toBe(409);
    await call(`/assignments/${aid}/action`, req(psy, "POST", { action: "resume" }));
  });

  it("submission is validated, scored on the server and immutable; item 9 raises a psychologist-only alert", async () => {
    const submit = (answers: any) => call(`/assignments/${aid}/submit`, req(patient, "POST", { answers }));
    expect((await submit(all(9, 0) && { 0: 1 })).status).toBe(422);
    expect((await call(`/assignments/${aid}/submit`, req(psy, "POST", { answers: all(9, 0) }))).status).toBe(403);
    const r = await submit(withItem(9, 1, 8, 2));
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body.status).toBe("completed");
    expect(body.support_message).toMatch(/psychologist/);
    expect(JSON.stringify(body)).not.toMatch(/score|total|severity/i);
    expect((await submit(all(9, 0))).status).toBe(409); // cannot be overwritten

    const p = await state(patient);
    expect(p.results).toBeUndefined();
    expect(p.alerts).toBeUndefined();
    expect(JSON.stringify(p)).not.toMatch(/severity|total_score|"total"/);
    const d = await state(psy);
    expect(d.results[0]).toMatchObject({ instrument: "phq9", total: 10, severity: "moderate", flags: { item9Positive: true } });
    expect(d.alerts).toHaveLength(1);
    expect(d.alerts[0].message).toMatch(/not a suicide-risk assessment/);
    expect((await call(`/alerts/${d.alerts[0].id}/ack`, req(patient, "POST"))).status).toBe(403);
    expect((await call(`/alerts/${d.alerts[0].id}/ack`, req(psy, "POST"))).status).toBe(200);
    expect((await state(psy)).alerts[0].acknowledged_at).toBeTruthy();
  });

  it("corrections need a reason, are rescored and are kept in an audit trail", async () => {
    const correct = (b: any) => call(`/assignments/${aid}/correct`, req(psy, "POST", b));
    expect((await correct({ answers: all(9, 0) })).status).toBe(422); // reason required
    expect((await call(`/assignments/${aid}/correct`, req(patient, "POST", { reason: "because", answers: all(9, 0) }))).status).toBe(403);
    expect((await correct({ reason: "Patient misread item 9", answers: all(9, 0) })).status).toBe(200);
    const d = await state(psy);
    expect(d.results[0]).toMatchObject({ total: 0, severity: "minimal", corrected: true });
    const log: any[] = (await (await call(`/consultations/${cid}/audit`, req(psy))).json()) as any;
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["consultation_created", "assessment_assigned", "assessment_submitted", "safety_alert_raised", "response_corrected", "consent_granted"]));
    expect(JSON.stringify(log)).not.toContain("misread"); // no clinical text in the audit trail
    expect((await call(`/consultations/${cid}/audit`, req(patient))).status).toBe(403);
    const corr = (await db.query("SELECT previous_total, new_total, reason FROM psych_response_corrections")).rows[0] as any;
    expect(corr).toMatchObject({ previous_total: 10, new_total: 0 });
  });

  it("ending a consultation closes open assessments", async () => {
    await call(`/consultations/${cid}/assignments`, req(psy, "POST", { instrument: "gad7" }));
    expect((await call(`/consultations/${cid}/status`, req(patient, "POST", { action: "end" }))).status).toBe(403);
    expect((await call(`/consultations/${cid}/status`, req(psy, "POST", { action: "end" }))).status).toBe(200);
    const s = await state(psy);
    expect(s.status).toBe("ended");
    expect(s.assignments.find((a: any) => a.instrument === "gad7").status).toBe("ended");
    expect((await call(`/consultations/${cid}/status`, req(psy, "POST", { action: "end" }))).status).toBe(409);
    expect((await consent("recording")).status).toBe(409);
  });

  it("lists only your own consultations and exposes the instruments to signed-in users", async () => {
    const mine: any[] = (await (await call("/consultations", req(psy))).json()) as any;
    expect(mine.every((m) => m.role === "psychologist")).toBe(true);
    expect((await (await call("/consultations", req(outsider))).json()) as any[]).toHaveLength(0);
    expect(((await (await call("/me", req(plain))).json()) as any).is_psychologist).toBe(false);
    const ins: any[] = (await (await call("/instruments", req(plain))).json()) as any;
    expect(ins.find((i) => i.id === "phq9").items).toHaveLength(9);
    expect((await call("/instruments")).status).toBe(401);
  });
});
