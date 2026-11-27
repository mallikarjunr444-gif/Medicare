# Security Implementation Notes

## Changed in this branch
- `workers/api/src/security.ts` (new): Origin guard, WebSocket Origin check, login throttle.
- `workers/api/src/app.ts`: guard mounted on `/api/*`; stricter `secureHeaders`.
- `workers/api/src/routes/users.ts`: throttle on `/users/login` (HTTP 429 + `Retry-After`).
- `workers/api/src/ws.ts`: Origin check; safe cookie parsing.
- `workers/api/test/security.test.ts` (new): 10 tests.
- `frontend/public/_headers`: CSP, HSTS, COOP. `frontend/lib/api.ts`: placeholder token never sent.
- `frontend/package-lock.json`: dependency fixes (next 16.4.6).
- `.github/workflows/security.yml`, `.github/dependabot.yml`, `.gitleaks.toml`.

## Known limits of what was implemented
- **Login throttle is in-memory per Worker isolate.** A distributed attacker, or isolate recycling, can exceed it. A durable version needs a Neon table or Workers KV/Durable Object (requires a migration or a new binding; not applied without approval).
- **CSP keeps `'unsafe-inline'` for scripts and styles** because a static export cannot use per-request nonces. `connect-src` allows `*.workers.dev`; tighten to the exact API host once it is fixed.
- Origin guard trusts the `CORS_ORIGINS` list; keep it minimal.

## Not implemented (needs your decision/approval)
MFA, email verification and reset, RLS with a non-owner DB role, private report storage, export/delete, audit log, same-origin `/api` routing (would let cookies become `SameSite=Strict`), removal of the localStorage auth persistence. See `ARCHITECTURE_AND_PLAN.md`.
