import { Hono } from "hono/tiny";
import type { Context } from "hono";
import { requireUser } from "../auth";
import { audit } from "../audit";
import { decryptSecret, encryptSecret, sha256Hex } from "../crypto";
import type { AppVars, DbUser, Env } from "../env";
import { fail } from "../http";
import { newRecoveryCodes, newTotpSecret, normalizeRecovery, otpauthUri, verifyTotp } from "../totp";
import { readJson } from "../validate";

type C = Context<{ Bindings: Env; Variables: AppVars }>;
const keyOf = (env: Env) => env.MFA_ENC_KEY || env.JWT_SECRET_KEY;

/** Accepts a 6-digit TOTP (each time step usable once) or an unused recovery code (single use). */
export async function verifySecondFactor(c: { env: Env; var: AppVars }, user: DbUser, input: string): Promise<boolean> {
  const q = c.var.query;
  const code = input.trim();
  if (/^\d{6}$/.test(code)) {
    if (!user.mfa_secret_enc) return false;
    const secret = await decryptSecret(keyOf(c.env), user.mfa_secret_enc);
    if (!secret) return false;
    const step = await verifyTotp(secret, code);
    if (step === null) return false;
    // Replay protection: the step must be newer than the last accepted one (atomic).
    const rows = await q(
      "UPDATE users SET mfa_last_step = $2 WHERE id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2) RETURNING id",
      [user.id, step],
    );
    return rows.length === 1;
  }
  const hash = await sha256Hex(normalizeRecovery(code));
  const rows = await q(
    "UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id",
    [user.id, hash],
  );
  return rows.length === 1;
}

async function passwordOk(c: C, user: DbUser, password: unknown): Promise<boolean> {
  if (typeof password !== "string" || !password) return false;
  const r = await c.var.query(
    `SELECT (hashed_password LIKE '$2%' AND regexp_replace(hashed_password, '^[$]2[by][$]', '$2a$') = crypt($2, regexp_replace(hashed_password, '^[$]2[by][$]', '$2a$'))) AS ok FROM users WHERE id = $1`,
    [user.id, password],
  );
  return r[0]?.ok === true;
}

export const mfa = new Hono<{ Bindings: Env; Variables: AppVars }>();

/** Step 1: create a pending secret (not active until confirmed). Requires the account to have a real password. */
mfa.post("/setup", requireUser, async (c) => {
  const me = c.var.user!;
  if (me.is_guest || !me.hashed_password?.startsWith("$2")) fail(403, "MFA is available for email/password accounts only");
  if (me.mfa_enabled) fail(409, "MFA is already enabled");
  const body = await readJson(c.req.raw);
  if (!(await passwordOk(c, me, body.password))) fail(403, "Password is required and must be correct");
  const secret = newTotpSecret();
  await c.var.query("UPDATE users SET mfa_secret_enc = $2, mfa_last_step = NULL WHERE id = $1", [me.id, await encryptSecret(keyOf(c.env), secret)]);
  return c.json({ secret, otpauth_uri: otpauthUri(secret, me.email) });
});

/** Step 2: prove the authenticator works, then activate and return one-time recovery codes. */
mfa.post("/enable", requireUser, async (c) => {
  const me = c.var.user!;
  if (me.mfa_enabled) fail(409, "MFA is already enabled");
  if (!me.mfa_secret_enc) fail(409, "Start MFA setup first");
  const body = await readJson(c.req.raw);
  const secret = await decryptSecret(keyOf(c.env), me.mfa_secret_enc!);
  const step = secret && typeof body.code === "string" ? await verifyTotp(secret, body.code.trim()) : null;
  if (step === null) {
    await audit(c, me.id, "mfa_enable_failed");
    fail(403, "Invalid verification code");
  }
  const codes = newRecoveryCodes();
  await c.var.query("DELETE FROM mfa_recovery_codes WHERE user_id = $1", [me.id]);
  for (const code of codes) {
    await c.var.query("INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1,$2)", [me.id, await sha256Hex(normalizeRecovery(code))]);
  }
  await c.var.query(
    "UPDATE users SET mfa_enabled = true, mfa_last_step = $2, token_version = token_version + 1 WHERE id = $1",
    [me.id, step],
  );
  await audit(c, me.id, "mfa_enabled");
  return c.json({ detail: "MFA enabled. Other sessions were signed out.", recovery_codes: codes });
});

mfa.post("/disable", requireUser, async (c) => {
  const me = c.var.user!;
  if (!me.mfa_enabled) fail(409, "MFA is not enabled");
  const body = await readJson(c.req.raw);
  const ok = (await passwordOk(c, me, body.password)) && typeof body.code === "string" && (await verifySecondFactor(c, me, body.code));
  if (!ok) {
    await audit(c, me.id, "mfa_disable_denied");
    fail(403, "Password and a valid MFA or recovery code are required");
  }
  await c.var.query("UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL, mfa_last_step = NULL, token_version = token_version + 1 WHERE id = $1", [me.id]);
  await c.var.query("DELETE FROM mfa_recovery_codes WHERE user_id = $1", [me.id]);
  await audit(c, me.id, "mfa_disabled");
  return c.json({ detail: "MFA disabled" });
});
