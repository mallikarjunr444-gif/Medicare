import { Hono } from "hono/tiny";
import { BCRYPT_COST, clearAuthCookie, requireUser } from "../auth";
import { audit } from "../audit";
import { randomToken, sha256Hex } from "../crypto";
import type { AppVars, DbUser, Env } from "../env";
import { fail } from "../http";
import { appUrl, sendMail } from "../mailer";
import { clientIp, throttleBlocked, throttleHit } from "../security";
import { checkEmail, checkPassword, finish, readJson } from "../validate";
import { mfa, verifySecondFactor } from "./mfa";
import { sendVerificationEmail, userOut } from "./users";

export const account = new Hono<{ Bindings: Env; Variables: AppVars }>();
account.route("/me/mfa", mfa);

const GENERIC = { detail: "If that address has an account, a message has been sent." };

// ── Email verification ───────────────────────────────────────────────────────
account.post("/request-verification", requireUser, async (c) => {
  const me = c.var.user!;
  if (me.email_verified_at) return c.json({ detail: "Email already verified", sent: false });
  if (await throttleBlocked(c.var.query, `verify|${me.id}`, 3)) return c.json({ detail: "Too many requests. Try again later." }, 429, { "Retry-After": "3600" });
  await throttleHit(c.var.query, `verify|${me.id}`, 3600);
  const sent = await sendVerificationEmail(c, me);
  return c.json({ detail: sent ? "Verification email sent" : "Email delivery is not configured on this deployment", sent });
});

account.post("/verify-email", async (c) => {
  const body = await readJson(c.req.raw);
  const token = typeof body.token === "string" ? body.token : "";
  if (token.length < 20 || token.length > 200) fail(400, "Invalid or expired link");
  const rows = await c.var.query(
    `UPDATE auth_tokens SET used_at = now()
      WHERE token_hash = $1 AND kind = 'verify_email' AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
    [await sha256Hex(token)],
  );
  if (!rows.length) fail(400, "Invalid or expired link");
  await c.var.query("UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL", [rows[0].user_id]);
  await audit(c, rows[0].user_id as string, "email_verified");
  return c.json({ detail: "Email verified" });
});

// ── Password reset ───────────────────────────────────────────────────────────
account.post("/forgot-password", async (c) => {
  const body = await readJson(c.req.raw);
  const errs: any[] = [];
  const email = checkEmail(body.email, errs);
  finish(errs);
  const q = c.var.query;
  const key = `forgot|${clientIp(c)}|${email}`;
  // Same response whether or not the account exists, and whether or not we are throttled (no enumeration).
  if (await throttleBlocked(q, key, 3)) return c.json(GENERIC);
  await throttleHit(q, key, 3600);
  const u = (await q("SELECT id, email, is_active, is_guest, hashed_password FROM users WHERE email = $1", [email]))[0] as DbUser | undefined;
  if (u && u.is_active && !u.is_guest && u.hashed_password?.startsWith("$2")) {
    const token = randomToken();
    await q("DELETE FROM auth_tokens WHERE user_id = $1 AND kind = 'reset_password'", [u.id]);
    await q("INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at) VALUES ($1,'reset_password',$2, now() + interval '1 hour')", [u.id, await sha256Hex(token)]);
    await sendMail(c.env, {
      to: u.email,
      subject: "Reset your MediCare password",
      text: `Use this link to choose a new password:\n${appUrl(c.env)}/#reset=${token}\n\nIt expires in 1 hour and works once. If you did not ask for this, ignore this message; your password has not changed.`,
    });
    await audit(c, u.id, "password_reset_requested");
  }
  return c.json(GENERIC);
});

account.post("/reset-password", async (c) => {
  const body = await readJson(c.req.raw);
  const errs: any[] = [];
  const password = checkPassword(body.password, errs);
  finish(errs);
  const token = typeof body.token === "string" ? body.token : "";
  const q = c.var.query;
  const key = `reset|${clientIp(c)}`;
  if (await throttleBlocked(q, key, 10)) return c.json({ detail: "Too many attempts. Try again later." }, 429, { "Retry-After": "900" });
  if (token.length < 20 || token.length > 200) {
    await throttleHit(q, key, 900);
    fail(400, "Invalid or expired link");
  }
  // Atomic single-use claim: a token can never be redeemed twice, even concurrently.
  const claimed = await q(
    `UPDATE auth_tokens SET used_at = now()
      WHERE token_hash = $1 AND kind = 'reset_password' AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
    [await sha256Hex(token)],
  );
  if (!claimed.length) {
    await throttleHit(q, key, 900);
    fail(400, "Invalid or expired link");
  }
  const uid = claimed[0].user_id as string;
  await q(
    `UPDATE users SET hashed_password = crypt($2, gen_salt('bf', ${BCRYPT_COST})),
            token_version = token_version + 1,
            email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
      WHERE id = $1`,
    [uid, password],
  );
  await q("DELETE FROM auth_tokens WHERE user_id = $1 AND kind = 'reset_password'", [uid]);
  await audit(c, uid, "password_reset_completed");
  clearAuthCookie(c);
  return c.json({ detail: "Password updated. Please sign in again." });
});

// ── One-time WebSocket ticket (keeps long-lived tokens out of URLs) ──────────
account.post("/ws-ticket", requireUser, async (c) => {
  const me = c.var.user!;
  const ticket = randomToken(24);
  await c.var.query("DELETE FROM auth_tokens WHERE kind = 'ws_ticket' AND expires_at < now()");
  await c.var.query("INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at) VALUES ($1,'ws_ticket',$2, now() + interval '60 seconds')", [me.id, await sha256Hex(ticket)]);
  return c.json({ ticket, expires_in: 60 });
});

// ── Audit trail, export, deletion ────────────────────────────────────────────
account.get("/me/audit", requireUser, async (c) => {
  const rows = await c.var.query("SELECT action, ip, detail, created_at FROM audit_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50", [c.var.user!.id]);
  return c.json(rows);
});

/** Everything we hold about the signed-in user, as a JSON download. Strictly scoped by user_id. */
account.get("/me/export", requireUser, async (c) => {
  const me = c.var.user!;
  const q = c.var.query;
  const one = (sql: string) => q(sql, [me.id]).catch(() => [] as Record<string, any>[]);
  const [profile, health, reports, sessions, messages, conversations, consults, avatars, auditRows] = await Promise.all([
    one("SELECT id, email, username, full_name, phone, date_of_birth, gender, photo_url, created_at, last_login_at, email_verified_at, mfa_enabled FROM users WHERE id = $1"),
    one("SELECT id, record_type, title, data, recorded_at, created_at FROM health_records WHERE user_id = $1 ORDER BY recorded_at DESC"),
    one("SELECT id, report_type, title, content, data, created_at FROM reports WHERE user_id = $1 ORDER BY created_at DESC"),
    one("SELECT id, avatar_id, status, settings, started_at, ended_at FROM sessions WHERE user_id = $1 ORDER BY started_at DESC"),
    one("SELECT m.id, m.session_id, m.role, m.content, m.created_at FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.user_id = $1 ORDER BY m.created_at"),
    one("SELECT c.id, c.session_id, c.title, c.summary, c.created_at FROM conversations c JOIN sessions s ON s.id = c.session_id WHERE s.user_id = $1"),
    one("SELECT id, session_id, doctor_id, language, triage_level, duration_seconds, report, created_at FROM consultation_reports WHERE user_id = $1"),
    one("SELECT id, name, status, created_at FROM avatars WHERE user_id = $1"),
    one("SELECT action, ip, created_at FROM audit_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1000"),
  ]);
  await audit(c, me.id, "data_export");
  return new Response(
    JSON.stringify({ exported_at: new Date().toISOString(), profile: profile[0] ?? userOut(me), health_records: health, reports, sessions, messages, conversations, consultation_reports: consults, avatars, audit_log: auditRows }, null, 2),
    { headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="medicare-data-export.json"', "cache-control": "no-store" } },
  );
});

/** Permanently deletes the account and every row owned by it. Requires explicit confirmation + credentials. */
account.delete("/me", requireUser, async (c) => {
  const me = c.var.user!;
  const body = await readJson(c.req.raw);
  if (body.confirm !== "DELETE") fail(400, 'Send {"confirm":"DELETE"} to confirm permanent deletion');
  const q = c.var.query;
  if (me.hashed_password?.startsWith("$2")) {
    const ok = typeof body.password === "string" && (await q(
      `SELECT (regexp_replace(hashed_password, '^[$]2[by][$]', '$2a$') = crypt($2, regexp_replace(hashed_password, '^[$]2[by][$]', '$2a$'))) AS ok FROM users WHERE id = $1`,
      [me.id, body.password],
    ))[0]?.ok === true;
    if (!ok) {
      await audit(c, me.id, "account_delete_denied");
      fail(403, "Password is required and must be correct");
    }
    if (me.mfa_enabled && !(typeof body.code === "string" && (await verifySecondFactor(c, me, body.code)))) fail(403, "A valid MFA or recovery code is required");
  }
  try {
    // One statement = atomic. Clinical links where the patient is only referenced are detached, not blocked.
    await q("WITH d AS (UPDATE psych_consultations SET patient_id = NULL WHERE patient_id = $1) DELETE FROM users WHERE id = $1", [me.id]);
  } catch (e) {
    const msg = String((e as Error)?.message);
    if (/psych_consultations/i.test(msg) && /does not exist/i.test(msg)) {
      await q("DELETE FROM users WHERE id = $1", [me.id]);
    } else if (/foreign key|violates/i.test(msg)) {
      fail(409, "This account holds clinical or staff records that must be handed over first. Contact support.");
    } else throw e;
  }
  await audit(c, me.id, "account_deleted");
  clearAuthCookie(c);
  return c.json({ detail: "Account and personal data deleted" });
});
