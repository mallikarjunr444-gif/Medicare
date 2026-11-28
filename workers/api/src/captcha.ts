import type { Context } from "hono";
import { hmacHex, randomToken, sha256Hex, timingSafeEqual } from "./crypto";
import type { AppVars, Env, Query } from "./env";
import { fail } from "./http";

// ALTCHA (MIT, https://altcha.org): a self-hosted proof-of-work challenge. No third-party service, no tracking,
// no cookies. The server signs a challenge; the browser finds the number whose SHA-256 matches; we verify the HMAC,
// the expiry, and that the solution was never used before.
const MAX_NUMBER = 100_000;
const TTL_S = 600;

export const captchaEnabled = (env: Pick<Env, "CAPTCHA_SECRET">) => !!env.CAPTCHA_SECRET;

export async function createChallenge(env: Env) {
  const salt = `${randomToken(12)}?expires=${Math.floor(Date.now() / 1000) + TTL_S}`;
  const number = crypto.getRandomValues(new Uint32Array(1))[0] % MAX_NUMBER;
  const challenge = await sha256Hex(`${salt}${number}`);
  return { algorithm: "SHA-256", challenge, maxnumber: MAX_NUMBER, salt, signature: await hmacHex(env.CAPTCHA_SECRET!, challenge) };
}

export async function verifyCaptcha(env: Env, q: Query, payload: unknown): Promise<boolean> {
  if (!env.CAPTCHA_SECRET || typeof payload !== "string" || payload.length > 2000) return false;
  try {
    const p = JSON.parse(atob(payload)) as Record<string, unknown>;
    if (p.algorithm !== "SHA-256" || typeof p.challenge !== "string" || typeof p.salt !== "string" || typeof p.signature !== "string" || typeof p.number !== "number") return false;
    const expires = Number(/[?&]expires=(\d+)/.exec(p.salt)?.[1]);
    if (!expires || expires < Date.now() / 1000) return false;
    if (!Number.isInteger(p.number) || p.number < 0 || p.number > MAX_NUMBER) return false;
    if (!timingSafeEqual(await sha256Hex(`${p.salt}${p.number}`), p.challenge)) return false;
    if (!timingSafeEqual(await hmacHex(env.CAPTCHA_SECRET, p.challenge), p.signature)) return false;
    // One use only: remember the signature until the challenge would have expired anyway.
    const fresh = await q(
      "INSERT INTO login_attempts (key, fails, reset_at) VALUES ($1, 1, to_timestamp($2)) ON CONFLICT (key) DO NOTHING RETURNING key",
      [`captcha|${await sha256Hex(p.signature)}`, expires + 60],
    );
    return fresh.length === 1;
  } catch {
    return false;
  }
}

/** No-op when CAPTCHA_SECRET is unset (feature off); otherwise 400 `captcha_required` unless a fresh solution is supplied. */
export async function requireCaptcha(c: Context<{ Bindings: Env; Variables: AppVars }>, body: Record<string, unknown>): Promise<void> {
  if (!captchaEnabled(c.env)) return;
  if (!(await verifyCaptcha(c.env, c.var.query, body.captcha))) fail(400, "captcha_required");
}
