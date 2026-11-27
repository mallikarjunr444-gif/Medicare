import type { Env } from "./env";

/**
 * Transactional email through any Resend-compatible HTTP API (default https://api.resend.com/emails).
 * Configure secrets EMAIL_API_KEY and var EMAIL_FROM (a sender on a domain you have verified with the provider).
 * Returns false (never throws, never logs the message) when unconfigured or the provider refuses.
 */
export async function sendMail(env: Env, msg: { to: string; subject: string; text: string }): Promise<boolean> {
  if (!env.EMAIL_API_KEY || !env.EMAIL_FROM) return false;
  try {
    const r = await fetch(env.EMAIL_API_URL || "https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.EMAIL_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export const appUrl = (env: Env): string => (env.APP_URL || env.CORS_ORIGINS.split(",")[0] || "").trim().replace(/\/$/, "");
