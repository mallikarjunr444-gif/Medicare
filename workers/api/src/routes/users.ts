import { Hono } from "hono/tiny";
import {
  BCRYPT_COST, claimsFromToken, clearAuthCookie, createAccessToken, requireUser, setAuthCookie, tokenFromRequest,
} from "../auth";
import type { AppVars, DbUser, Env } from "../env";
import { fail, iso } from "../http";
import {
  LOGIN_MAX_PER_ACCOUNT, LOGIN_MAX_PER_IP_ACCOUNT, LOGIN_RETRY_AFTER_S, clientIp, throttleBlocked, throttleClear, throttleHit,
} from "../security";
import { audit } from "../audit";
import { verifySecondFactor } from "./mfa";
import { appUrl, sendMail } from "../mailer";
import { randomToken, sha256Hex } from "../crypto";
import { checkEmail, checkOptionalName, checkPassword, checkUsername, finish, intParam, readJson } from "../validate";

export const users = new Hono<{ Bindings: Env; Variables: AppVars }>();

/** UserResponse: password hash and superuser flag are never exposed. */
export const userOut = (u: DbUser) => ({
  email: u.email,
  username: u.username,
  full_name: u.full_name,
  id: u.id,
  is_active: u.is_active,
  is_guest: u.is_guest ?? false,
  created_at: iso(u.created_at),
  email_verified: !!u.email_verified_at,
  mfa_enabled: !!u.mfa_enabled,
});

users.post("/register", async (c) => {
  const body = await readJson(c.req.raw);
  const errs: any[] = [];
  const email = checkEmail(body.email, errs);
  const username = checkUsername(body.username, errs);
  const fullName = checkOptionalName(body.full_name, errs);
  const password = checkPassword(body.password, errs);
  finish(errs);

  const q = c.var.query;
  if ((await q("SELECT 1 FROM users WHERE email = $1", [email])).length) fail(409, "Email already registered");
  if ((await q("SELECT 1 FROM users WHERE username = $1", [username])).length) fail(409, "Username already taken");

  const rows = await q(
    `INSERT INTO users (id, email, username, hashed_password, full_name, is_active, is_superuser, is_guest)
     VALUES ($1,$2,$3,crypt($4, gen_salt('bf', ${BCRYPT_COST})),$5,true,false,false) RETURNING *`,
    [crypto.randomUUID(), email, username, password, fullName ?? null],
  );
  const created = rows[0] as DbUser;
  await audit(c, created.id, "register");
  await sendVerificationEmail(c, created); // best effort; registration never fails because email is down
  return c.json(userOut(created), 201);
});

/** Creates a 24 h single-use verification token and emails the link (token travels in the URL fragment). */
export async function sendVerificationEmail(c: { env: Env; var: AppVars }, u: DbUser): Promise<boolean> {
  try {
    const token = randomToken();
    await c.var.query("DELETE FROM auth_tokens WHERE user_id = $1 AND kind = 'verify_email'", [u.id]);
    await c.var.query(
      "INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at) VALUES ($1,'verify_email',$2, now() + interval '24 hours')",
      [u.id, await sha256Hex(token)],
    );
    return await sendMail(c.env, {
      to: u.email,
      subject: "Verify your MediCare email",
      text: `Confirm your email address:\n${appUrl(c.env)}/#verify=${token}\n\nThis link expires in 24 hours. If you did not create an account, ignore this message.`,
    });
  } catch {
    return false;
  }
}

users.post("/login", async (c) => {
  // OAuth2 password form: application/x-www-form-urlencoded username + password
  const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
  const username = typeof form.username === "string" ? form.username : "";
  const password = typeof form.password === "string" ? form.password : "";
  if (!username || (!password && form.password === undefined)) {
    return c.json({ detail: [{ loc: ["body", "username"], msg: "Field required", type: "missing" }] }, 422);
  }
  const email = username.trim().toLowerCase();
  // Durable brute-force throttle (per IP+account and per account), checked before any bcrypt work.
  const ipKey = `login|${clientIp(c)}|${email}`;
  const acctKey = `login|acct|${email}`;
  const q0 = c.var.query;
  if ((await throttleBlocked(q0, ipKey, LOGIN_MAX_PER_IP_ACCOUNT)) || (await throttleBlocked(q0, acctKey, LOGIN_MAX_PER_ACCOUNT))) {
    await audit(c, null, "login_blocked");
    return c.json({ detail: "Too many failed sign-in attempts. Try again later." }, 429, { "Retry-After": String(LOGIN_RETRY_AFTER_S) });
  }
  // Verified in Postgres. Python writes `$2b$` hashes; pgcrypto wants `$2a$`
  // (identical for passwords under 255 bytes), so normalise the prefix. Non-bcrypt
  // hashes (e.g. the guest "*") never match.
  const user = (
    await c.var.query(
      `SELECT *, (hashed_password LIKE '$2%' AND
                  regexp_replace(hashed_password, '^[$]2[by][$]', '$2a$') =
                  crypt($2, regexp_replace(hashed_password, '^[$]2[by][$]', '$2a$'))) AS pw_ok
         FROM users WHERE email = $1`,
      [email, password],
    )
  )[0] as (DbUser & { pw_ok: boolean }) | undefined;

  if (!password || !user || !user.hashed_password || !user.pw_ok) {
    await throttleHit(q0, ipKey);
    await throttleHit(q0, acctKey);
    await audit(c, user?.id ?? null, "login_failed");
    fail(401, "Incorrect email or password", { "WWW-Authenticate": "Bearer" });
  }
  if (!user!.is_active) fail(403, "Inactive user");

  if (user!.mfa_enabled) {
    const otp = typeof form.otp === "string" ? form.otp.trim() : "";
    if (!otp) fail(403, "mfa_required");
    if (!(await verifySecondFactor(c, user!, otp))) {
      await throttleHit(q0, ipKey);
      await throttleHit(q0, acctKey);
      await audit(c, user!.id, "mfa_failed");
      fail(401, "Invalid verification code", { "WWW-Authenticate": "Bearer" });
    }
  }
  await throttleClear(q0, ipKey);
  await audit(c, user!.id, "login_success", { mfa: !!user!.mfa_enabled });
  const token = await createAccessToken(c.env, user!.id, user!.token_version ?? 0);
  setAuthCookie(c, token);
  return c.json({ access_token: token, token_type: "bearer" });
});

users.post("/guest", async (c) => {
  if (c.env.GUEST_ACCOUNTS_ENABLED !== "true") fail(403, "Guest access is disabled on this deployment");
  const marker = crypto.randomUUID().replaceAll("-", "");
  const id = `guest-${marker}`;
  await c.var.query(
    `INSERT INTO users (id, email, username, hashed_password, full_name, is_active, is_superuser, is_guest)
     VALUES ($1,$2,$3,'*','Guest',true,false,true)`,
    [id, `guest-${marker}@guests.example.com`, `guest-${marker.slice(0, 12)}`],
  );
  const token = await createAccessToken(c.env, id, 0);
  setAuthCookie(c, token);
  return c.json({ access_token: token, token_type: "bearer" }, 201);
});

users.post("/logout", async (c) => {
  // Revoke this token server-side (not just the cookie), so a copied token stops working immediately.
  const t = tokenFromRequest(c);
  const claims = t ? await claimsFromToken(c.env, t) : null;
  if (claims?.jti) {
    try {
      await c.var.query("DELETE FROM revoked_tokens WHERE expires_at < now()");
      await c.var.query(
        "INSERT INTO revoked_tokens (jti, expires_at) VALUES ($1, to_timestamp($2)) ON CONFLICT DO NOTHING",
        [claims.jti, claims.exp],
      );
      await audit(c, claims.sub, "logout");
    } catch {
      console.error("revoke_failed");
    }
  }
  clearAuthCookie(c);
  return c.json({ detail: "Logged out" });
});

/** Sign out everywhere: invalidates every token issued so far for this account. */
users.post("/logout-all", requireUser, async (c) => {
  const me = c.var.user!;
  await c.var.query("UPDATE users SET token_version = token_version + 1 WHERE id = $1", [me.id]);
  await audit(c, me.id, "logout_all");
  clearAuthCookie(c);
  return c.json({ detail: "Signed out on all devices" });
});

users.get("/me", requireUser, (c) => c.json(userOut(c.var.user!)));

users.put("/me", requireUser, async (c) => {
  const me = c.var.user!;
  const body = await readJson(c.req.raw);
  const errs: any[] = [];
  const email = body.email != null ? checkEmail(body.email, errs) : undefined;
  const username = body.username != null ? checkUsername(body.username, errs) : undefined;
  const fullName = checkOptionalName(body.full_name, errs);
  const password = body.password != null ? checkPassword(body.password, errs) : undefined;
  finish(errs);

  const q = c.var.query;
  if (password !== undefined || (email !== undefined && email !== me.email)) {
    // Changing credentials requires proof of the current password (accounts that have one).
    const hasPw = typeof me.hashed_password === "string" && me.hashed_password.startsWith("$2");
    if (hasPw) {
      const cur = typeof body.current_password === "string" ? body.current_password : "";
      const ok = cur
        ? (await q(
            `SELECT (regexp_replace(hashed_password, '^[$]2[by][$]', '$2a$') = crypt($2, regexp_replace(hashed_password, '^[$]2[by][$]', '$2a$'))) AS ok FROM users WHERE id = $1`,
            [me.id, cur],
          ))[0]?.ok === true
        : false;
      if (!ok) {
        await audit(c, me.id, "credential_change_denied");
        fail(403, "Current password is required and must be correct");
      }
    }
  }
  if (email !== undefined && (await q("SELECT 1 FROM users WHERE email = $1 AND id <> $2", [email, me.id])).length)
    fail(409, "Email already registered");
  if (username !== undefined && (await q("SELECT 1 FROM users WHERE username = $1 AND id <> $2", [username, me.id])).length)
    fail(409, "Username already taken");

  const rows = await q(
    `UPDATE users SET
       email = COALESCE($2, email),
       username = COALESCE($3, username),
       full_name = COALESCE($4, full_name),
       hashed_password = COALESCE(crypt($5, gen_salt('bf', ${BCRYPT_COST})), hashed_password),
       email_verified_at = CASE WHEN $2::varchar IS NOT NULL AND $2::varchar <> email THEN NULL ELSE email_verified_at END,
       token_version = token_version + CASE WHEN $5::text IS NOT NULL THEN 1 ELSE 0 END,
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [me.id, email ?? null, username ?? null, fullName ?? null, password ?? null],
  );
  const updated = rows[0] as DbUser;
  if (password !== undefined) {
    // A password change signs every other session out; keep this one alive with a fresh token.
    await audit(c, me.id, "password_changed");
    const fresh = await createAccessToken(c.env, me.id, updated.token_version ?? 0);
    setAuthCookie(c, fresh);
    return c.json({ ...userOut(updated), access_token: fresh });
  }
  if (email !== undefined && email !== me.email) await audit(c, me.id, "email_changed");
  return c.json(userOut(updated));
});

users.get("/", requireUser, async (c) => {
  if (!c.var.user!.is_superuser) fail(403, "Not authorized");
  const skip = intParam(c.req.query("skip"), 0, 0, 1_000_000, "skip");
  const limit = Math.min(intParam(c.req.query("limit"), 100, 0, 1_000_000, "limit"), 200);
  const rows = await c.var.query("SELECT * FROM users OFFSET $1 LIMIT $2", [skip, limit]);
  return c.json(rows.map((r) => userOut(r as DbUser)));
});

users.get("/:user_id", requireUser, async (c) => {
  const id = c.req.param("user_id");
  const me = c.var.user!;
  if (me.id !== id && !me.is_superuser) fail(403, "Not authorized");
  const row = (await c.var.query("SELECT * FROM users WHERE id = $1", [id]))[0] as DbUser | undefined;
  if (!row) fail(404, "User not found");
  return c.json(userOut(row!));
});
