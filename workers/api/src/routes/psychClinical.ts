import { Hono } from "hono/tiny";
import { requireUser } from "../auth";
import type { AppVars, Env } from "../env";
import { fail, iso, validationError } from "../http";
import { readJson } from "../validate";
import { INSTRUMENTS, type InstrumentId } from "../psychScoring";
import {
  EXTERNAL_INSTRUMENTS, HISTORY_KINDS, INTERVIEW_FIELDS, INTERVIEW_SECTIONS, NOTE_KINDS, OBSERVER_FORM, REPORT_SECTIONS, TASKS,
  isExternalId, isTaskId, summariseTask,
} from "../psychExtras";
import { audit, ensurePsychSchema, loadConsultation, rand, requirePsychologist } from "./psychology";

type C = any;
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const text = (v: unknown, max: number, field: string, required = false): string => {
  const s = typeof v === "string" ? v.trim() : "";
  if ((required && !s) || s.length > max) validationError([{ loc: ["body", field], msg: required && !s ? "This field is required" : `Must be at most ${max} characters`, type: "value_error" }]);
  return s;
};

async function ensure(c: C, next: () => Promise<void>) {
  try { await ensurePsychSchema(c.var.query); } catch { fail(503, "The psychology module is not ready yet. Please try again shortly."); }
  await next();
}
async function psychologistOf(c: C, id: string) {
  requirePsychologist(c);
  const r = await loadConsultation(c, id);
  if (r.role !== "psychologist") fail(403, "Psychologist access required");
  return r.row;
}
async function consented(c: C, id: string, kinds: string[]) {
  const rows = await c.var.query("SELECT kind FROM psych_consents WHERE consultation_id=$1 AND granted", [id]);
  return kinds.every((k) => rows.some((r: any) => r.kind === k));
}

/** Everything the dashboard and the report draft are built from. Only recorded data, never inferred. */
export async function collect(c: C, id: string) {
  const q = c.var.query;
  const [cons] = await q("SELECT * FROM psych_consultations WHERE id=$1", [id]);
  const intake = (await q("SELECT full_name, preferred_name, to_char(date_of_birth,'YYYY-MM-DD') AS dob, contact, preferred_language, occupation FROM psych_intake WHERE consultation_id=$1", [id]))[0] ?? null;
  const assigns = await q("SELECT * FROM psych_assignments WHERE consultation_id=$1 ORDER BY assigned_at", [id]);
  const resp = await q("SELECT r.* FROM psych_responses r JOIN psych_assignments a ON a.id=r.assignment_id WHERE a.consultation_id=$1", [id]);
  const observers = await q("SELECT id, observer_label, relationship, status, expires_at, submitted_at, answers FROM psych_observer_invites WHERE consultation_id=$1 ORDER BY created_at", [id]);
  const tasks = await q("SELECT id, task, status, result, completed_at FROM psych_task_runs WHERE consultation_id=$1 ORDER BY assigned_at", [id]);
  const external = await q("SELECT id, instrument, to_char(administered_on,'YYYY-MM-DD') AS administered_on, administered_by, authorization_ref, scores, comments FROM psych_external_results WHERE consultation_id=$1 ORDER BY created_at", [id]);
  const interviewRow = (await q("SELECT data FROM psych_interview WHERE consultation_id=$1", [id]))[0];
  const notes = await q("SELECT id, kind, body, created_at, updated_at FROM psych_notes WHERE consultation_id=$1 ORDER BY created_at", [id]);
  const forms = await q("SELECT id, title, options, items, status, answers FROM psych_forms WHERE consultation_id=$1 ORDER BY created_at", [id]);
  const alerts = await q("SELECT id, kind, message, created_at, acknowledged_at FROM psych_alerts WHERE consultation_id=$1 ORDER BY created_at", [id]);
  const consents = await q("SELECT kind, granted FROM psych_consents WHERE consultation_id=$1", [id]);
  return { cons, intake, assigns, resp, observers, tasks, external, interview: interviewRow?.data ?? {}, notes, alerts, consents, forms };
}

const clinical = new Hono<{ Bindings: Env; Variables: AppVars }>();
clinical.use("*", requireUser);
clinical.use("*", ensure as any);

// ---------- observers (psychologist side) ----------
clinical.post("/consultations/:id/observers", async (c) => {
  const row = await psychologistOf(c, c.req.param("id"));
  if (!(await consented(c, row.id, ["observer_questionnaire"]))) fail(409, "The patient has not consented to observer questionnaires.");
  const b = await readJson(c.req.raw);
  const label = text(b.label, 80, "label", true);
  const relationship = text(b.relationship, 60, "relationship");
  const token = rand("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789", 32);
  const oid = crypto.randomUUID();
  await c.var.query(
    "INSERT INTO psych_observer_invites (id, consultation_id, token_hash, observer_label, relationship, expires_at, created_by) VALUES ($1,$2,$3,$4,$5, now() + interval '14 days', $6)",
    [oid, row.id, await sha256(token), label, relationship || null, c.var.user!.id],
  );
  await audit(c, row.id, "observer_invited", { invite_id: oid });
  return c.json({ id: oid, token, expires_in_days: 14 }, 201); // the token is shown once and only its hash is stored
});
clinical.post("/observers/:oid/revoke", async (c) => {
  const inv = (await c.var.query("SELECT * FROM psych_observer_invites WHERE id=$1", [c.req.param("oid")]))[0];
  if (!inv) fail(404, "Invite not found");
  await psychologistOf(c, inv.consultation_id);
  await c.var.query("UPDATE psych_observer_invites SET status='revoked' WHERE id=$1 AND status='pending'", [inv.id]);
  await audit(c, inv.consultation_id, "observer_revoked", { invite_id: inv.id });
  return c.json({ ok: true });
});

// ---------- supplementary cognitive tasks ----------
clinical.get("/tasks/catalog", (c) => c.json(Object.values(TASKS)));
clinical.post("/consultations/:id/tasks", async (c) => {
  const row = await psychologistOf(c, c.req.param("id"));
  const b = await readJson(c.req.raw);
  if (!isTaskId(b.task)) validationError([{ loc: ["body", "task"], msg: "Unknown task", type: "value_error" }]);
  if (!(await consented(c, row.id, ["assessment", "data_processing"]))) fail(409, "The patient has not given assessment and data-processing consent.");
  const tid = crypto.randomUUID();
  await c.var.query("INSERT INTO psych_task_runs (id, consultation_id, task, assigned_by) VALUES ($1,$2,$3,$4)", [tid, row.id, b.task, c.var.user!.id]);
  await audit(c, row.id, "task_assigned", { task_id: tid, task: b.task });
  return c.json({ id: tid }, 201);
});
clinical.get("/consultations/:id/tasks", async (c) => {
  const { row, role } = await loadConsultation(c, c.req.param("id"));
  const rows = await c.var.query("SELECT id, task, status, result, completed_at FROM psych_task_runs WHERE consultation_id=$1 ORDER BY assigned_at", [row.id]);
  return c.json(rows.map((r: any) => ({ id: r.id, task: r.task, name: (TASKS as any)[r.task]?.name ?? r.task, status: r.status, completed_at: iso(r.completed_at), ...(role === "psychologist" ? { result: r.result } : {}) })));
});
clinical.post("/tasks/:tid/start", async (c) => {
  const t = (await c.var.query("SELECT * FROM psych_task_runs WHERE id=$1", [c.req.param("tid")]))[0];
  if (!t) fail(404, "Task not found");
  await psychologistOf(c, t.consultation_id);
  const r = await c.var.query("UPDATE psych_task_runs SET status='active' WHERE id=$1 AND status='assigned' RETURNING id", [t.id]);
  if (!r.length) fail(409, "Task cannot be started");
  await audit(c, t.consultation_id, "task_started", { task_id: t.id });
  return c.json({ ok: true });
});
clinical.post("/tasks/:tid/submit", async (c) => {
  const t = (await c.var.query("SELECT * FROM psych_task_runs WHERE id=$1", [c.req.param("tid")]))[0];
  if (!t) fail(404, "Task not found");
  const { role } = await loadConsultation(c, t.consultation_id);
  if (role !== "patient") fail(403, "Only the patient can complete a task");
  if (t.status !== "active") fail(409, "This task is not active");
  const b = await readJson(c.req.raw);
  const summary = summariseTask(t.task, b);
  if (typeof summary === "string") validationError([{ loc: ["body", "trials"], msg: summary, type: "value_error" }]);
  const r = await c.var.query("UPDATE psych_task_runs SET status='completed', result=$1::jsonb, completed_at=now() WHERE id=$2 AND status='active' RETURNING id", [JSON.stringify({ summary, trials: (b as any).trials }), t.id]);
  if (!r.length) fail(409, "This task was already submitted");
  await audit(c, t.consultation_id, "task_submitted", { task_id: t.id });
  return c.json({ status: "completed" });
});


// ---------- custom questionnaires (built-in replacement for external survey servers) ----------
// Unscored on purpose: a clinician-written form is not a validated instrument, so no score or severity is ever computed.
clinical.post("/consultations/:id/forms", async (c) => {
  const row = await psychologistOf(c, c.req.param("id"));
  if (!(await consented(c, row.id, ["assessment", "data_processing"]))) fail(409, "The patient has not given assessment and data-processing consent.");
  const b = await readJson(c.req.raw);
  const title = text(b.title, 120, "title", true), intro = text(b.intro, 1000, "intro");
  const options = Array.isArray(b.options) ? b.options.map((o: unknown, i: number) => text(o, 80, `options.${i}`, true)) : [];
  const items = Array.isArray(b.items) ? b.items.map((o: unknown, i: number) => text(o, 400, `items.${i}`, true)) : [];
  if (options.length < 2 || options.length > 7) validationError([{ loc: ["body", "options"], msg: "Provide 2 to 7 answer options", type: "value_error" }]);
  if (items.length < 1 || items.length > 60) validationError([{ loc: ["body", "items"], msg: "Provide 1 to 60 questions", type: "value_error" }]);
  const fid = crypto.randomUUID();
  await c.var.query("INSERT INTO psych_forms (id, consultation_id, title, intro, options, items, created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)",
    [fid, row.id, title, intro || null, JSON.stringify(options), JSON.stringify(items), c.var.user!.id]);
  await audit(c, row.id, "form_assigned", { form_id: fid });
  return c.json({ id: fid }, 201);
});
clinical.get("/consultations/:id/forms", async (c) => {
  const { row, role } = await loadConsultation(c, c.req.param("id"));
  const rows = await c.var.query("SELECT * FROM psych_forms WHERE consultation_id=$1 ORDER BY created_at", [row.id]);
  return c.json(rows.map((f: any) => role === "psychologist"
    ? { id: f.id, title: f.title, intro: f.intro, options: f.options, items: f.items, status: f.status, answers: f.answers, completed_at: iso(f.completed_at) }
    : { id: f.id, title: f.title, status: f.status, ...(f.status === "active" ? { intro: f.intro, options: f.options, items: f.items } : {}) })); // patients only see questions once started
});
clinical.post("/forms/:fid/start", async (c) => {
  const f = (await c.var.query("SELECT * FROM psych_forms WHERE id=$1", [c.req.param("fid")]))[0];
  if (!f) fail(404, "Questionnaire not found");
  await psychologistOf(c, f.consultation_id);
  const r = await c.var.query("UPDATE psych_forms SET status='active' WHERE id=$1 AND status='assigned' RETURNING id", [f.id]);
  if (!r.length) fail(409, "Questionnaire cannot be started");
  await audit(c, f.consultation_id, "form_started", { form_id: f.id });
  return c.json({ ok: true });
});
clinical.post("/forms/:fid/submit", async (c) => {
  const f = (await c.var.query("SELECT * FROM psych_forms WHERE id=$1", [c.req.param("fid")]))[0];
  if (!f) fail(404, "Questionnaire not found");
  const { role } = await loadConsultation(c, f.consultation_id);
  if (role !== "patient") fail(403, "Only the patient can answer");
  if (f.status !== "active") fail(409, "This questionnaire is not active");
  const b = await readJson(c.req.raw); const a = b.answers as Record<string, unknown>;
  const answers: Record<string, number> = {};
  for (let i = 0; i < f.items.length; i++) {
    const v = a?.[String(i)];
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) >= f.options.length) validationError([{ loc: ["body", "answers", i], msg: `Question ${i + 1} needs an answer`, type: "value_error" }]);
    answers[String(i)] = v as number;
  }
  const r = await c.var.query("UPDATE psych_forms SET status='completed', answers=$1::jsonb, completed_at=now() WHERE id=$2 AND status='active' RETURNING id", [JSON.stringify(answers), f.id]);
  if (!r.length) fail(409, "Already submitted");
  await audit(c, f.consultation_id, "form_submitted", { form_id: f.id });
  return c.json({ status: "completed" });
});

// ---------- authorized results of licensed instruments (entered by the psychologist) ----------
clinical.post("/consultations/:id/external", async (c) => {
  const row = await psychologistOf(c, c.req.param("id"));
  const b = await readJson(c.req.raw);
  if (!isExternalId(b.instrument)) validationError([{ loc: ["body", "instrument"], msg: "Instrument must be wais4, caars or pai", type: "value_error" }]);
  if (b.attest !== true) validationError([{ loc: ["body", "attest"], msg: "You must confirm you administered this instrument under a valid licence", type: "value_error" }]);
  const on = text(b.administered_on, 10, "administered_on", true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || Number.isNaN(Date.parse(on)) || Date.parse(on) > Date.now() + 864e5) validationError([{ loc: ["body", "administered_on"], msg: "Enter a valid date that is not in the future", type: "value_error" }]);
  const scores = Array.isArray(b.scores) ? b.scores : [];
  if (!scores.length || scores.length > 40) validationError([{ loc: ["body", "scores"], msg: "Enter between 1 and 40 scores", type: "value_error" }]);
  const clean = scores.map((s: any, i: number) => ({
    label: text(s?.label, 80, `scores.${i}.label`, true),
    value: text(String(s?.value ?? ""), 40, `scores.${i}.value`, true),
    note: text(s?.note, 200, `scores.${i}.note`),
  }));
  const eid = crypto.randomUUID();
  await c.var.query(
    "INSERT INTO psych_external_results (id, consultation_id, instrument, administered_on, administered_by, authorization_ref, scores, comments, entered_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)",
    [eid, row.id, b.instrument, on, text(b.administered_by, 120, "administered_by", true), text(b.authorization_ref, 120, "authorization_ref", true), JSON.stringify(clean), text(b.comments, 2000, "comments") || null, c.var.user!.id],
  );
  await audit(c, row.id, "external_result_entered", { result_id: eid, instrument: b.instrument });
  return c.json({ id: eid }, 201);
});

// ---------- structured interview ----------
clinical.get("/interview/schema", (c) => c.json({ sections: INTERVIEW_SECTIONS, fields: INTERVIEW_FIELDS }));
clinical.get("/consultations/:id/interview", async (c) => {
  const row = await psychologistOf(c, c.req.param("id"));
  const r = (await c.var.query("SELECT data FROM psych_interview WHERE consultation_id=$1", [row.id]))[0];
  return c.json({ data: r?.data ?? {} });
});
clinical.put("/consultations/:id/interview", async (c) => {
  const row = await psychologistOf(c, c.req.param("id"));
  const b = await readJson(c.req.raw);
  const data: Record<string, Record<string, string>> = {};
  for (const s of INTERVIEW_SECTIONS) {
    const src = (b.data as any)?.[s.id];
    if (!src) continue;
    data[s.id] = {};
    for (const f of INTERVIEW_FIELDS) { const v = text(src[f], 4000, `${s.id}.${f}`); if (v) data[s.id][f] = v; }
  }
  const impressions = text((b.data as any)?.impressions, 4000, "impressions"); // clinician-entered only
  const full = { ...data, ...(impressions ? { impressions } : {}) };
  await c.var.query(
    "INSERT INTO psych_interview (consultation_id, data, updated_by) VALUES ($1,$2::jsonb,$3) ON CONFLICT (consultation_id) DO UPDATE SET data=EXCLUDED.data, updated_by=EXCLUDED.updated_by, updated_at=now()",
    [row.id, JSON.stringify(full), c.var.user!.id]);
  await audit(c, row.id, "interview_saved");
  return c.json({ ok: true });
});

// ---------- notes and history (psychologist-only) ----------
clinical.get("/consultations/:id/notes", async (c) => {
  const row = await psychologistOf(c, c.req.param("id"));
  const rows = await c.var.query("SELECT id, kind, body, created_at, updated_at FROM psych_notes WHERE consultation_id=$1 ORDER BY created_at DESC", [row.id]);
  return c.json({ kinds: { notes: NOTE_KINDS, history: HISTORY_KINDS }, notes: rows.map((r: any) => ({ ...r, created_at: iso(r.created_at), updated_at: iso(r.updated_at) })) });
});
clinical.post("/consultations/:id/notes", async (c) => {
  const row = await psychologistOf(c, c.req.param("id"));
  const b = await readJson(c.req.raw);
  if (![...NOTE_KINDS, ...HISTORY_KINDS].includes(b.kind as any)) validationError([{ loc: ["body", "kind"], msg: "Unknown note type", type: "value_error" }]);
  const nid = crypto.randomUUID();
  await c.var.query("INSERT INTO psych_notes (id, consultation_id, author_id, kind, body) VALUES ($1,$2,$3,$4,$5)", [nid, row.id, c.var.user!.id, b.kind, text(b.body, 8000, "body", true)]);
  await audit(c, row.id, "note_created", { note_id: nid, kind: b.kind });
  return c.json({ id: nid }, 201);
});
clinical.put("/notes/:nid", async (c) => {
  const n = (await c.var.query("SELECT * FROM psych_notes WHERE id=$1", [c.req.param("nid")]))[0];
  if (!n) fail(404, "Note not found");
  await psychologistOf(c, n.consultation_id);
  if (n.author_id !== c.var.user!.id) fail(403, "Only the author can edit this note");
  const b = await readJson(c.req.raw);
  await c.var.query("UPDATE psych_notes SET body=$1, updated_at=now() WHERE id=$2", [text(b.body, 8000, "body", true), n.id]);
  await audit(c, n.consultation_id, "note_edited", { note_id: n.id });
  return c.json({ ok: true });
});

// ---------- dashboard and history ----------
function shapeResult(r: any, name: string) {
  const res = r.result ?? {};
  return { instrument: r.instrument, name, version: r.instrument_version, total: r.total_score, severity: r.severity, label: res.label ?? null, screening: res.screening ?? null, notice: res.notice ?? "", submitted_at: iso(r.submitted_at), corrected: !!r.corrected };
}
clinical.get("/consultations/:id/dashboard", async (c) => {
  const row = await psychologistOf(c, c.req.param("id"));
  const d = await collect(c, row.id);
  const byA = new Map(d.resp.map((r: any) => [r.assignment_id, r]));
  const assessments = d.assigns.map((a: any) => ({ id: a.id, instrument: a.instrument, name: INSTRUMENTS[a.instrument as InstrumentId]?.name ?? a.instrument, status: a.status, result: byA.has(a.id) ? shapeResult(byA.get(a.id), INSTRUMENTS[a.instrument as InstrumentId]?.name ?? a.instrument) : null }));
  const missing: string[] = [];
  if (!d.intake?.full_name) missing.push("Patient intake not completed");
  if (!assessments.length) missing.push("No assessments assigned");
  for (const a of assessments) if (a.status !== "completed") missing.push(`${a.name} not completed (${a.status})`);
  for (const o of d.observers) if (o.status === "pending") missing.push(`Observer response pending: ${o.observer_label}`);
  for (const t of d.tasks) if (t.status !== "completed") missing.push(`${(TASKS as any)[t.task]?.name ?? t.task} not completed`);
  for (const f of d.forms) if (f.status !== "completed") missing.push(`Questionnaire "${f.title}" not completed (${f.status})`);
  if (!d.notes.some((n: any) => n.kind === "observation")) missing.push("No psychologist behavioural observations recorded");
  if (!Object.keys(d.interview).length) missing.push("Structured clinical interview not started");
  // Historical comparison: earlier submissions of the same instrument for the same patient with this psychologist.
  let comparison: unknown[] = [];
  if (row.patient_id) {
    const prev = await c.var.query(
      `SELECT r.instrument, r.total_score, r.severity, r.submitted_at, c.id AS consultation_id FROM psych_responses r
         JOIN psych_assignments a ON a.id=r.assignment_id JOIN psych_consultations c ON c.id=a.consultation_id
        WHERE c.patient_id=$1 AND c.psychologist_id=$2 AND c.id<>$3 ORDER BY r.submitted_at`, [row.patient_id, c.var.user!.id, row.id]);
    comparison = prev.map((p: any) => ({ ...p, name: INSTRUMENTS[p.instrument as InstrumentId]?.name ?? p.instrument, submitted_at: iso(p.submitted_at) }));
  }
  return c.json({
    assessments, missing, comparison,
    forms: d.forms.map((f: any) => ({ id: f.id, title: f.title, status: f.status, items: f.items, options: f.options, answers: f.answers })),
    observers: d.observers.map((o: any) => ({ id: o.id, label: o.observer_label, relationship: o.relationship, status: o.status === "pending" && new Date(o.expires_at) < new Date() ? "expired" : o.status, submitted_at: iso(o.submitted_at), answers: o.answers })),
    tasks: d.tasks.map((t: any) => ({ id: t.id, task: t.task, name: (TASKS as any)[t.task]?.name ?? t.task, status: t.status, summary: t.result?.summary ?? null, note: (TASKS as any)[t.task]?.purpose })),
    external: d.external.map((e: any) => ({ ...e, name: (EXTERNAL_INSTRUMENTS as any)[e.instrument] })),
    alerts: d.alerts.map((a: any) => ({ ...a, created_at: iso(a.created_at), acknowledged_at: iso(a.acknowledged_at) })),
  });
});
clinical.get("/consultations/:id/history", async (c) => {
  const row = await psychologistOf(c, c.req.param("id"));
  const timeline = row.patient_id ? await c.var.query(
    `SELECT c.id, c.status, c.created_at, (SELECT count(*) FROM psych_responses r JOIN psych_assignments a ON a.id=r.assignment_id WHERE a.consultation_id=c.id)::int AS assessments,
            (SELECT count(*) FROM psych_reports p WHERE p.consultation_id=c.id AND p.status='approved')::int AS approved_reports
       FROM psych_consultations c WHERE c.patient_id=$1 AND c.psychologist_id=$2 ORDER BY c.created_at DESC`, [row.patient_id, c.var.user!.id]) : [];
  const entries = await c.var.query(
    `SELECT n.id, n.kind, n.body, n.created_at, n.consultation_id FROM psych_notes n JOIN psych_consultations c ON c.id=n.consultation_id
      WHERE c.patient_id=$1 AND c.psychologist_id=$2 AND n.kind = ANY($3::varchar[]) ORDER BY n.created_at DESC`, [row.patient_id ?? "", c.var.user!.id, [...HISTORY_KINDS]]);
  await audit(c, row.id, "history_viewed");
  return c.json({ consultations: timeline.map((t: any) => ({ ...t, created_at: iso(t.created_at) })), history: entries.map((e: any) => ({ ...e, created_at: iso(e.created_at) })) });
});

// ---------- report ----------
const NOT_PROVIDED = "[Not provided]";
function buildReport(d: Awaited<ReturnType<typeof collect>>, psychologistEmail: string) {
  const missing: string[] = [];
  const latest = (kind: string) => d.notes.filter((n: any) => n.kind === kind).map((n: any) => n.body);
  const joinOr = (xs: string[], label: string) => { if (xs.length) return xs.join("\n\n"); missing.push(label); return NOT_PROVIDED; };
  const i = d.intake;
  const byA = new Map(d.resp.map((r: any) => [r.assignment_id, r]));
  const done = d.assigns.filter((a: any) => a.status === "completed" && byA.has(a.id));
  const name = (a: any) => INSTRUMENTS[a.instrument as InstrumentId]?.name ?? a.instrument;
  if (!i?.full_name) missing.push("Patient identification");
  const iv: any = d.interview ?? {};
  const ivText = INTERVIEW_SECTIONS.map((s) => {
    const f = iv[s.id]; if (!f) return "";
    return `${s.title}:\n` + INTERVIEW_FIELDS.filter((k) => f[k]).map((k) => `  ${k.replace(/_/g, " ")}: ${f[k]}`).join("\n");
  }).filter(Boolean).join("\n\n");
  if (!ivText) missing.push("Structured clinical interview findings");

  const resultLines: string[] = [];
  for (const a of done) {
    const r: any = byA.get(a.id); const res = r.result ?? {};
    resultLines.push(r.total_score !== null && r.total_score !== undefined
      ? `${name(a)} (v${r.instrument_version}): total ${r.total_score}, ${res.label ?? r.severity}. ${res.notice ?? ""}`.trim()
      : `${name(a)} (v${r.instrument_version}): ${res.label ?? res.screening ?? "recorded"}. ${res.notice ?? ""}`.trim());
    if (res.flags?.item9Positive) resultLines.push(`  Note: PHQ-9 item 9 was endorsed and was reviewed through the safety process.`);
  }
  for (const e of d.external) resultLines.push(`${(EXTERNAL_INSTRUMENTS as any)[e.instrument]} (administered ${e.administered_on} by ${e.administered_by}; authorization ${e.authorization_ref}): ` + (e.scores as any[]).map((s) => `${s.label} ${s.value}${s.note ? ` (${s.note})` : ""}`).join("; "));
  for (const t of d.tasks.filter((t: any) => t.status === "completed")) resultLines.push(`Supplementary task, ${(TASKS as any)[t.task]?.name}: ${JSON.stringify(t.result?.summary)}. ${(TASKS as any)[t.task]?.purpose}`);
  for (const f of d.forms.filter((f: any) => f.status === "completed")) resultLines.push(`Clinician-defined questionnaire "${f.title}" completed (unscored, not a validated instrument): ` + (f.items as string[]).map((q, i) => `${q} -> ${f.options[f.answers[String(i)]]}`).join("; "));
  for (const o of d.observers.filter((o: any) => o.status === "submitted")) resultLines.push(`Observer report (${o.observer_label}${o.relationship ? ", " + o.relationship : ""}): informal, unscored; responses are in the clinical record.`);
  if (!resultLines.length) missing.push("Assessment results");
  for (const a of d.assigns.filter((a: any) => a.status !== "completed")) missing.push(`${name(a)} was assigned but not completed`);
  for (const f of d.forms.filter((f: any) => f.status !== "completed")) missing.push(`Questionnaire "${f.title}" was assigned but not completed`);
  for (const o of d.observers.filter((o: any) => o.status === "pending")) missing.push(`Observer response pending: ${o.observer_label}`);
  const administered = [...done.map(name), ...d.external.map((e: any) => (EXTERNAL_INSTRUMENTS as any)[e.instrument]), ...d.tasks.filter((t: any) => t.status === "completed").map((t: any) => (TASKS as any)[t.task]?.name)];
  if (!administered.length) missing.push("Assessments administered");

  for (const a of done) { const at = INSTRUMENTS[a.instrument as InstrumentId]?.attribution; if (at && !resultLines.includes(at)) resultLines.push(at); }
  const sections: Record<string, string> = {
    identification: i?.full_name ? [`Name: ${i.full_name}${i.preferred_name ? ` (prefers "${i.preferred_name}")` : ""}`, `Date of birth: ${i.dob ?? NOT_PROVIDED}`, `Preferred language: ${i.preferred_language ?? NOT_PROVIDED}`, `Occupation/education: ${i.occupation ?? NOT_PROVIDED}`].join("\n") : NOT_PROVIDED,
    referral_source: joinOr(latest("referral_source"), "Referral source"),
    reason_for_referral: joinOr(latest("reason_for_referral"), "Reason for referral"),
    presenting_concerns: joinOr([...latest("presenting_concerns"), ...(iv.presenting?.findings ? [`Interview: ${iv.presenting.findings}`] : [])], "Presenting concerns"),
    personal_history: joinOr([...latest("developmental_history"), ...latest("medical_history"), ...latest("psychological_history")], "Personal, developmental and medical history"),
    previous_treatment: joinOr([...latest("previous_treatment"), ...latest("medication").map((m: string) => `Medication: ${m}`)], "Previous diagnoses, treatment and medication"),
    assessments_administered: administered.length ? administered.map((x) => `- ${x}`).join("\n") : NOT_PROVIDED,
    behavioural_observations: joinOr(latest("observation"), "Psychologist behavioural observations"),
    results: resultLines.length ? resultLines.join("\n") + "\n\nScreening results are not diagnoses." : NOT_PROVIDED,
    interview_findings: ivText || NOT_PROVIDED,
    formulation: joinOr([...latest("formulation"), ...(iv.formulation?.findings ? [iv.formulation.findings] : [])], "Clinical formulation"),
    diagnostic_impressions: iv.impressions ? String(iv.impressions) : (missing.push("Diagnostic impressions (to be entered by the psychologist)"), NOT_PROVIDED),
    recommendations: joinOr(latest("followup"), "Recommendations / follow-up"),
    limitations: "This report is based only on the information and assessments recorded above. Screening questionnaires indicate symptom levels and are not diagnostic. Self-report and observer information may be affected by many factors. Supplementary cognitive tasks are not IQ tests. Conclusions remain the responsibility of the signing psychologist.",
    psychologist: `${psychologistEmail}\n[Name and professional credentials to be confirmed at approval]`,
    approval: "[Pending psychologist review and approval]",
  };
  return { sections, missing };
}

clinical.post("/consultations/:id/report/generate", async (c) => {
  const row = await psychologistOf(c, c.req.param("id"));
  const existing = (await c.var.query("SELECT status FROM psych_reports WHERE consultation_id=$1", [row.id]))[0];
  if (existing?.status === "approved") fail(409, "This report is approved and can no longer be regenerated.");
  const { sections, missing } = buildReport(await collect(c, row.id), String(c.var.user!.email));
  await c.var.query(
    "INSERT INTO psych_reports (consultation_id, sections, missing) VALUES ($1,$2::jsonb,$3::jsonb) ON CONFLICT (consultation_id) DO UPDATE SET sections=EXCLUDED.sections, missing=EXCLUDED.missing, updated_at=now()",
    [row.id, JSON.stringify(sections), JSON.stringify(missing)]);
  await audit(c, row.id, "report_generated");
  return c.json({ ok: true });
});
clinical.get("/consultations/:id/report", async (c) => {
  const row = await psychologistOf(c, c.req.param("id"));
  const r = (await c.var.query("SELECT * FROM psych_reports WHERE consultation_id=$1", [row.id]))[0];
  if (!r) return c.json({ exists: false, order: REPORT_SECTIONS });
  return c.json({ exists: true, order: REPORT_SECTIONS, sections: r.sections, missing: r.missing, status: r.status, approver_name: r.approver_name, approver_credentials: r.approver_credentials, approved_at: iso(r.approved_at), draft_notice: "Draft prepared from recorded data only. It is not a diagnosis. The psychologist must review, edit and approve it." });
});
clinical.put("/consultations/:id/report", async (c) => {
  const row = await psychologistOf(c, c.req.param("id"));
  const r = (await c.var.query("SELECT * FROM psych_reports WHERE consultation_id=$1", [row.id]))[0];
  if (!r) fail(404, "Generate a draft first");
  if (r.status === "approved") fail(409, "An approved report cannot be edited.");
  const b = await readJson(c.req.raw);
  const next: Record<string, string> = { ...r.sections };
  for (const [k] of REPORT_SECTIONS) if ((b.sections as any)?.[k] !== undefined) next[k] = text((b.sections as any)[k], 20000, `sections.${k}`);
  await c.var.query("UPDATE psych_reports SET sections=$1::jsonb, updated_at=now() WHERE consultation_id=$2", [JSON.stringify(next), row.id]);
  await audit(c, row.id, "report_edited");
  return c.json({ ok: true });
});
clinical.post("/consultations/:id/report/approve", async (c) => {
  const row = await psychologistOf(c, c.req.param("id"));
  const r = (await c.var.query("SELECT * FROM psych_reports WHERE consultation_id=$1", [row.id]))[0];
  if (!r) fail(404, "Generate a draft first");
  if (r.status === "approved") fail(409, "This report is already approved.");
  const b = await readJson(c.req.raw);
  const name = text(b.name, 120, "name", true), cred = text(b.credentials, 200, "credentials", true);
  if (b.confirm !== true) validationError([{ loc: ["body", "confirm"], msg: "Confirm that you have reviewed the entire report", type: "value_error" }]);
  const open = await c.var.query("SELECT count(*)::int AS n FROM psych_alerts WHERE consultation_id=$1 AND acknowledged_at IS NULL", [row.id]);
  if (open[0].n > 0) fail(409, "Acknowledge all safety alerts before approving the report.");
  const placeholders = Object.entries(r.sections as Record<string, string>).filter(([k, v]) => !["psychologist", "approval"].includes(k) && (!String(v).trim() || String(v).includes(NOT_PROVIDED)));
  if (placeholders.length && b.acknowledge_gaps !== true) fail(409, `${placeholders.length} section(s) are still empty or marked [Not provided]. Complete them or confirm the gaps.`);
  const sections = { ...r.sections, psychologist: `${name}\n${cred}`, approval: `Approved on ${new Date().toISOString().slice(0, 10)} by ${name}` };
  const upd = await c.var.query("UPDATE psych_reports SET sections=$1::jsonb, status='approved', approver_name=$2, approver_credentials=$3, approved_by=$4, approved_at=now() WHERE consultation_id=$5 AND status='draft' RETURNING consultation_id",
    [JSON.stringify(sections), name, cred, c.var.user!.id, row.id]);
  if (!upd.length) fail(409, "This report is already approved.");
  await audit(c, row.id, "report_approved");
  return c.json({ ok: true });
});

// ---------- observer (no sign-in; the unguessable token is the credential) ----------
export const psychObserver = new Hono<{ Bindings: Env; Variables: AppVars }>();
psychObserver.use("*", ensure as any);
async function inviteFor(c: C) {
  const token = c.req.param("token");
  if (!/^[A-Za-z0-9]{32}$/.test(token)) fail(404, "This link is not valid.");
  const inv = (await c.var.query("SELECT * FROM psych_observer_invites WHERE token_hash=$1", [await sha256(token)]))[0];
  if (!inv || inv.status !== "pending" || new Date(inv.expires_at) < new Date()) fail(404, "This link is not valid or has expired.");
  if (!(await consented(c, inv.consultation_id, ["observer_questionnaire"]))) fail(404, "This link is not valid or has expired."); // consent withdrawn
  return inv;
}
psychObserver.get("/:token", async (c) => {
  const inv = await inviteFor(c);
  return c.json({ ...OBSERVER_FORM, observer_label: inv.observer_label }); // reveals nothing about the patient
});
psychObserver.post("/:token", async (c) => {
  const inv = await inviteFor(c);
  const b = await readJson(c.req.raw);
  const a = b.answers as Record<string, unknown>;
  const answers: Record<string, number> = {};
  for (let i = 0; i < OBSERVER_FORM.items.length; i++) {
    const v = a?.[String(i)];
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 3) validationError([{ loc: ["body", "answers", i], msg: "Answer every question", type: "value_error" }]);
    answers[String(i)] = v as number;
  }
  const comment = text(b.comment, 2000, "comment");
  const r = await c.var.query("UPDATE psych_observer_invites SET status='submitted', submitted_at=now(), answers=$1::jsonb WHERE id=$2 AND status='pending' RETURNING id", [JSON.stringify({ answers, comment }), inv.id]);
  if (!r.length) fail(404, "This link is not valid or has expired.");
  await c.var.query("INSERT INTO psych_audit_log (id, actor_id, consultation_id, action, detail) VALUES ($1,NULL,$2,'observer_submitted',$3::jsonb)", [crypto.randomUUID(), inv.consultation_id, JSON.stringify({ invite_id: inv.id })]);
  return c.json({ ok: true });
});

export { clinical as psychClinical };
