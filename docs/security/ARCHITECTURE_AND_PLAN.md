# MediCare — Authentication & Security: Architecture Report and Implementation Plan

Status: **proposal, nothing modified or deployed.** Written 2026-11-26 from the repo (`mallikarjunr444-gif/medicus-care`, main @ f13aee5), the Cloudflare account, and a read-only look at the Neon project.

## 1. What is actually running today

| Layer | Finding | Evidence |
|---|---|---|
| Website | Next.js static export served by Worker `medicare-web` (static assets) | `frontend/wrangler.jsonc`, `next.config.js` |
| API | Hono on Worker `medicare-api-prod`, Neon over SQL-over-HTTP (no TCP, no transactions) | `workers/api/src/app.ts`, `db.ts` |
| Database | Neon project `dry-mud-16331151`, branch `medicare` (`br-patient-truth-apkoa9gp`). Default branch `main` is empty. | Neon MCP |
| Auth in repo | Firebase Google sign-in (token verified in Worker), own HS256 JWT (24 h), guest accounts, email+password with pgcrypto bcrypt | `auth.ts`, `firebaseAuth.ts`, `routes/users.ts`, `routes/profile.ts` |
| Legacy | Python FastAPI backend, Celery, Docker/AWS files. Not what the live site uses. | `backend/`, `infrastructure/` |
| Cloudflare | No D1, KV, Hyperdrive. R2 **not enabled** (error 10042). | Cloudflare MCP |
| Deploy | Push to `main` auto-deploys the API Worker (`deploy-worker.yml`) and frontend. | `.github/workflows` |

Live database state (aggregate counts only, no personal data read): 15 users, **all guests**, 0 password users, 0 superusers; 21 sessions, 94 messages, 9 consultation reports. Tables: `users, sessions, messages, conversations, consultation_reports, avatars, knowledge_chunks, alembic_version`. Alembic is at `0005`.

### Discrepancies you should know about
1. **Repo and live DB disagree.** Migration `002_firebase_profiles.sql` (adds `users.firebase_uid`, `health_records`, `reports`) and `001_psychology.sql` are not applied on the live branch. If the deployed Worker matches `main`, `/api/v1/auth/firebase` and `/api/v1/profile` would fail against that database. I have not been able to confirm which Worker version is live (the bundle is ~4 MB and was truncated), so treat "Google sign-in works today" as **unverified**.
2. **The frontend ships fake authentication.** `frontend/store/useStore.ts` defaults to token `medicare-direct-token` and a hardcoded user `patient-direct`, persisted to `localStorage` (`avatar-system-storage`). This is the "no login barrier" pattern. It must be removed.
3. The auth token (and user object) is stored in `localStorage` and sent as a Bearer header — readable by any XSS.

## 2. Weaknesses found (verified in code unless marked)

| # | Issue | Severity |
|---|---|---|
| W1 | RLS is off on every table; the API connects as the database owner. Isolation relies only on `WHERE user_id = …` in each route. | High |
| W2 | Cross-site cookie (`SameSite=None`) plus `readJson()` parsing any content-type means a cross-origin `text/plain` form POST skips the CORS preflight. No CSRF token or Origin check. | High |
| W3 | Stateless JWT, 24 h, single symmetric secret, no revocation. Logout only clears the cookie; a copied token stays valid. | High |
| W4 | Email+password signup has no email verification; any address can be claimed. No password reset, no MFA. | High |
| W5 | Rate limit is 60 req/min/IP across all routes; no per-account login throttle or lockout. The in-memory fallback limiter is per Worker instance. | Medium |
| W6 | Token in `localStorage` (see §1). | Medium |
| W7 | Audit logging exists only for psychology (`psych_audit_log`); nothing for reports, exports, deletes, logins. | Medium |
| W8 | No CSP or HSTS in `frontend/public/_headers`. | Medium |
| W9 | No account export or deletion endpoint (users/sessions cascade on delete at DB level, but nothing exposes it). | Medium |
| W10 | Guest accounts can be created without limit. The Python backend has a daily guest sweep (`celery_app.py`); I found **no equivalent in the Worker**, while the site says guest sessions are deleted automatically. 15 guests exist now. | Medium |
| W11 | Roles are a boolean `is_superuser` plus env-var emails for psychologists. No role table. | Low–Med |
| W12 | Medical reports are free text in Postgres; no private file storage exists. Avatar upload does validate magic bytes (good). | Info |

Not yet audited (will be covered by tests): `routes/psychology.ts`, `psychClinical.ts`, `ws.ts` (WebSocket auth), `admin.ts` upload route, repo history for leaked secrets.

## 3. Choice: Better Auth, not Supabase Auth

| Criterion | Better Auth (self-hosted in the Worker) | Supabase Auth |
|---|---|---|
| Fits Neon Postgres + Hono + Workers | Yes: library mounts on a Hono route, stores users/sessions in your existing Postgres | No: requires a Supabase project and its Postgres. Moving data off Neon or running two databases |
| RLS | Works with Postgres roles on Neon; you own the policy keys | `auth.uid()` helpers only help if data lives in Supabase |
| Features needed | Email+password, Google, verification, reset, TOTP 2FA, DB sessions with revocation, built-in rate limiting, CSRF/origin checks | Same set |
| New services | None beyond an email sender | New vendor, new bill, second data store |
| Open source | Yes | Yes |

Decision: **Better Auth**, installed only in `workers/api`. Supabase is not installed. Neon's managed "Neon Auth" (also Better Auth) is a viable alternative if you prefer not to run the auth code yourself; it adds a hosted dependency and keeps user rows in a separate schema. I recommend self-hosting in the Worker for one API origin and full control, and will switch if you prefer managed.

Because every live user is a guest (no Firebase users, no password users), **there is no account migration** to protect. Firebase can be removed after cutover.

### Constraints that need your decision
- **Workers Free plan CPU (10 ms).** Better Auth hashes passwords with scrypt, which I expect to exceed 10 ms. I have not measured it. Today's code deliberately hashes inside Postgres (pgcrypto) for this reason. Options: (a) Workers Paid plan (USD 5/month), (b) keep hashing in Postgres via a custom Better Auth `password.hash/verify` backed by pgcrypto. I will measure first; (b) keeps you on the free plan.
- **Cross-site cookies.** `medicare-web.*.workers.dev` and `medicare-api-prod.*.workers.dev` are different sites (`workers.dev` is a public suffix), so `SameSite=None` cookies are exposed to browser third-party-cookie blocking and to CSRF. Fix: serve the API **same-origin** by routing `/api/*` on the website Worker to the API Worker (service binding), then use `SameSite=Lax`/`Strict`, `HttpOnly`, `Secure`, `__Host-` prefix.
- **Transactions for RLS.** The current SQL-over-HTTP client cannot hold `SET LOCAL app.user_id` across statements. Plan: use `@neondatabase/serverless` Pool (WebSocket) or Neon's HTTP transaction endpoint for per-request transactions, connecting as a new non-owner role `medicare_app` (NOBYPASSRLS).
- **Email sending** (verification, reset) needs a provider. Options: Cloudflare Email Service, or Resend free tier. Your call.
- **Private file storage** needs R2 (must be enabled in the dashboard) or storing small files in Postgres. Recommendation: R2 private bucket, no public URLs, downloads streamed through an authorised Worker route.

## 4. Target architecture

```
Browser ── same origin ──► Worker medicare-web
   │                          ├─ static assets (+ CSP, HSTS)
   │                          └─ /api/* ──(service binding)──► Worker medicare-api-prod
   │                                                            ├─ Hono middleware: origin check, rate limit, request id
   │                                                            ├─ Better Auth  /api/auth/*  (Google, email+password, verify, reset, TOTP, sessions)
   │                                                            ├─ Authorization layer: requireUser / requireRole / ownership checks
   │                                                            ├─ Business routes (sessions, messages, reports, profile, health-records)
   │                                                            ├─ R2 (private) for report files
   │                                                            └─ Neon Postgres as role medicare_app, RLS on user tables,
   │                                                               per-request txn with SET LOCAL app.user_id
   └─ no tokens in JS-readable storage; session cookie HttpOnly
```

Roles: `patient` (default), `psychologist`, `admin` via a `user_roles` table (replaces `is_superuser` and the env email list; old flags backfilled).

Guest access (optional, per your item 8): kept, but as a real Better Auth anonymous session with a short expiry, tighter rate limit, no file upload, and a scheduled purge (Worker cron).

## 5. Implementation plan (each step is its own commit on a branch; nothing merges to `main` or deploys without your approval)

| Step | Work | Verify |
|---|---|---|
| 0 | Branch `security/auth-hardening`. Create a **Neon branch off `medicare`** for development/testing (additive; production untouched). | Neon branch exists |
| 1 | Baseline: run Gitleaks (history), Semgrep, existing vitest suite, record results. | Report baseline |
| 2 | DB migration (idempotent, additive): Better Auth tables, `user_roles`, `audit_log`, `consent` fields. Apply 001/002 to dev branch only. | Migration runs twice cleanly |
| 3 | Same-origin `/api` routing; remove cross-site cookie config. | Playwright: cookie attrs |
| 4 | Better Auth in Worker: Google, email+password, verification, reset, sessions, logout, revocation, rate limits, Origin/CSRF. Password hashing measured on workerd. | vitest + Playwright |
| 5 | Frontend: replace Firebase `AuthProvider`, delete fake token/user in `useStore`, stop persisting auth in `localStorage`, auth pages (sign-in, sign-up, verify, forgot/reset, MFA setup), profile + picture, guest option, protected dashboard. | Playwright flows |
| 6 | MFA (TOTP + backup codes), session list and "sign out everywhere". | Playwright |
| 7 | Authorization: role table, `requireRole`, ownership helpers; audit log writes for login, reset, export, delete, report read/download. | API tests |
| 8 | RLS: `medicare_app` role, policies on `sessions, messages, conversations, consultation_reports, avatars, health_records, reports`, per-request txn. Cross-user tests at DB level. | SQL tests |
| 9 | Reports as private R2 objects: type/size/magic-byte validation, random keys, authorised streaming download with short-lived tokens, `Content-Disposition`, no public URL. | upload tests |
| 10 | Data export (JSON zip) and account deletion (cascade + R2 purge + audit tombstone). | API tests |
| 11 | Headers: CSP, HSTS, frame-ancestors, Permissions-Policy; input validation with a schema lib on all write routes; guest purge cron. | ZAP baseline |
| 12 | Security test run and report: ZAP (baseline passive against production URL; **active scan only against local/dev**), Gitleaks, Semgrep, Playwright. | Report with real output only |

### Test coverage mapped to your list
Unauthorized dashboard / API, cross-user access (API and RLS), SQL injection, XSS, auth bypass, reset-token reuse/expiry/enumeration, session fixation/expiry/revocation, upload abuse (type spoofing, oversize, path tricks), Google OAuth `redirect_uri`/`state` validation. Results will be reported as pass/fail/not-run; nothing will be filled in without a real run.

## 6. Google Cloud OAuth setup (you do this; I never see the secret)

With the same-origin design, the callback lives on the website origin.

1. Google Cloud Console → create/select a project → **APIs & Services → OAuth consent screen**: User type External; app name MediCare; support email; developer contact; add scopes `openid`, `email`, `profile` only; link your Privacy Policy (`/privacy`) and Terms (`/terms`). Leave in **Testing** and add test users until ready.
2. **Credentials → Create credentials → OAuth client ID → Web application**.
3. **Authorized JavaScript origins**: `https://medicare-web.mallikarjunr444.workers.dev`, `http://localhost:3000`.
4. **Authorized redirect URIs** (exact match, no wildcards): `https://medicare-web.mallikarjunr444.workers.dev/api/auth/callback/google`, `http://localhost:3000/api/auth/callback/google`.
5. Copy the Client ID and Client Secret. Store them only as Worker secrets: `wrangler secret put GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and also `BETTER_AUTH_SECRET` (`openssl rand -base64 48`). They never go in `wrangler.jsonc`, the repo, or the frontend.
6. Publishing beyond test users: Google requires a verified domain; a `*.workers.dev` hostname probably cannot be verified, so plan to attach a domain you own. Please confirm this against Google's current rules before launch.

## 7. Safety rules I will follow
- Branch only; no push to `main` (it auto-deploys). No deploy without your explicit approval.
- No writes to the production Neon branch; migrations run on a dev branch first and you approve the production run.
- No credentials in files, logs, or chat.
- No production data deleted. The 15 guest users stay until you decide on the purge.

## 8. Decisions needed before Step 0
1. Approve **Better Auth** (vs Supabase / Neon managed).
2. Password hashing: measure on the free plan first, or move to Workers Paid.
3. Email provider for verification/reset.
4. R2: enable it (dashboard) or store small files in Postgres.
5. OK to create a Neon dev branch from `medicare`.
6. Domain: use `workers.dev` for now, or do you have a custom domain?
7. To push the branch I need push access attached to the repo (currently read-only clone).
