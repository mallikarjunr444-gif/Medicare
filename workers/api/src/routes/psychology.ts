import { Hono } from "hono/tiny";
import { requireUser } from "../auth";
import type { AppVars, DbUser, Env } from "../env";
import { fail, iso, validationError } from "../http";
import { readJson } from "../validate";
import { PSYCH_SCHEMA } from "../psychSchema";
import { INSTRUMENTS, isInstrumentId, score, validateAnswers, type InstrumentId } from "../psychScoring";

export const psychology = new Hono<{ Bindings: Env; Variables: AppVars }>();
psychology.use("*", requireUser);

// Creates the psychology tables on first use (idempotent). Checked once per Worker instance.
let schemaReady: Promise<void> | null = null;
export function ensurePsychSchema(q: (t: string, p?: unknown[]) => Promise<Record<string, any>[]>): Promise<void> {
  schemaReady ??= (async () => {
    const r = await q(
      `SELECT to_regclass('public.psych_reports') IS NOT NULL AS t,
              EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'is_psychologist') AS c`);
    if (r[0]?.t === true && r[0]?.c === true) return;
    for (const stmt of PSYCH_SCHEMA) await q(stmt);
  })().catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}
psychology.use("*", async (c, next) => {
  try { await ensurePsychSchema(c.var.query); } catch (e) {
    console.error("psych_schema_failed", String((e as Error)?.message).slice(0, 160));
    fail(503, "The psychology module is not ready yet. Please try again shortly.");
  }
  await next();
});

type C = any;
export const CONSENT_KINDS = ["online_consultation", "assessment", "data_processing", "observer_questionnaire", "recording"] as const;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export function isPsychologist(user: DbUser, env: Env): boolean {
  if (user.is_guest || !user.is_active) return false;
  if (user.is_psychologist) return true;
  const list = (env.PSYCHOLOGIST_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(String(user.email).toLowerCase());
}

export const rand = (alphabet: string, n: number) => {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b, (x) => alphabet[x % alphabet.length]).join("");
};

/** Append-only audit trail. Records ids and actions only, never answers or clinical text. */
export async function audit(c: C, consultationId: string | null, action: string, detail: Record<string, unknown> = {}) {
  await c.var.query(
    "INSERT INTO psych_audit_log (id, actor_id, consultation_id, action, detail) VALUES ($1,$2,$3,$4,$5::jsonb)",
    [crypto.randomUUID(), c.var.user.id, consultationId, action, JSON.stringify(detail)],
  );
}

export function requirePsychologist(c: C) {
  if (!isPsychologist(c.var.user, c.env)) fail(403, "Psychologist access required");
}

/** Loads a consultation and the caller's role in it. Non-participants get 404 (no existence leak). */
export async function loadConsultation(c: C, id: string) {
  const row = (await c.var.query("SELECT * FROM psych_consultations WHERE id = $1", [id]))[0];
  const me = c.var.user.id;
  if (!row || (row.psychologist_id !== me && row.patient_id !== me)) fail(404, "Consultation not found");
  const role: "psychologist" | "patient" = row.psychologist_id === me ? "psychologist" : "patient";
  return { row, role };
}

async function loadAssignment(c: C, aid: string) {
  const a = (await c.var.query("SELECT * FROM psych_assignments WHERE id = $1", [aid]))[0];
  if (!a) fail(404, "Assessment not found");
  const { row, role } = await loadConsultation(c, a.consultation_id);
  return { a, consultation: row, role };
}

const ageFrom = (dob: string | null): number | null => {
  if (!dob) return null;
  const d = new Date(dob + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
};

const str = (v: unknown, max: number, field: string, errs: any[]): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > max) { errs.push({ loc: ["body", field], msg: `String should have at most ${max} characters`, type: "string_too_long" }); return null; }
  return v.trim();
};

// ---------- public to any signed-in user ----------
psychology.get("/me", (c) => c.json({ is_psychologist: isPsychologist(c.var.user!, c.env) }));

psychology.get("/instruments", (c) =>
  c.json(Object.values(INSTRUMENTS).map((i) => ({ id: i.id, name: i.name, full_name: i.fullName, version: i.version, purpose: i.purpose, intro: i.intro, options: i.options, items: i.items, notice: i.notice, attribution: i.attribution ?? null }))),
);

// ---------- consultations ----------
psychology.post("/consultations", async (c) => {
  requirePsychologist(c);
  const id = crypto.randomUUID();
  const code = rand(CODE_ALPHABET, 8);
  const room = "medicare-psych-" + rand("abcdefghijklmnopqrstuvwxyz0123456789", 24); // unguessable room name
  await c.var.query(
    "INSERT INTO psych_consultations (id, join_code, room, psychologist_id) VALUES ($1,$2,$3,$4)",
    [id, code, room, c.var.user!.id],
  );
  await audit(c, id, "consultation_created");
  return c.json({ id, join_code: code, room, status: "scheduled" }, 201);
});

psychology.get("/consultations", async (c) => {
  const me = c.var.user!.id;
  const rows = await c.var.query(
    `SELECT id, status, created_at, started_at, ended_at, patient_id IS NOT NULL AS patient_joined,
            CASE WHEN psychologist_id = $1 THEN 'psychologist' ELSE 'patient' END AS role,
            CASE WHEN psychologist_id = $1 THEN join_code END AS join_code
       FROM psych_consultations WHERE psychologist_id = $1 OR patient_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [me],
  );
  return c.json(rows.map((r) => ({ ...r, created_at: iso(r.created_at), started_at: iso(r.started_at), ended_at: iso(r.ended_at) })));
});

psychology.post("/consultations/join", async (c) => {
  const b = await readJson(c.req.raw);
  const code = String(b.code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const me = c.var.user!.id;
  if (code.length !== 8) fail(404, "Consultation not found");
  let row = (await c.var.query("SELECT * FROM psych_consultations WHERE join_code = $1 AND status <> 'ended'", [code]))[0];
  if (!row || row.psychologist_id === me) fail(404, "Consultation not found");
  if (!row.patient_id) {
    const claimed = await c.var.query("UPDATE psych_consultations SET patient_id = $1 WHERE id = $2 AND patient_id IS NULL RETURNING id", [me, row.id]);
    if (claimed.length) await audit(c, row.id, "patient_joined");
    row = (await c.var.query("SELECT * FROM psych_consultations WHERE id = $1", [row.id]))[0];
  }
  if (row.patient_id !== me) fail(404, "Consultation not found"); // the code was already claimed by someone else
  return c.json({ id: row.id });
});

psychology.get("/consultations/:id", async (c) => {
  const { row, role } = await loadConsultation(c, c.req.param("id"));
  const q = c.var.query;
  const intake = (await q(
    `SELECT full_name, preferred_name, to_char(date_of_birth,'YYYY-MM-DD') AS dob, contact, preferred_language, occupation FROM psych_intake WHERE consultation_id = $1`, [row.id]))[0] ?? null;
  const consentRows = await q("SELECT kind, granted FROM psych_consents WHERE consultation_id = $1", [row.id]);
  const consents: Record<string, boolean> = Object.fromEntries(CONSENT_KINDS.map((k) => [k, false]));
  for (const r of consentRows) consents[r.kind] = !!r.granted;
  const assigns = await q("SELECT * FROM psych_assignments WHERE consultation_id = $1 ORDER BY assigned_at", [row.id]);
  const resp = await q(
    `SELECT r.* FROM psych_responses r JOIN psych_assignments a ON a.id = r.assignment_id WHERE a.consultation_id = $1`, [row.id]);
  const byAssign = new Map(resp.map((r) => [r.assignment_id, r]));

  const assignments = assigns.map((a) => {
    const ins = INSTRUMENTS[a.instrument as InstrumentId];
    const draft = a.draft_answers ?? {};
    const base: Record<string, unknown> = {
      id: a.id, instrument: a.instrument, name: ins?.name ?? a.instrument, status: a.status,
      total_items: ins?.items.length ?? 0, answered_count: a.status === "completed" ? ins?.items.length ?? 0 : Object.keys(draft).length,
      assigned_at: iso(a.assigned_at), started_at: iso(a.started_at), completed_at: iso(a.completed_at),
    };
    if (role === "patient" && (a.status === "active" || a.status === "paused")) base.draft = draft; // lets the patient resume
    return base;
  });

  const out: Record<string, unknown> = {
    id: row.id, role, status: row.status, room: row.room, recording_enabled: !!row.recording_enabled,
    patient_joined: !!row.patient_id, created_at: iso(row.created_at),
    intake: intake && { ...intake, age: ageFrom(intake.dob) }, consents, assignments,
  };
  if (role === "psychologist") {
    out.join_code = row.join_code;
    out.results = assigns.filter((a) => byAssign.has(a.id)).map((a) => {
      const r = byAssign.get(a.id)!;
      const res = r.result ?? {};
      return {
        assignment_id: a.id, instrument: a.instrument, name: INSTRUMENTS[a.instrument as InstrumentId]?.name ?? a.instrument,
        version: r.instrument_version, total: r.total_score, severity: r.severity, label: res.label, screening: res.screening ?? null,
        flags: res.flags ?? {}, notice: res.notice, answers: r.answers, corrected: !!r.corrected, submitted_at: iso(r.submitted_at),
      };
    });
    out.alerts = (await q(
      "SELECT id, assignment_id, kind, message, created_at, acknowledged_at FROM psych_alerts WHERE consultation_id = $1 ORDER BY created_at DESC", [row.id]))
      .map((a) => ({ ...a, created_at: iso(a.created_at), acknowledged_at: iso(a.acknowledged_at) }));
  }
  return c.json(out);
});

psychology.post("/consultations/:id/status", async (c) => {
  requirePsychologist(c);
  const { row, role } = await loadConsultation(c, c.req.param("id"));
  if (role !== "psychologist") fail(403, "Psychologist access required");
  const action = (await readJson(c.req.raw)).action;
  if (action === "start" && row.status === "scheduled") {
    await c.var.query("UPDATE psych_consultations SET status='active', started_at=now() WHERE id=$1", [row.id]);
  } else if (action === "end" && row.status !== "ended") {
    await c.var.query("UPDATE psych_consultations SET status='ended', ended_at=now() WHERE id=$1", [row.id]);
    await c.var.query("UPDATE psych_assignments SET status='ended' WHERE consultation_id=$1 AND status IN ('assigned','active','paused')", [row.id]);
  } else fail(409, "That action is not available for this consultation");
  await audit(c, row.id, `consultation_${action}`);
  return c.json({ ok: true });
});

// ---------- patient: intake + consent ----------
psychology.put("/consultations/:id/intake", async (c) => {
  const { row, role } = await loadConsultation(c, c.req.param("id"));
  if (role !== "patient") fail(403, "Only the patient can complete this form");
  if (row.status === "ended") fail(409, "This consultation has ended");
  const b = await readJson(c.req.raw);
  const errs: any[] = [];
  const full_name = str(b.full_name, 200, "full_name", errs);
  const preferred_name = str(b.preferred_name, 100, "preferred_name", errs);
  const contact = str(b.contact, 200, "contact", errs);
  const preferred_language = str(b.preferred_language, 40, "preferred_language", errs);
  const occupation = str(b.occupation, 200, "occupation", errs);
  let dob: string | null = null;
  if (b.date_of_birth !== undefined && b.date_of_birth !== null && b.date_of_birth !== "") {
    const s = String(b.date_of_birth);
    const age = /^\d{4}-\d{2}-\d{2}$/.test(s) ? ageFrom(s) : null;
    if (age === null || age < 0 || age > 120) errs.push({ loc: ["body", "date_of_birth"], msg: "Enter a valid date of birth", type: "value_error" });
    else dob = s;
  }
  if (errs.length) validationError(errs);
  await c.var.query(
    `INSERT INTO psych_intake (consultation_id, full_name, preferred_name, date_of_birth, contact, preferred_language, occupation, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (consultation_id) DO UPDATE SET full_name=EXCLUDED.full_name, preferred_name=EXCLUDED.preferred_name,
       date_of_birth=EXCLUDED.date_of_birth, contact=EXCLUDED.contact, preferred_language=EXCLUDED.preferred_language,
       occupation=EXCLUDED.occupation, updated_at=now()`,
    [row.id, full_name, preferred_name, dob, contact, preferred_language, occupation],
  );
  await audit(c, row.id, "intake_saved");
  return c.json({ ok: true, age: ageFrom(dob) });
});

psychology.put("/consultations/:id/consents", async (c) => {
  const { row, role } = await loadConsultation(c, c.req.param("id"));
  if (role !== "patient") fail(403, "Only the patient can give or withdraw consent");
  if (row.status === "ended") fail(409, "This consultation has ended");
  const b = await readJson(c.req.raw);
  if (!CONSENT_KINDS.includes(b.kind as any) || typeof b.granted !== "boolean")
    validationError([{ loc: ["body", "kind"], msg: "kind must be a known consent type and granted a boolean", type: "value_error" }]);
  await c.var.query(
    `INSERT INTO psych_consents (consultation_id, kind, granted, updated_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (consultation_id, kind) DO UPDATE SET granted = EXCLUDED.granted, updated_at = now()`,
    [row.id, b.kind, b.granted],
  );
  await audit(c, row.id, b.granted ? "consent_granted" : "consent_withdrawn", { kind: b.kind });
  return c.json({ ok: true });
});

// ---------- psychologist: assignment ----------
psychology.post("/consultations/:id/assignments", async (c) => {
  requirePsychologist(c);
  const { row, role } = await loadConsultation(c, c.req.param("id"));
  if (role !== "psychologist") fail(403, "Psychologist access required");
  if (row.status === "ended") fail(409, "This consultation has ended");
  if (!row.patient_id) fail(409, "The patient has not joined yet");
  const instrument = (await readJson(c.req.raw)).instrument;
  if (!isInstrumentId(instrument)) validationError([{ loc: ["body", "instrument"], msg: "Unknown assessment", type: "value_error" }]);
  const need = await c.var.query("SELECT kind FROM psych_consents WHERE consultation_id=$1 AND granted AND kind IN ('assessment','data_processing')", [row.id]);
  if (need.length < 2) fail(409, "The patient must consent to assessment and to processing and storage of assessment information first");
  const id = crypto.randomUUID();
  try {
    await c.var.query("INSERT INTO psych_assignments (id, consultation_id, instrument, assigned_by) VALUES ($1,$2,$3,$4)", [id, row.id, instrument, c.var.user!.id]);
  } catch {
    fail(409, "That assessment is already assigned");
  }
  await audit(c, row.id, "assessment_assigned", { assignment_id: id, instrument });
  return c.json({ id }, 201);
});

const TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  start: { from: ["assigned"], to: "active" },
  pause: { from: ["active"], to: "paused" },
  resume: { from: ["paused"], to: "active" },
  end: { from: ["assigned", "active", "paused"], to: "ended" },
};

psychology.post("/assignments/:aid/action", async (c) => {
  requirePsychologist(c);
  const { a, role } = await loadAssignment(c, c.req.param("aid"));
  if (role !== "psychologist") fail(403, "Psychologist access required");
  const action = String((await readJson(c.req.raw)).action);
  const t = TRANSITIONS[action];
  if (!t || !t.from.includes(a.status)) fail(409, "That action is not available for this assessment");
  await c.var.query(
    `UPDATE psych_assignments SET status=$1::varchar,
       started_at = CASE WHEN $1::varchar = 'active' THEN COALESCE(started_at, now()) ELSE started_at END WHERE id=$2`, [t.to, a.id]);
  await audit(c, a.consultation_id, `assessment_${action}`, { assignment_id: a.id, instrument: a.instrument });
  return c.json({ ok: true, status: t.to });
});

// ---------- patient: answer ----------
psychology.put("/assignments/:aid/draft", async (c) => {
  const { a, role } = await loadAssignment(c, c.req.param("aid"));
  if (role !== "patient") fail(403, "Only the patient can answer");
  if (a.status !== "active") fail(409, "Your psychologist has not started this assessment");
  const ins = INSTRUMENTS[a.instrument as InstrumentId];
  const answers = (await readJson(c.req.raw)).answers as Record<string, unknown>;
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(answers && typeof answers === "object" ? answers : {})) {
    const i = Number(k);
    if (Number.isInteger(i) && i >= 0 && i < ins.items.length && Number.isInteger(v) && (v as number) >= 0 && (v as number) < ins.options.length) clean[String(i)] = v as number;
  }
  await c.var.query("UPDATE psych_assignments SET draft_answers=$1::jsonb WHERE id=$2 AND status='active'", [JSON.stringify(clean), a.id]);
  return c.json({ ok: true, answered_count: Object.keys(clean).length });
});

const ITEM9_ALERT = "PHQ-9 item 9 was answered above zero (thoughts of being better off dead or of self-harm). Follow up directly with the patient now. The PHQ-9 score is not a suicide-risk assessment.";

async function raiseItem9Alert(c: C, consultationId: string, assignmentId: string) {
  const existing = await c.var.query("SELECT id FROM psych_alerts WHERE assignment_id=$1 AND kind='phq9_item9'", [assignmentId]);
  if (existing.length) return;
  await c.var.query("INSERT INTO psych_alerts (id, consultation_id, assignment_id, kind, message) VALUES ($1,$2,$3,'phq9_item9',$4)", [crypto.randomUUID(), consultationId, assignmentId, ITEM9_ALERT]);
  await audit(c, consultationId, "safety_alert_raised", { assignment_id: assignmentId, kind: "phq9_item9" });
}

psychology.post("/assignments/:aid/submit", async (c) => {
  const { a, role } = await loadAssignment(c, c.req.param("aid"));
  if (role !== "patient") fail(403, "Only the patient can submit");
  const id = a.instrument as InstrumentId;
  const answers = (await readJson(c.req.raw)).answers;
  const problem = validateAnswers(id, answers);
  if (problem) validationError([{ loc: ["body", "answers"], msg: problem, type: "value_error" }]);
  // Atomic guard: only one submission can move active -> completed, so a response can never be overwritten.
  const claimed = await c.var.query("UPDATE psych_assignments SET status='completed', completed_at=now(), draft_answers='{}'::jsonb WHERE id=$1 AND status='active' RETURNING id", [a.id]);
  if (!claimed.length) fail(409, "This assessment is not open for answers");
  const result = score(id, answers as Record<string, number>);
  await c.var.query(
    `INSERT INTO psych_responses (id, assignment_id, instrument, instrument_version, answers, total_score, severity, result)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb)`,
    [crypto.randomUUID(), a.id, id, INSTRUMENTS[id].version, JSON.stringify(answers), result.total, result.severity, JSON.stringify(result)],
  );
  await audit(c, a.consultation_id, "assessment_submitted", { assignment_id: a.id, instrument: id });
  const needsSupport = id === "phq9" && result.flags.item9Positive === true;
  if (needsSupport) await raiseItem9Alert(c, a.consultation_id, a.id);
  // The patient never receives scores. Only a support message when item 9 is positive.
  return c.json({ status: "completed", support_message: needsSupport ? "Thank you. Please tell your psychologist how you are feeling right now so they can talk with you directly. If you are in immediate danger, call 112." : null });
});

// ---------- psychologist: corrections, alerts, audit ----------
psychology.post("/assignments/:aid/correct", async (c) => {
  requirePsychologist(c);
  const { a, role } = await loadAssignment(c, c.req.param("aid"));
  if (role !== "psychologist") fail(403, "Psychologist access required");
  if (a.status !== "completed") fail(409, "Only a completed assessment can be corrected");
  const b = await readJson(c.req.raw);
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reason.length < 5 || reason.length > 1000) validationError([{ loc: ["body", "reason"], msg: "A reason of 5 to 1000 characters is required", type: "value_error" }]);
  const id = a.instrument as InstrumentId;
  const problem = validateAnswers(id, b.answers);
  if (problem) validationError([{ loc: ["body", "answers"], msg: problem, type: "value_error" }]);
  const prev = (await c.var.query("SELECT * FROM psych_responses WHERE assignment_id=$1", [a.id]))[0];
  if (!prev) fail(404, "Response not found");
  const result = score(id, b.answers as Record<string, number>);
  await c.var.query(
    `INSERT INTO psych_response_corrections (id, response_id, corrected_by, reason, previous_answers, previous_total, new_answers, new_total)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8)`,
    [crypto.randomUUID(), prev.id, c.var.user!.id, reason, JSON.stringify(prev.answers), prev.total_score, JSON.stringify(b.answers), result.total],
  );
  await c.var.query("UPDATE psych_responses SET answers=$1::jsonb, total_score=$2, severity=$3, result=$4::jsonb, corrected=true WHERE id=$5",
    [JSON.stringify(b.answers), result.total, result.severity, JSON.stringify(result), prev.id]);
  await audit(c, a.consultation_id, "response_corrected", { assignment_id: a.id, instrument: id });
  if (id === "phq9" && result.flags.item9Positive) await raiseItem9Alert(c, a.consultation_id, a.id);
  return c.json({ ok: true });
});

psychology.post("/alerts/:id/ack", async (c) => {
  requirePsychologist(c);
  const al = (await c.var.query("SELECT * FROM psych_alerts WHERE id=$1", [c.req.param("id")]))[0];
  if (!al) fail(404, "Alert not found");
  const { role } = await loadConsultation(c, al.consultation_id);
  if (role !== "psychologist") fail(403, "Psychologist access required");
  await c.var.query("UPDATE psych_alerts SET acknowledged_by=$1, acknowledged_at=now() WHERE id=$2 AND acknowledged_at IS NULL", [c.var.user!.id, al.id]);
  await audit(c, al.consultation_id, "safety_alert_acknowledged", { alert_id: al.id });
  return c.json({ ok: true });
});

psychology.get("/consultations/:id/audit", async (c) => {
  requirePsychologist(c);
  const { row, role } = await loadConsultation(c, c.req.param("id"));
  if (role !== "psychologist") fail(403, "Psychologist access required");
  const rows = await c.var.query("SELECT actor_id, action, detail, created_at FROM psych_audit_log WHERE consultation_id=$1 ORDER BY created_at DESC LIMIT 200", [row.id]);
  return c.json(rows.map((r) => ({ ...r, created_at: iso(r.created_at) })));
});
