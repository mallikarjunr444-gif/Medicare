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

// ---- login brute-force throttle (per Worker isolate; see SECURITY_IMPLEMENTATION.md) ----
const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60_000;
const fails = new Map<string, { n: number; reset: number }>();

export function loginBlocked(key: string): boolean {
  const f = fails.get(key);
  if (!f) return false;
  if (Date.now() > f.reset) {
    fails.delete(key);
    return false;
  }
  return f.n >= MAX_FAILS;
}
export function loginFailed(key: string): void {
  if (fails.size > 5000) fails.clear();
  const now = Date.now();
  const f = fails.get(key);
  if (!f || now > f.reset) fails.set(key, { n: 1, reset: now + WINDOW_MS });
  else f.n++;
}
export function loginSucceeded(key: string): void {
  fails.delete(key);
}
export const LOGIN_RETRY_AFTER_S = WINDOW_MS / 1000;
