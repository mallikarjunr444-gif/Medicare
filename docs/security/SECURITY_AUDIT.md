# MediCare Security Audit

Scope: `workers/api` (live Hono API on Cloudflare Workers + Neon), `frontend` (Next.js static export on a Cloudflare Worker), CI config. `backend/` (Python/FastAPI) is not what the live site runs; its findings are listed separately.
Method: manual code review plus Gitleaks 8.28.0, Semgrep CE (rules from the open `semgrep-rules` repo, security category), `npm audit`.

| # | Vulnerability | Severity | Affected | Root cause | Fix | Verified |
|---|---|---|---|---|---|---|
| 1 | CSRF on cookie-authenticated API | High | `workers/api/src/app.ts` | Production cookie is `SameSite=None`; no Origin check; JSON parsed regardless of content-type | `originGuard` rejects unsafe methods with an unknown Origin or `Sec-Fetch-Site: cross-site` | Automated tests (4) |
| 2 | Cross-site WebSocket hijacking | High | `src/ws.ts` | Cookie auth on WS handshake, Origin never checked | Origin allow-list check before upgrade | Code path covered by existing WS tests passing; **no dedicated negative test yet** |
| 3 | No login brute-force protection | High | `routes/users.ts` | Only a global per-IP limiter (60/min) | 5 failures / 15 min per IP+account, checked before bcrypt | Automated test; **per-isolate only, see risks** |
| 4 | Critical Next.js advisory | Critical | `frontend/package.json` | Outdated Next.js | Lockfile moved to next 16.4.6 via `npm audit fix` | `npm audit`: critical 1 -> 0; `npm run build` OK |
| 5 | No CSP / HSTS on the website | Medium | `frontend/public/_headers` | Not configured | CSP, HSTS, COOP added | Built site loaded in Chromium with CSP enforced: 0 violations on home page |
| 6 | Weak API response headers | Low | `src/app.ts` | Defaults only | HSTS 2y, deny-all CSP, no-referrer, CORP | Automated test |
| 7 | Placeholder token sent as Bearer | Low | `frontend/lib/api.ts` | UI placeholder `medicare-direct-token` read from localStorage | Filtered out of `readToken` | Build OK; server already returned 401 for it (test) |
| 8 | Dynamic RegExp from env in cookie parsing | Low | `src/ws.ts` | Semgrep `detect-non-literal-regexp` | Replaced with split/startsWith | Existing tests pass |
| 9 | Dependency advisories (firebase -> firestore -> grpc-js) | High (not reachable) | `frontend` | Transitive; Firestore is not imported anywhere | **Not fixed**: the only npm fix is a downgrade to firebase 9 | grep confirms no firestore/database imports |
| 10 | Gitleaks: 11 hits | Info | various | `.env.example` placeholders, a test fixture password, generated `.buddy` render JSON, RAG index | Reviewed one by one, narrow path allowlist in `.gitleaks.toml` | Re-scan: 0 leaks |

## Semgrep findings not in the live path
`backend/app/services/animator.py` (asyncio exec, md5), `medical_web_research.py` / `rag_service.py` (non-defused XML), `gnani_service.py` (dynamic urllib). Not fixed here because that service is not deployed by the current pipeline. Two `html-in-template-string` groups in the frontend are false positives (values are HTML-escaped or constants).

## Open weaknesses (not fixed in this change)
- No MFA, email verification, or password reset for email/password accounts (needs an email provider and schema work).
- Stateless 24 h JWT with no server-side revocation; logout only clears the cookie.
- `PUT /users/me` changes password without the current password.
- No row-level security: the API connects as the database owner; ownership is enforced only in application code.
- No private report storage, data export/delete endpoints, or audit log outside psychology.
- WebSocket still accepts `?token=` in the URL (token in URL).
- Auth state (including the real JWT) is persisted to localStorage by the Zustand store; the UI also seeds a placeholder "Patient" identity.
- Login timing differs for unknown email vs wrong password (user enumeration by timing).
- Registration and guest creation have no stricter rate limit than the global one.
