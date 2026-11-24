# Google sign-in, profiles and saved data: setup

How it works: the website signs people in with Firebase (Google). Every API call carries the Firebase **ID token**.
The API (Cloudflare Worker, `workers/api`) verifies the token's signature against Google's public keys and takes the
UID **only** from that verified token, then reads/writes Neon rows owned by that user. No Firebase or Neon secret is in the website.

> Why not the Firebase Admin SDK? It needs Node APIs that Cloudflare Workers don't have. `src/firebaseAuth.ts` performs the
> same checks the Admin SDK's `verifyIdToken()` does (RS256 signature, `iss`, `aud`, `exp`, `iat`, `auth_time`, `sub`) with Web Crypto,
> and needs no service-account key at all.

## One-time setup (about 10 minutes)

1. **Firebase Console → Authentication → Sign-in method → Google → Enable.** Pick a support email.
2. **Authentication → Settings → Authorized domains.** Add every address the site is served from (no `https://`):
   - `localhost` (already there by default)
   - `medicare-web.mallikarjunr444.workers.dev`
   - `medicus-labs.web.app` and `medicus-labs.firebaseapp.com`
   - any custom domain, e.g. `care.medicuslabs.app`
3. **Project settings → Your apps → Web app** (create one if needed). Copy `apiKey`, `authDomain`, `projectId`, `appId`.
4. **GitHub → Settings → Secrets and variables → Actions → *Variables*.** Add `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`,
   `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`. (They are public identifiers, so variables, not secrets.)
5. **Check `FIREBASE_PROJECT_ID` in `workers/api/wrangler.jsonc`.** It is set to `medicus-labs` (taken from the existing CORS origins).
   It must equal your real Firebase project id. A wrong value makes every sign-in fail closed (401), never open.
6. **Apply the database migration:** GitHub → Actions → **Apply DB migrations** → Run workflow. It needs the existing `DATABASE_URL` secret.
   The SQL is additive and idempotent (`workers/api/migrations/002_firebase_profiles.sql`): nothing is dropped or overwritten.
   Do this **before** merging, because the new code reads the new `users` columns.
7. Merge the PR. Pushing to `main` redeploys the Worker and the website automatically (existing workflows).
8. For local work, copy `frontend/.env.local.example` to `frontend/.env.local` and fill in the four Firebase values.

## Redirect fallback
Sign-in uses a popup and falls back to a full-page redirect when popups are blocked (some mobile/in-app browsers). For the redirect to work in
browsers that block third-party storage, the site and `authDomain` should share a registrable domain (use your custom domain as `authDomain`),
or use Firebase's [redirect best practices](https://firebase.google.com/docs/auth/web/redirect-best-practices).

## Data model
| Product term | Table | Owner column |
|---|---|---|
| profile | `users` (+ `firebase_uid`, `photo_url`, `phone`, `date_of_birth`, `gender`, `last_login_at`) | `firebase_uid` (unique) |
| consultation | `sessions`, `conversations`, `consultation_reports` | `user_id` |
| chat history | `messages` (through its session) | `sessions.user_id` |
| health records | `health_records` (new) | `user_id` |
| reports | `reports` (new) | `user_id` |

All user-owned tables reference `users(id)` with `ON DELETE CASCADE` and are indexed by `user_id`.

## API
`POST /api/v1/auth/firebase` (sign-in/sign-up, creates or updates the profile) · `GET|PUT /api/v1/profile` · `GET /api/v1/profile/consultations` ·
`/api/v1/health-records` and `/api/v1/reports` (list, create, get, update, delete). Existing sessions/messages/conversations routes accept Firebase tokens unchanged.
