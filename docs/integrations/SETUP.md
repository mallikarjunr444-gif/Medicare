# Setup & deployment

Order matters: nothing is enforced until the matching switch is flipped, so you can roll out step by step.

## 0. Database (production needs your approval)
`workers/api/migrations/003_account_protection.sql` then `004_open_source_integrations.sql`. Both are additive and idempotent
(004 widens one CHECK constraint, drops nothing). Already applied and verified on the Neon **dev** branch `medicare-auth-dev`.
For production, run the *db-migrate* workflow or paste the files into the Neon SQL editor for branch `medicare`.

## 1. Worker secrets / vars (`cd workers/api`)
```
npx wrangler secret put CAPTCHA_SECRET --env production      # openssl rand -hex 32  → turns ALTCHA on
npx wrangler secret put EMAIL_API_KEY --env production       # email provider key
```
Set `EMAIL_FROM` (verified sender) and, for App Check, `APPCHECK_PROJECT_NUMBER` in `wrangler.jsonc` vars. Keep
`APPCHECK_ENFORCE` unset/`false` for now. CORS now also lists `https://medicare-care.web.app` and `…firebaseapp.com`.

## 2. Firebase Console (manual — cannot be done from code)
1. **Authentication → Settings → Authorized domains**: add every site origin you serve from (`medicare-care.web.app`, `medicare-web.mallikarjunr444.workers.dev`, …).
2. **Authentication → Sign-in method**: Google enabled (done).
3. **App Check → Apps → your web app → reCAPTCHA v3**: create a reCAPTCHA v3 key in Google Cloud (reCAPTCHA), paste the *secret* into Firebase, copy the *site key* into the GitHub variable `NEXT_PUBLIC_APPCHECK_SITE_KEY`.
4. **Project settings → General → Project number** → `APPCHECK_PROJECT_NUMBER`.
5. Leave Firestore and Storage **unused**. If you ever enable them, deploy the deny-all rules: `firebase deploy --only firestore:rules,storage` from `frontend/`.

## 3. Turn App Check on safely
1. Add the site key variable, deploy the website. 2. In Firebase App Check → Metrics confirm requests carry verified tokens.
3. Allow reCAPTCHA in the CSP (`frontend/public/_headers` **and** `firebase.json`): add `https://www.google.com https://www.gstatic.com` to `script-src` and `frame-src`, and `https://www.google.com` to `connect-src`.
4. Only then set `APPCHECK_ENFORCE` to `"true"` in the Worker vars and redeploy the Worker. If anything breaks, set it back — the site recovers immediately.

## 4. Analytics (optional, needs a server)
Run Umami on a server (Coolify/Dokploy/CapRover/Dokku one-click templates work) → create a website → set
`NEXT_PUBLIC_UMAMI_SRC` and `NEXT_PUBLIC_UMAMI_WEBSITE_ID` as GitHub variables → add the Umami origin to `script-src` and `connect-src` in the CSP.
Do not add custom events that carry health data or user identifiers.

## 5. Error tracking → GlitchTip (optional, needs a server)
Deploy GlitchTip, create a project, `wrangler secret put SENTRY_DSN --env production` with its DSN. No code change.

## 6. Uptime
`.github/workflows/uptime.yml` runs automatically after merge. Optionally set variables `UPTIME_API_URL` / `UPTIME_SITE_URL`.

## 7. Roles
A doctor account is a normal account whose role an administrator changes:
`PUT /api/v1/admin/users/{id}/role {"role":"doctor"}` (superuser token). Demoting a doctor revokes all their grants.
There is no self-service path to the doctor role by design; verify clinicians through your own process first.

## 8. Rollback
Every feature is off or additive: unset `CAPTCHA_SECRET` (captcha off), `APPCHECK_ENFORCE=false`, empty Umami/App Check variables (code inert).
Migration 004 only adds objects; no rollback is required to keep the old code working.
