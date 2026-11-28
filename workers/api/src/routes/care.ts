import { Hono } from "hono/tiny";
import { requireUser } from "../auth";
import { audit } from "../audit";
import type { AppVars, DbUser, Env } from "../env";
import { fail, iso, validationError } from "../http";
import { readJson } from "../validate";

type App = Hono<{ Bindings: Env; Variables: AppVars }>;
const newApp = (): App => new Hono<{ Bindings: Env; Variables: AppVars }>();

const PURPOSES = ["terms", "privacy", "ai_processing", "doctor_sharing", "analytics"] as const;
const SCOPES = ["health_records", "reports"] as const;
type Scope = (typeof SCOPES)[number];

// ── Consent management (patients) ────────────────────────────────────────────
export const consents = newApp();
consents.use("*", requireUser);

consents.get("/", async (c) => {
  const rows = await c.var.query(
    "SELECT DISTINCT ON (purpose) purpose, granted, version, created_at FROM consents WHERE user_id = $1 ORDER BY purpose, id DESC",
    [c.var.user!.id],
  );
  return c.json(rows.map((r) => ({ purpose: r.purpose, granted: r.granted, version: r.version, decided_at: iso(r.created_at) })));
});

consents.post("/", async (c) => {
  const b = await readJson(c.req.raw);
  if (typeof b.purpose !== "string" || !PURPOSES.includes(b.purpose as any)) validationError([{ loc: ["body", "purpose"], msg: `purpose must be one of: ${PURPOSES.join(", ")}`, type: "value_error" }]);
  if (typeof b.granted !== "boolean") validationError([{ loc: ["body", "granted"], msg: "granted must be true or false", type: "value_error" }]);
  const version = typeof b.version === "string" && /^[\w.-]{1,20}$/.test(b.version) ? b.version : "1";
  await c.var.query("INSERT INTO consents (user_id, purpose, granted, version) VALUES ($1,$2,$3,$4)", [c.var.user!.id, b.purpose, b.granted, version]);
  await audit(c, c.var.user!.id, b.granted ? "consent_granted" : "consent_withdrawn", { purpose: b.purpose, version });
  if (b.purpose === "doctor_sharing" && b.granted === false) {
    // Withdrawing sharing consent immediately ends every doctor's access.
    await c.var.query("UPDATE access_grants SET revoked_at = now() WHERE patient_id = $1 AND revoked_at IS NULL", [c.var.user!.id]);
  }
  return c.json({ purpose: b.purpose, granted: b.granted, version }, 201);
});

const hasConsent = async (c: { var: AppVars }, userId: string, purpose: string) =>
  (await c.var.query("SELECT granted FROM consents WHERE user_id = $1 AND purpose = $2 ORDER BY id DESC LIMIT 1", [userId, purpose]))[0]?.granted === true;

// ── Patient-managed doctor access grants ─────────────────────────────────────
export const accessGrants = newApp();
accessGrants.use("*", requireUser);

accessGrants.get("/", async (c) => {
  const rows = await c.var.query(
    `SELECT g.id, g.scopes, g.expires_at, g.revoked_at, g.created_at, d.full_name AS doctor_name, d.email AS doctor_email
       FROM access_grants g JOIN users d ON d.id = g.doctor_id WHERE g.patient_id = $1 ORDER BY g.id DESC LIMIT 100`,
    [c.var.user!.id],
  );
  return c.json(rows.map((r) => ({ id: Number(r.id), doctor_name: r.doctor_name, doctor_email: r.doctor_email, scopes: r.scopes, expires_at: iso(r.expires_at), revoked: !!r.revoked_at, created_at: iso(r.created_at) })));
});

accessGrants.post("/", async (c) => {
  const me = c.var.user!;
  const b = await readJson(c.req.raw);
  const email = typeof b.doctor_email === "string" ? b.doctor_email.trim().toLowerCase() : "";
  const scopes = Array.isArray(b.scopes) ? [...new Set(b.scopes)] : [];
  const days = Number.isInteger(b.days) ? (b.days as number) : 30;
  if (!email || !scopes.length || !scopes.every((s) => SCOPES.includes(s as Scope))) validationError([{ loc: ["body", "scopes"], msg: `doctor_email and scopes (${SCOPES.join(", ")}) are required`, type: "value_error" }]);
  if (days < 1 || days > 365) validationError([{ loc: ["body", "days"], msg: "days must be between 1 and 365", type: "value_error" }]);
  if (!(await hasConsent(c, me.id, "doctor_sharing"))) fail(409, "Give 'doctor_sharing' consent before authorising a doctor");
  const d = (await c.var.query("SELECT id FROM users WHERE email = $1 AND role = 'doctor' AND is_active IS NOT FALSE", [email]))[0];
  if (!d || d.id === me.id) fail(404, "No doctor account found for that email");
  const r = (
    await c.var.query(
      "INSERT INTO access_grants (patient_id, doctor_id, scopes, expires_at) VALUES ($1,$2,$3, now() + make_interval(days => $4)) RETURNING id, expires_at",
      [me.id, d!.id, scopes, days],
    )
  )[0];
  await audit(c, me.id, "access_granted", { doctor_id: d!.id, scopes, days });
  return c.json({ id: Number(r.id), scopes, expires_at: iso(r.expires_at) }, 201);
});

accessGrants.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) fail(404, "Not found");
  const rows = await c.var.query("UPDATE access_grants SET revoked_at = now() WHERE id = $1 AND patient_id = $2 AND revoked_at IS NULL RETURNING doctor_id", [id, c.var.user!.id]);
  if (!rows.length) fail(404, "Not found");
  await audit(c, c.var.user!.id, "access_revoked", { grant_id: id, doctor_id: rows[0].doctor_id });
  return c.body(null, 204);
});

// ── Doctor read access: RBAC role + active grant + patient consent, every read audited both ways ──
export const doctor = newApp();
doctor.use("*", requireUser);
doctor.use("*", async (c, next) => {
  if (c.var.user!.role !== "doctor") fail(403, "Doctor access required");
  await next();
});

doctor.get("/patients", async (c) => {
  const rows = await c.var.query(
    `SELECT g.id, g.patient_id, g.scopes, g.expires_at, p.full_name FROM access_grants g JOIN users p ON p.id = g.patient_id
      WHERE g.doctor_id = $1 AND g.revoked_at IS NULL AND g.expires_at > now() ORDER BY g.id DESC LIMIT 200`,
    [c.var.user!.id],
  );
  return c.json(rows.map((r) => ({ grant_id: Number(r.id), patient_id: r.patient_id, patient_name: r.full_name, scopes: r.scopes, expires_at: iso(r.expires_at) })));
});

async function authorised(c: any, patientId: string, scope: Scope): Promise<void> {
  const me = c.var.user as DbUser;
  const ok = (
    await c.var.query(
      "SELECT 1 FROM access_grants WHERE doctor_id = $1 AND patient_id = $2 AND revoked_at IS NULL AND expires_at > now() AND $3 = ANY(scopes) LIMIT 1",
      [me.id, patientId, scope],
    )
  ).length > 0 && (await hasConsent(c, patientId, "doctor_sharing"));
  if (!ok) {
    await audit(c, me.id, "doctor_access_denied", { patient_id: patientId, scope });
    fail(403, "No active authorisation from this patient"); // identical for "no such patient" and "not authorised"
  }
}

async function readScope(c: any, scope: Scope, sql: string) {
  const pid = c.req.param("patient_id");
  await authorised(c, pid, scope);
  const rows = await c.var.query(sql, [pid]);
  const me = c.var.user as DbUser;
  await audit(c, me.id, "doctor_record_access", { patient_id: pid, scope, count: rows.length });
  await audit(c, pid, "record_accessed_by_doctor", { doctor_id: me.id, scope, count: rows.length }); // visible to the patient
  return c.json(rows);
}

doctor.get("/patients/:patient_id/health-records", (c) =>
  readScope(c, "health_records", "SELECT id, record_type, title, data, recorded_at FROM health_records WHERE user_id = $1 ORDER BY recorded_at DESC LIMIT 200"));
doctor.get("/patients/:patient_id/reports", (c) =>
  readScope(c, "reports", "SELECT id, report_type, title, content, data, created_at FROM reports WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200"));

// ── FHIR R4 export of the signed-in patient's own data (portability, not clinical exchange) ──
export const fhir = newApp();
fhir.use("*", requireUser);

const GENDER: Record<string, string> = { male: "male", female: "female", other: "other" };
fhir.get("/me", async (c) => {
  const me = c.var.user!;
  const rows = await c.var.query("SELECT id, record_type, title, data, recorded_at FROM health_records WHERE user_id = $1 ORDER BY recorded_at DESC LIMIT 1000", [me.id]);
  const subject = { reference: `Patient/${me.id}` };
  const text = (t: string) => ({ text: t });
  const entry = (resource: Record<string, unknown>) => ({ resource });
  const resources = rows.map((r) => {
    const base = { id: r.id, text: { status: "generated", div: "<div xmlns=\"http://www.w3.org/1999/xhtml\">Free-text, uncoded record exported from MediCare.</div>" } };
    switch (r.record_type) {
      case "condition": return { resourceType: "Condition", ...base, subject, code: text(r.title), recordedDate: iso(r.recorded_at) };
      case "allergy": return { resourceType: "AllergyIntolerance", ...base, patient: subject, code: text(r.title), recordedDate: iso(r.recorded_at) };
      case "medication": return { resourceType: "MedicationStatement", ...base, status: "unknown", subject, medicationCodeableConcept: text(r.title), dateAsserted: iso(r.recorded_at) };
      default: return { resourceType: "Observation", ...base, status: "unknown", code: text(`${r.record_type}: ${r.title}`), subject, effectiveDateTime: iso(r.recorded_at), valueString: JSON.stringify(r.data ?? {}).slice(0, 2000) };
    }
  });
  await audit(c, me.id, "fhir_export", { count: rows.length });
  return c.json(
    {
      resourceType: "Bundle",
      type: "collection",
      timestamp: new Date().toISOString(),
      entry: [
        entry({
          resourceType: "Patient", id: me.id, active: me.is_active !== false,
          name: me.full_name ? [{ text: me.full_name }] : undefined,
          gender: GENDER[String(me.gender ?? "")] ?? "unknown",
          birthDate: me.date_of_birth ? String(iso(me.date_of_birth as any) ?? "").slice(0, 10) : undefined,
          telecom: [{ system: "email", value: me.email }, ...(me.phone ? [{ system: "phone", value: me.phone }] : [])],
        }),
        ...resources.map(entry),
      ],
    },
    200,
    { "content-type": "application/fhir+json" },
  );
});
