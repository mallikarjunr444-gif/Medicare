import type { Context } from "hono";
import type { AppVars, Env } from "./env";
import { clientIp } from "./security";

type C = Context<{ Bindings: Env; Variables: AppVars }>;

/** Best-effort security audit entry. Never include passwords, tokens, codes or message content in `detail`. */
export async function audit(c: C, userId: string | null, action: string, detail: Record<string, unknown> = {}): Promise<void> {
  try {
    await c.var.query("INSERT INTO audit_log (user_id, action, ip, detail) VALUES ($1,$2,$3,$4::jsonb)", [
      userId,
      action,
      clientIp(c),
      JSON.stringify(detail),
    ]);
  } catch {
    console.error("audit_write_failed", action);
  }
}
