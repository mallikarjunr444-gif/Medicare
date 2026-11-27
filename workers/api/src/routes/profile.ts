import { Hono } from "hono/tiny";
import type { MiddlewareHandler } from "hono";
import { requireUser } from "../auth";
import { verifyFirebaseToken } from "../firebaseAuth";
import type { AppVars, DbUser, Env } from "../env";
import { fail, iso, validationError } from "../http";
import { finish, intParam, readJson } from "../validate";

type App = Hono<{ Bindings: Env; Variables: AppVars }>;
const newApp = (): App => new Hono<{ Bindings: Env; Variables: AppVars }>();

type Err = { loc: (string | number)[]; msg: string; type: string };
const GENDERS = ["female", "male", "non_binary", "other", "prefer_not_to_say"] as const;
const PHONE_RE = /^\+?[0-9][0-9 ()-]{5,18}[0-9]$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const day = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/** The profile as the browser sees it. Never includes password hash, superuser flag or other users' data. */
export const profileOut = (u: DbUser) => ({
  id: u.id,
  firebase_uid: u.firebase_uid ?? null,
  full_name: u.full_name,
  email: u.email,
  photo_url: u.photo_url ?? null,
  phone: u.phone ?? null,
  date_of_birth: day(u.date_of_birth),
  gender: u.gender ?? null,
  is_guest: u.is_guest ?? false,
  created_at: iso(u.created_at),
  updated_at: iso(u.updated_at),
  last_login_at: iso(u.last_login_at),
  email_verified: !!u.email_verified_at,
  mfa_enabled: !!u.mfa_enabled,
});

// ── POST /api/v1/auth/firebase: sign-in / sign-up ────────────────────────────
// The only route that accepts a token for a user that may not exist yet. The UID is taken from the
// verified token and nowhere else; the request body is ignored.
export const authRoutes = newApp();

const usernameFrom = (email: string | null, uid: string) => {
  const base = (email?.split("@")[0] ?? "user").replace(/[^A-Za-z0-9_-]/g, "").replace(/^[-_]+|[-_]+$/g, "").slice(0, 24) || "user";
  return `${base}-${uid.slice(0, 6).replace(/[^A-Za-z0-9]/g, "x")}`;
};

authRoutes.post("/firebase", async (c) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.split(/\s+/, 2)[1]?.trim() : "";
  if (!c.env.FIREBASE_PROJECT_ID) fail(503, "Firebase sign-in is not configured on this deployment");
  const claims = token ? await verifyFirebaseToken(c.env, token) : null;
  if (!claims) fail(401, "Invalid or expired Firebase token", { "WWW-Authenticate": "Bearer" });
  if (!claims!.email || !claims!.emailVerified) fail(403, "A verified email address is required");
  const { uid, email, name, picture } = claims!;
  const q = c.var.query;

  // 1. Returning user: refresh what Google owns (email, photo); keep what the user edited (name, phone, ...).
  let rows = await q(
    `UPDATE users SET email = $2, photo_url = $3, full_name = COALESCE(NULLIF(full_name, ''), $4),
            last_login_at = now(), updated_at = now()
      WHERE firebase_uid = $1 AND is_active RETURNING *`,
    [uid, email, picture, name],
  ).catch(() => []);
  let created = false;

  if (!rows.length) {
    if ((await q("SELECT 1 FROM users WHERE firebase_uid = $1", [uid])).length) fail(403, "Inactive user");
    // 2. Same verified email already has an account: link it. Its password is invalidated so anyone who
    //    pre-registered that address with a password they chose cannot keep access to the real owner's data.
    rows = await q(
      `UPDATE users SET firebase_uid = $1, photo_url = $3, full_name = COALESCE(NULLIF(full_name, ''), $4),
              hashed_password = '*', is_guest = false, last_login_at = now(), updated_at = now()
        WHERE email = $2 AND firebase_uid IS NULL AND is_active RETURNING *`,
      [uid, email, picture, name],
    );
    // 3. First sign-in: create the profile. ON CONFLICT covers two tabs signing in at the same moment.
    if (!rows.length) {
      rows = await q(
        `INSERT INTO users (id, email, username, hashed_password, full_name, is_active, is_superuser, is_guest,
                            firebase_uid, photo_url, last_login_at, updated_at)
         VALUES ($1,$2,$3,'*',$4,true,false,false,$5,$6,now(),now())
         ON CONFLICT DO NOTHING RETURNING *`,
        [crypto.randomUUID(), email, usernameFrom(email, uid), name, uid, picture],
      );
      created = rows.length > 0;
      if (!rows.length) rows = await q("SELECT * FROM users WHERE firebase_uid = $1", [uid]);
    }
  }
  if (!rows.length) fail(409, "Could not create your profile. Please try again.");
  return c.json({ profile: profileOut(rows[0] as DbUser), created }, created ? 201 : 200);
});

// ── /api/v1/profile ──────────────────────────────────────────────────────────
export const profile = newApp();
profile.use("*", requireUser);

profile.get("/", (c) => c.json(profileOut(c.var.user!)));

profile.put("/", async (c) => {
  const body = await readJson(c.req.raw);
  const errs: Err[] = [];
  const sets: string[] = [];
  const params: unknown[] = [c.var.user!.id];
  const set = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  const bad = (field: string, msg: string) => errs.push({ loc: ["body", field], msg, type: "value_error" });

  if ("full_name" in body) {
    const v = body.full_name;
    if (typeof v !== "string" || !v.trim() || v.trim().length > 200) bad("full_name", "Name must be 1 to 200 characters");
    else set("full_name", v.trim());
  }
  if ("phone" in body) {
    const v = body.phone;
    if (v === null || v === "") set("phone", null);
    else if (typeof v !== "string" || !PHONE_RE.test(v.trim())) bad("phone", "Enter a valid phone number, e.g. +91 98765 43210");
    else set("phone", v.trim());
  }
  if ("date_of_birth" in body) {
    const v = body.date_of_birth;
    if (v === null || v === "") set("date_of_birth", null);
    else if (typeof v !== "string" || !DATE_RE.test(v) || Number.isNaN(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) bad("date_of_birth", "Use the format YYYY-MM-DD");
    else if (v < "1900-01-01" || v > new Date().toISOString().slice(0, 10)) bad("date_of_birth", "Date of birth must be between 1900 and today");
    else set("date_of_birth", v);
  }
  if ("gender" in body) {
    const v = body.gender;
    if (v === null || v === "") set("gender", null);
    else if (typeof v !== "string" || !(GENDERS as readonly string[]).includes(v)) bad("gender", `Gender must be one of: ${GENDERS.join(", ")}`);
    else set("gender", v);
  }
  finish(errs);
  if (!sets.length) return c.json(profileOut(c.var.user!));
  const rows = await c.var.query(`UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`, params);
  return c.json(profileOut(rows[0] as DbUser));
});

// Saved consultations for the signed-in user only (sessions.user_id is the owner).
profile.get("/consultations", async (c) => {
  const skip = intParam(c.req.query("skip"), 0, 0, 1_000_000, "skip");
  const limit = intParam(c.req.query("limit"), 30, 1, 100, "limit");
  const rows = await c.var.query(
    `SELECT s.id, s.status, s.started_at, s.ended_at,
            a.name AS doctor_name, a.avatar_metadata->>'doctor_id' AS doctor_id,
            (SELECT count(*)::int FROM messages m WHERE m.session_id = s.id) AS message_count,
            (SELECT cv.title FROM conversations cv WHERE cv.session_id = s.id ORDER BY cv.created_at DESC LIMIT 1) AS title,
            (SELECT cv.summary FROM conversations cv WHERE cv.session_id = s.id ORDER BY cv.created_at DESC LIMIT 1) AS summary,
            cr.triage_level, cr.duration_seconds, (cr.id IS NOT NULL) AS has_report
       FROM sessions s
       JOIN avatars a ON a.id = s.avatar_id
       LEFT JOIN consultation_reports cr ON cr.session_id = s.id AND cr.user_id = s.user_id
      WHERE s.user_id = $1
      ORDER BY s.started_at DESC OFFSET $2 LIMIT $3`,
    [c.var.user!.id, skip, limit],
  );
  return c.json(
    rows.map((r) => ({
      id: r.id, status: r.status, doctor_name: r.doctor_name, doctor_id: r.doctor_id ?? null,
      title: r.title ?? null, summary: r.summary ?? null, message_count: r.message_count ?? 0,
      triage_level: r.triage_level ?? null, duration_seconds: r.duration_seconds ?? null, has_report: Boolean(r.has_report),
      started_at: iso(r.started_at), ended_at: iso(r.ended_at),
    })),
  );
});

// ── health records and reports: same shape, always filtered by the verified user ──
const RECORD_TYPES = ["condition", "allergy", "medication", "vital", "immunization", "lab", "note", "other"];
const REPORT_TYPES = ["lab", "imaging", "summary", "other"];

function ownedCrud(opts: {
  table: "health_records" | "reports";
  typeCol: "record_type" | "report_type";
  types: string[];
  orderCol: string;
  extra: (b: Record<string, unknown>, errs: Err[]) => { cols: string[]; vals: unknown[] };
  out: (r: Record<string, any>) => Record<string, unknown>;
  /** Runs after authentication and before every handler. */
  guard?: MiddlewareHandler<{ Bindings: Env; Variables: AppVars }>;
}): App {
  const app = newApp();
  app.use("*", requireUser);
  if (opts.guard) app.use("*", opts.guard);
  const { table, typeCol, types, orderCol } = opts;

  const parse = (b: Record<string, unknown>, partial: boolean) => {
    const errs: Err[] = [];
    const cols: string[] = [];
    const vals: unknown[] = [];
    const add = (c: string, v: unknown) => { cols.push(c); vals.push(v); };
    if (!partial || "title" in b) {
      if (typeof b.title !== "string" || !b.title.trim() || b.title.length > 200) errs.push({ loc: ["body", "title"], msg: "Title must be 1 to 200 characters", type: "string_length" });
      else add("title", b.title.trim());
    }
    if (!partial || typeCol in b) {
      const t = b[typeCol] ?? types[0];
      if (typeof t !== "string" || !types.includes(t)) errs.push({ loc: ["body", typeCol], msg: `Must be one of: ${types.join(", ")}`, type: "enum" });
      else add(typeCol, t);
    }
    const x = opts.extra(b, errs);
    x.cols.forEach((c, i) => add(c, x.vals[i]));
    finish(errs);
    return { cols, vals };
  };

  app.get("/", async (c) => {
    const skip = intParam(c.req.query("skip"), 0, 0, 1_000_000, "skip");
    const limit = intParam(c.req.query("limit"), 50, 1, 200, "limit");
    const rows = await c.var.query(`SELECT * FROM ${table} WHERE user_id = $1 ORDER BY ${orderCol} DESC OFFSET $2 LIMIT $3`, [c.var.user!.id, skip, limit]);
    return c.json(rows.map(opts.out));
  });

  app.post("/", async (c) => {
    const { cols, vals } = parse(await readJson(c.req.raw), false);
    // user_id always comes from the verified token, never from the body.
    const all = ["id", "user_id", ...cols];
    const params = [crypto.randomUUID(), c.var.user!.id, ...vals];
    const ph = all.map((col, i) => (col === "data" ? `$${i + 1}::jsonb` : `$${i + 1}`));
    const rows = await c.var.query(`INSERT INTO ${table} (${all.join(",")}) VALUES (${ph.join(",")}) RETURNING *`, params);
    return c.json(opts.out(rows[0]), 201);
  });

  app.get("/:id", async (c) => {
    const r = (await c.var.query(`SELECT * FROM ${table} WHERE id = $1 AND user_id = $2`, [c.req.param("id"), c.var.user!.id]))[0];
    if (!r) fail(404, "Not found"); // same answer for "missing" and "someone else's"
    return c.json(opts.out(r!));
  });

  app.put("/:id", async (c) => {
    const { cols, vals } = parse(await readJson(c.req.raw), true);
    if (!cols.length) validationError([{ loc: ["body"], msg: "Nothing to update", type: "value_error" }]);
    const sets = cols.map((col, i) => `${col} = $${i + 3}${col === "data" ? "::jsonb" : ""}`);
    const rows = await c.var.query(
      `UPDATE ${table} SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *`,
      [c.req.param("id"), c.var.user!.id, ...vals],
    );
    if (!rows.length) fail(404, "Not found");
    return c.json(opts.out(rows[0]));
  });

  app.delete("/:id", async (c) => {
    const rows = await c.var.query(`DELETE FROM ${table} WHERE id = $1 AND user_id = $2 RETURNING id`, [c.req.param("id"), c.var.user!.id]);
    if (!rows.length) fail(404, "Not found");
    return c.body(null, 204);
  });

  return app;
}

const jsonData = (b: Record<string, unknown>, errs: Err[]): unknown[] => {
  if (!("data" in b)) return [];
  const d = b.data;
  if (d === null || typeof d !== "object" || Array.isArray(d) || JSON.stringify(d).length > 20_000) {
    errs.push({ loc: ["body", "data"], msg: "data must be an object under 20 KB", type: "value_error" });
    return [];
  }
  return [JSON.stringify(d)];
};

export const healthRecords = ownedCrud({
  table: "health_records", typeCol: "record_type", types: RECORD_TYPES, orderCol: "recorded_at",
  extra: (b, errs) => {
    const cols: string[] = [];
    const vals: unknown[] = [];
    const d = jsonData(b, errs);
    if (d.length) { cols.push("data"); vals.push(d[0]); }
    if ("recorded_at" in b) {
      if (typeof b.recorded_at !== "string" || Number.isNaN(Date.parse(b.recorded_at))) errs.push({ loc: ["body", "recorded_at"], msg: "Must be an ISO date-time", type: "value_error" });
      else { cols.push("recorded_at"); vals.push(new Date(b.recorded_at).toISOString()); }
    }
    return { cols, vals };
  },
  out: (r) => ({ id: r.id, record_type: r.record_type, title: r.title, data: r.data ?? {}, recorded_at: iso(r.recorded_at), created_at: iso(r.created_at), updated_at: iso(r.updated_at) }),
});

// A report may only be attached to one of the caller's own consultations.
const ownSessionGuard: MiddlewareHandler<{ Bindings: Env; Variables: AppVars }> = async (c, next) => {
  if (c.req.method === "POST" || c.req.method === "PUT") {
    const b = await c.req.raw.clone().json().catch(() => ({}));
    const sid = (b as Record<string, unknown>)?.session_id;
    if (typeof sid === "string") {
      const own = await c.var.query("SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2", [sid, c.var.user!.id]);
      if (!own.length) fail(404, "Session not found");
    }
  }
  await next();
};

export const reportsRoutes = ownedCrud({
  table: "reports", typeCol: "report_type", types: REPORT_TYPES, orderCol: "created_at", guard: ownSessionGuard,
  extra: (b, errs) => {
    const cols: string[] = [];
    const vals: unknown[] = [];
    if ("content" in b) {
      if (b.content !== null && (typeof b.content !== "string" || b.content.length > 50_000)) errs.push({ loc: ["body", "content"], msg: "content must be text under 50,000 characters", type: "string_length" });
      else { cols.push("content"); vals.push(b.content); }
    }
    if ("session_id" in b && b.session_id !== null) {
      if (typeof b.session_id !== "string") errs.push({ loc: ["body", "session_id"], msg: "Must be a string", type: "string_type" });
      else { cols.push("session_id"); vals.push(b.session_id); }
    }
    const d = jsonData(b, errs);
    if (d.length) { cols.push("data"); vals.push(d[0]); }
    return { cols, vals };
  },
  out: (r) => ({ id: r.id, session_id: r.session_id ?? null, report_type: r.report_type, title: r.title, content: r.content ?? null, data: r.data ?? {}, created_at: iso(r.created_at), updated_at: iso(r.updated_at) }),
});
