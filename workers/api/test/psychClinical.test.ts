import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createAccessToken } from "../src/auth";
import type { Env } from "../src/env";
import { summariseTask } from "../src/psychExtras";

const env: Env = {
  DATABASE_URL: "unused", JWT_SECRET_KEY: "test-secret-test-secret-test-secret-123456", ENVIRONMENT: "test",
  CORS_ORIGINS: "https://app.example", AUTH_COOKIE_NAME: "access_token", AUTH_COOKIE_SECURE: "false",
  AUTH_COOKIE_SAMESITE: "lax", JWT_EXPIRATION_HOURS: "24", GUEST_ACCOUNTS_ENABLED: "true",
};

describe("task summaries are computed from raw trials", () => {
  it("reaction time", () => {
    const trials = Array.from({ length: 10 }, (_, i) => ({ rt_ms: 300 + i * 10 }));
    expect(summariseTask("reaction", { trials })).toMatchObject({ valid_trials: 10, median_rt_ms: 345, anticipations: 0 });
    expect(summariseTask("reaction", { trials: trials.slice(0, 9) })).toBe("expected 10 trials");
    expect(summariseTask("reaction", { trials: trials.map(() => ({ rt_ms: -5 })) })).toBe("invalid reaction time");
    expect(summariseTask("reaction", { trials: trials.map(() => ({ rt_ms: 50 })) })).toBe("no valid trials");
  });
  it("Stroop correctness and n-back targets are decided server-side", () => {
    const mk = (n: number, f: (i: number) => any) => ({ trials: Array.from({ length: n }, (_, i) => f(i)) });
    const s: any = summariseTask("stroop", mk(24, (i) => i % 2 ? { word: "red", color: "red", key: "R", rt_ms: 500 } : { word: "red", color: "blue", key: "b", rt_ms: 650 }));
    expect(s).toMatchObject({ errors: 0, accuracy_pct: 100, congruent_median_ms: 500, incongruent_median_ms: 650, interference_ms: 150 });
    const wrong: any = summariseTask("stroop", mk(24, (i) => i % 2 ? { word: "red", color: "red", key: "r", rt_ms: 500 } : { word: "red", color: "blue", key: "r", rt_ms: 650 })); // answered the WORD
    expect(wrong).toBe("not enough correct trials");
    expect(summariseTask("stroop", mk(24, () => ({ word: "pink", color: "red", key: "r", rt_ms: 1 })))).toBe("invalid Stroop trial");
    const seq = "ABBCCDEEFG".repeat(3).split("");
    const n: any = summariseTask("nback", mk(30, (i) => ({ letter: seq[i], pressed: seq[i] === seq[i - 1] })));
    expect(n).toMatchObject({ misses: 0, false_alarms: 0, hit_rate_pct: 100 });
    const lazy: any = summariseTask("nback", mk(30, (i) => ({ letter: seq[i], pressed: false })));
    expect(lazy.hits).toBe(0); expect(lazy.misses).toBe(lazy.targets); // a client cannot relabel targets
    expect(summariseTask("nback", mk(30, () => ({ letter: "a", pressed: true })))).toBe("invalid n-back trial");
  });
  it("digit span decides correctness itself", () => {
    expect(summariseTask("digitspan", { trials: [{ digits: "123", response: "1 2 3" }, { digits: "4821", response: "4821" }, { digits: "73920", response: "73921" }] }))
      .toMatchObject({ correct_trials: 2, longest_span: 4 });
    expect(summariseTask("digitspan", { trials: [{ digits: "abc", response: "abc" }] })).toBe("invalid digit-span trial");
  });
});

describe("stages 7-15", () => {
  let db: PGlite; let app: ReturnType<typeof createApp>;
  const call = (path: string, init: RequestInit = {}) => app.request("/api/v1/psych" + path, init, env);
  const pub = (path: string, init: RequestInit = {}) => app.request("/api/v1/psych-observer" + path, init, env);
  const req = (tok: string | null, method = "GET", body?: unknown): RequestInit => ({
    method, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let psy = "", psy2 = "", pat = "", cid = "";
  const user = async (id: string, email: string) => { await db.query("INSERT INTO users (id,email,username,hashed_password,is_guest) VALUES ($1,$2,$3,'x',false)", [id, email, id]); return createAccessToken(env, id); };
  const json = async (r: Response) => (await r.json()) as any;
  const consent = (kind: string, granted = true) => call(`/consultations/${cid}/consents`, req(pat, "PUT", { kind, granted }));

  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } });
    await db.exec("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
    await db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    app = createApp(() => async (text, params = []) => (await db.query(text, params as any[])).rows as any[]);
    psy = await user("p1", "p1@c.test"); psy2 = await user("p2", "p2@c.test"); pat = await user("pt", "pt@x.test");
    await call("/me", req(pat));
    await db.query("UPDATE users SET is_psychologist = true WHERE id IN ('p1','p2')");
    const c = await json(await call("/consultations", req(psy, "POST")));
    cid = c.id;
    await call("/consultations/join", req(pat, "POST", { code: c.join_code }));
    await call(`/consultations/${cid}/intake`, req(pat, "PUT", { full_name: "Test Patient", date_of_birth: "1990-05-01" }));
  });

  it("observer links need consent, work once, expire, and reveal nothing about the patient", async () => {
    const invite = () => call(`/consultations/${cid}/observers`, req(psy, "POST", { label: "Partner", relationship: "spouse" }));
    expect((await invite()).status).toBe(409);
    await consent("observer_questionnaire");
    expect((await call(`/consultations/${cid}/observers`, req(pat, "POST", { label: "x" }))).status).toBe(403);
    const r = await invite(); expect(r.status).toBe(201);
    const { token, id: oid } = await json(r);
    expect(token).toHaveLength(32);
    expect((await db.query("SELECT token_hash FROM psych_observer_invites")).rows[0]).not.toHaveProperty("token");
    expect(JSON.stringify((await db.query("SELECT * FROM psych_observer_invites")).rows)).not.toContain(token); // only a hash is stored
    const form = await json(await pub(`/${token}`));
    expect(form.items).toHaveLength(8);
    expect(JSON.stringify(form)).not.toMatch(/Test Patient|1990/);
    expect((await pub("/short")).status).toBe(404);
    expect((await pub(`/${"a".repeat(32)}`)).status).toBe(404);
    expect((await pub(`/${token}`, req(null, "POST", { answers: { 0: 1 } }))).status).toBe(422);
    const full = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(i), 1]));
    expect((await pub(`/${token}`, req(null, "POST", { answers: { ...full, 3: 9 } }))).status).toBe(422);
    expect((await pub(`/${token}`, req(null, "POST", { answers: full, comment: "ok" }))).status).toBe(200);
    expect((await pub(`/${token}`, req(null, "POST", { answers: full }))).status).toBe(404); // single use
    expect((await pub(`/${token}`)).status).toBe(404);
    // expiry, revocation and withdrawn consent
    const t2 = (await json(await invite())).token;
    await db.query("UPDATE psych_observer_invites SET expires_at = now() - interval '1 minute' WHERE status='pending'");
    expect((await pub(`/${t2}`)).status).toBe(404);
    const t3 = await json(await invite());
    expect((await call(`/observers/${t3.id}/revoke`, req(psy2, "POST"))).status).toBe(404); // another psychologist
    expect((await call(`/observers/${t3.id}/revoke`, req(psy, "POST"))).status).toBe(200);
    expect((await pub(`/${t3.token}`)).status).toBe(404);
    const t4 = await json(await invite());
    await consent("observer_questionnaire", false);
    expect((await pub(`/${t4.token}`)).status).toBe(404);
    await consent("observer_questionnaire");
    expect(oid).toBeTruthy();
  });

  it("cognitive tasks: psychologist assigns, patient runs, server computes the summary", async () => {
    const assign = (t: string, tok = psy) => call(`/consultations/${cid}/tasks`, req(tok, "POST", { task: t }));
    expect((await assign("reaction")).status).toBe(409); // consent first
    await consent("assessment"); await consent("data_processing");
    expect((await assign("reaction", pat)).status).toBe(403);
    expect((await assign("iq-test")).status).toBe(422);
    const { id: tid } = await json(await assign("reaction"));
    const trials = Array.from({ length: 10 }, () => ({ rt_ms: 320 }));
    expect((await call(`/tasks/${tid}/submit`, req(pat, "POST", { trials }))).status).toBe(409); // not started
    expect((await call(`/tasks/${tid}/start`, req(pat, "POST"))).status).toBe(403);
    expect((await call(`/tasks/${tid}/start`, req(psy, "POST"))).status).toBe(200);
    expect((await call(`/tasks/${tid}/submit`, req(psy, "POST", { trials }))).status).toBe(403); // the clinician cannot fake it
    expect((await call(`/tasks/${tid}/submit`, req(pat, "POST", { trials: trials.slice(1) }))).status).toBe(422);
    expect((await call(`/tasks/${tid}/submit`, req(pat, "POST", { trials, summary: { median_rt_ms: 1 } }))).status).toBe(200);
    expect((await call(`/tasks/${tid}/submit`, req(pat, "POST", { trials }))).status).toBe(409);
    const mine = await json(await call(`/consultations/${cid}/tasks`, req(pat)));
    expect(mine[0].status).toBe("completed"); expect(mine[0]).not.toHaveProperty("result");
    const theirs = await json(await call(`/consultations/${cid}/tasks`, req(psy)));
    expect(theirs[0].result.summary.median_rt_ms).toBe(320);
  });

  it("licensed-instrument results are entered, attested and stored separately", async () => {
    const body = { instrument: "wais4", administered_on: "2026-11-01", administered_by: "Dr A", authorization_ref: "LIC-1", scores: [{ label: "FSIQ", value: "104" }], attest: true };
    expect((await call(`/consultations/${cid}/external`, req(pat, "POST", body))).status).toBe(403);
    expect((await call(`/consultations/${cid}/external`, req(psy2, "POST", body))).status).toBe(404);
    expect((await call(`/consultations/${cid}/external`, req(psy, "POST", { ...body, attest: false }))).status).toBe(422);
    expect((await call(`/consultations/${cid}/external`, req(psy, "POST", { ...body, administered_on: "2999-01-01" }))).status).toBe(422);
    expect((await call(`/consultations/${cid}/external`, req(psy, "POST", { ...body, instrument: "stanford-binet" }))).status).toBe(422);
    expect((await call(`/consultations/${cid}/external`, req(psy, "POST", { ...body, scores: [] }))).status).toBe(422);
    expect((await call(`/consultations/${cid}/external`, req(psy, "POST", body))).status).toBe(201);
    expect((await db.query("SELECT count(*)::int n FROM psych_responses")).rows[0]).toMatchObject({ n: 0 }); // not mixed with screening data
  });

  it("clinician-built questionnaires: patient sees questions only once started; answers are validated; never scored", async () => {
    const spec = { title: "Sleep diary", intro: "Last week", options: ["Never", "Sometimes", "Often"], items: ["I fall asleep easily", "I wake at night"] };
    expect((await call(`/consultations/${cid}/forms`, req(pat, "POST", spec))).status).toBe(403);
    expect((await call(`/consultations/${cid}/forms`, req(psy2, "POST", spec))).status).toBe(404);
    expect((await call(`/consultations/${cid}/forms`, req(psy, "POST", { ...spec, options: ["only one"] }))).status).toBe(422);
    expect((await call(`/consultations/${cid}/forms`, req(psy, "POST", { ...spec, items: [] }))).status).toBe(422);
    const { id: fid } = await json(await call(`/consultations/${cid}/forms`, req(psy, "POST", spec)));
    let mine = await json(await call(`/consultations/${cid}/forms`, req(pat)));
    expect(mine[0]).toMatchObject({ title: "Sleep diary", status: "assigned" }); expect(mine[0]).not.toHaveProperty("items");
    expect((await call(`/forms/${fid}/submit`, req(pat, "POST", { answers: { 0: 1, 1: 1 } }))).status).toBe(409);
    expect((await call(`/forms/${fid}/start`, req(pat, "POST"))).status).toBe(403);
    expect((await call(`/forms/${fid}/start`, req(psy, "POST"))).status).toBe(200);
    mine = await json(await call(`/consultations/${cid}/forms`, req(pat)));
    expect(mine[0].items).toHaveLength(2); expect(mine[0]).not.toHaveProperty("answers");
    expect((await call(`/forms/${fid}/submit`, req(psy, "POST", { answers: { 0: 1, 1: 1 } }))).status).toBe(403);
    expect((await call(`/forms/${fid}/submit`, req(pat, "POST", { answers: { 0: 1 } }))).status).toBe(422);
    expect((await call(`/forms/${fid}/submit`, req(pat, "POST", { answers: { 0: 1, 1: 3 } }))).status).toBe(422); // out of range
    expect((await call(`/forms/${fid}/submit`, req(pat, "POST", { answers: { 0: 2, 1: 1 } }))).status).toBe(200);
    expect((await call(`/forms/${fid}/submit`, req(pat, "POST", { answers: { 0: 0, 1: 0 } }))).status).toBe(409);
    const theirs = await json(await call(`/consultations/${cid}/forms`, req(psy)));
    expect(theirs[0].answers).toEqual({ "0": 2, "1": 1 });
    expect(JSON.stringify(theirs[0])).not.toMatch(/score|severity/i);
  });

  it("psychologist-only areas are closed to patients and to other psychologists", async () => {
    for (const path of ["/notes", "/interview", "/dashboard", "/history", "/report"]) {
      expect((await call(`/consultations/${cid}${path}`, req(pat))).status).toBe(403);
      expect((await call(`/consultations/${cid}${path}`, req(psy2))).status).toBe(404);
      expect((await call(`/consultations/${cid}${path}`, req(null))).status).toBe(401);
    }
    expect((await call(`/consultations/${cid}/notes`, req(pat, "POST", { kind: "observation", body: "x" }))).status).toBe(403);
    expect((await call(`/consultations/${cid}/report/generate`, req(pat, "POST"))).status).toBe(403);
  });

  it("notes, history and interview save; only the author edits a note", async () => {
    const add = (kind: string, body: string) => call(`/consultations/${cid}/notes`, req(psy, "POST", { kind, body }));
    expect((await add("diagnosis", "x")).status).toBe(422);
    expect((await add("observation", "")).status).toBe(422);
    const n = await json(await add("observation", "Calm, cooperative, good eye contact."));
    await add("reason_for_referral", "Difficulty concentrating at work."); await add("referral_source", "Self-referral"); await add("medication", "None reported");
    expect((await call(`/notes/${n.id}`, req(psy2, "PUT", { body: "hijack" }))).status).toBe(404);
    expect((await call(`/notes/${n.id}`, req(psy, "PUT", { body: "Calm, cooperative." }))).status).toBe(200);
    expect((await call(`/consultations/${cid}/interview`, req(psy, "PUT", { data: { presenting: { findings: "Inattention for 2 years", duration: "2 years" }, impressions: "Provisional: query attention difficulties" } }))).status).toBe(200);
    const iv = await json(await call(`/consultations/${cid}/interview`, req(psy)));
    expect(iv.data.presenting.duration).toBe("2 years");
    const h = await json(await call(`/consultations/${cid}/history`, req(psy)));
    expect(h.consultations).toHaveLength(1);
    expect(h.history.some((x: any) => x.kind === "reason_for_referral")).toBe(true);
    expect(h.history.some((x: any) => x.kind === "observation")).toBe(false);
  });

  it("dashboard lists what is missing and never invents results", async () => {
    await call(`/consultations/${cid}/assignments`, req(psy, "POST", { instrument: "phq9" }));
    const d = await json(await call(`/consultations/${cid}/dashboard`, req(psy)));
    expect(d.assessments[0]).toMatchObject({ name: "PHQ-9", status: "assigned", result: null });
    expect(d.missing).toContain("PHQ-9 not completed (assigned)");
    expect(d.external[0].name).toBe("WAIS-IV");
  });

  it("the report is built from recorded data only and needs real approval", async () => {
    const gen = () => call(`/consultations/${cid}/report/generate`, req(psy, "POST"));
    expect((await call(`/consultations/${cid}/report/approve`, req(psy, "POST", { name: "Dr A", credentials: "RCI 1", confirm: true }))).status).toBe(404); // no draft yet
    expect((await gen()).status).toBe(200);
    let r = await json(await call(`/consultations/${cid}/report`, req(psy)));
    expect(r.status).toBe("draft");
    expect(r.sections.identification).toContain("Test Patient");
    expect(r.sections.results).toContain("WAIS-IV");
    expect(r.sections.results).not.toMatch(/PHQ-9 \(v/); // assigned but not completed: absent from results...
    expect(r.missing).toContain("PHQ-9 was assigned but not completed"); // ...and flagged instead
    expect(r.sections.diagnostic_impressions).toBe("Provisional: query attention difficulties"); // clinician text, verbatim
    expect(r.sections.behavioural_observations).toContain("Calm, cooperative.");
    expect(r.sections.recommendations).toBe("[Not provided]");

    // complete PHQ-9 with item 9 endorsed -> safety alert blocks approval until acknowledged
    const a = (await json(await call(`/consultations/${cid}`, req(psy)))).assignments.find((x: any) => x.instrument === "phq9").id;
    await call(`/assignments/${a}/action`, req(psy, "POST", { action: "start" }));
    const ans = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i), i === 8 ? 1 : 0]));
    expect((await call(`/assignments/${a}/submit`, req(pat, "POST", { answers: ans }))).status).toBe(200);
    await gen();
    r = await json(await call(`/consultations/${cid}/report`, req(psy)));
    expect(r.sections.results).toMatch(/PHQ-9 \(v/);
    expect(r.sections.results).toContain("item 9 was endorsed");

    const approve = (b: unknown, tok = psy) => call(`/consultations/${cid}/report/approve`, req(tok, "POST", b));
    const good = { name: "Dr A Rao", credentials: "RCI CRR 12345", confirm: true, acknowledge_gaps: true };
    expect((await approve(good, pat)).status).toBe(403);
    expect((await approve({ ...good, confirm: false })).status).toBe(422);
    expect((await approve({ ...good, credentials: "" })).status).toBe(422);
    expect((await approve(good)).status).toBe(409); // unacknowledged safety alert
    const alert = (await db.query("SELECT id FROM psych_alerts")).rows[0] as any;
    await call(`/alerts/${alert.id}/ack`, req(psy, "POST"));
    expect((await approve({ ...good, acknowledge_gaps: false })).status).toBe(409); // [Not provided] gaps
    expect((await call(`/consultations/${cid}/report`, req(psy, "PUT", { sections: { recommendations: "Follow-up in 4 weeks; consider full ADHD assessment." } }))).status).toBe(200);
    expect((await approve(good)).status).toBe(200);
    r = await json(await call(`/consultations/${cid}/report`, req(psy)));
    expect(r.status).toBe("approved");
    expect(r.sections.psychologist).toContain("RCI CRR 12345");
    expect((await call(`/consultations/${cid}/report`, req(psy, "PUT", { sections: { results: "tampered" } }))).status).toBe(409);
    expect((await gen()).status).toBe(409);
    expect((await approve(good)).status).toBe(409);
  });

  it("the audit trail records ids and actions, not clinical text or tokens", async () => {
    const rows = (await db.query("SELECT action, detail::text d FROM psych_audit_log")).rows as any[];
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["observer_invited", "task_submitted", "external_result_entered", "report_approved", "observer_submitted"]));
    const all = JSON.stringify(rows);
    expect(all).not.toMatch(/Calm, cooperative|Inattention|FSIQ|Test Patient|query attention/);
  });
});
