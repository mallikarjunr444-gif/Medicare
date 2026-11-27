import type { MiddlewareHandler } from "hono";
import type { Env } from "./env";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function allowedOrigins(env: Pick<Env, "CORS_ORIGINS">): string[] {
  return env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * CSRF defence for cookie-authenticated requests. Browsers always attach an
 * Origin header to cross-site state-changing requests, so a present-but-unknown
 * Origin is refused. Requests with no Origin (curl, server-to-server) cannot be
 * driven by a victim's browser and are allowed; Sec-Fetch-Site: cross-site with
 * no Origin is refused as well.
 */
export const originGuard: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (UNSAFE.has(c.req.method)) {
    const origin = c.req.header("origin");
    const ok = origin
      ? allowedOrigins(c.env).includes(origin)
      : c.req.header("sec-fetch-site") !== "cross-site";
    if (!ok) return c.json({ detail: "Cross-site request blocked" }, 403);
  }
  await next();
};

/** WebSocket handshakes are not covered by CORS: validate Origin explicitly (CSWSH). */
export function wsOriginAllowed(origin: string | null, env: Pick<Env, "CORS_ORIGINS">): boolean {
  return !origin || allowedOrigins(env).includes(origin);
}

// ---- brute-force throttle ----
// Two layers: a durable counter in Postgres (survives isolate recycling, shared by every Worker instance)
// and a per-isolate in-memory counter that still protects if the database layer errors.
import type { Query } from "./env";
import { sha256Hex } from "./crypto";

const mem = new Map<string, { n: number; reset: number }>();
const memBlocked = (key: string, max: number) => {
  const f = mem.get(key);
  return !!f && Date.now() <= f.reset && f.n >= max;
};
const memHit = (key: string, windowMs: number) => {
  if (mem.size > 5000) mem.clear();
  const now = Date.now();
  const f = mem.get(key);
  if (!f || now > f.reset) mem.set(key, { n: 1, reset: now + windowMs });
  else f.n++;
};

export const LOGIN_WINDOW_S = 15 * 60;
export const LOGIN_RETRY_AFTER_S = LOGIN_WINDOW_S;
export const LOGIN_MAX_PER_IP_ACCOUNT = 5;
export const LOGIN_MAX_PER_ACCOUNT = 20; // distributed attacks against one account

export async function throttleBlocked(q: Query, key: string, max: number): Promise<boolean> {
  if (memBlocked(key, max)) return true;
  try {
    const rows = await q("SELECT 1 FROM login_attempts WHERE key = $1 AND reset_at > now() AND fails >= $2", [await sha256Hex(key), max]);
    return rows.length > 0;
  } catch {
    return false; // memory layer already consulted; never lock everyone out because of a DB hiccup
  }
}

export async function throttleHit(q: Query, key: string, windowS = LOGIN_WINDOW_S): Promise<void> {
  memHit(key, windowS * 1000);
  try {
    await q(
      `INSERT INTO login_attempts (key, fails, reset_at) VALUES ($1, 1, now() + make_interval(secs => $2::int))
       ON CONFLICT (key) DO UPDATE SET
         fails = CASE WHEN login_attempts.reset_at <= now() THEN 1 ELSE login_attempts.fails + 1 END,
         reset_at = CASE WHEN login_attempts.reset_at <= now() THEN now() + make_interval(secs => $2::int) ELSE login_attempts.reset_at END`,
      [await sha256Hex(key), windowS],
    );
    if (Math.random() < 0.02) await q("DELETE FROM login_attempts WHERE reset_at < now() - interval '1 day'");
  } catch {
    /* in-memory layer still counted */
  }
}

export async function throttleClear(q: Query, key: string): Promise<void> {
  mem.delete(key);
  try {
    await q("DELETE FROM login_attempts WHERE key = $1", [await sha256Hex(key)]);
  } catch {
    /* ignore */
  }
}

export const clientIp = (c: { req: { header(n: string): string | undefined } }): string =>
  (c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0] ?? "unknown").trim();
