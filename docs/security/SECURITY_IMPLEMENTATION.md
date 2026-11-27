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
- `frontend/firebase.json`, `frontend/.firebaserc`, `.github/workflows/deploy-firebase-hosting.yml` (manual-only Firebase Hosting deploy; headers mirror `_headers`).

## Known limits of what was implemented
- **Login throttle is in-memory per Worker isolate.** A distributed attacker, or isolate recycling, can exceed it. A durable version needs a Neon table or Workers KV/Durable Object (requires a migration or a new binding; not applied without approval).
- **CSP keeps `'unsafe-inline'` for scripts and styles** because a static export cannot use per-request nonces. `connect-src` allows `*.workers.dev`; tighten to the exact API host once it is fixed.
- Origin guard trusts the `CORS_ORIGINS` list; keep it minimal.

## Account-protection branch additions
- `workers/api/migrations/003_account_protection.sql` (additive, idempotent; **apply to production only with your approval, before deploying the API**; it was applied to the Neon dev branch `medicare-auth-dev` and verified, 15 existing users unaffected). The API tolerates the migration being absent only for the revocation lookup, so rollout order is not an outage, but the new features need the tables.
- New: `src/crypto.ts`, `src/totp.ts`, `src/mailer.ts`, `src/audit.ts`, `src/routes/mfa.ts`, `src/routes/account.ts`; changed `auth.ts`, `security.ts`, `routes/users.ts`, `ws.ts`.
- Frontend: `EmailAuthForm`, `AccountLinkHandler`, `SecuritySettings`, `AuthProvider` email-session support, WS ticket in `api.ts`.
- **To enable email**: set secret `EMAIL_API_KEY` and var `EMAIL_FROM` (sender on a domain verified with a Resend-compatible provider; optional `EMAIL_API_URL`, `APP_URL`). Without them, verification/reset emails are not sent and the API says so (verification) or stays silent (reset).
- Optional `MFA_ENC_KEY` secret for encrypting MFA secrets; otherwise derived from `JWT_SECRET_KEY` (rotating that key would invalidate enrolled authenticators).

## Not implemented (needs your decision/approval)
RLS with a non-owner DB role, private report file storage, same-origin `/api` routing, removal of localStorage auth persistence, removal of the legacy `?token=` WebSocket fallback.
