# Security Test Report

Environment: local sandbox only. Nothing was run against production. Results are from commands actually executed on 2026-11-26/27.

## Passed
| Test | Tool | Result |
|---|---|---|
| API unit/integration suite (11 files) incl. 10 new security tests | Vitest + in-process Postgres (PGlite) | 150/150 passed |
| CSRF: unknown Origin blocked (403), cross-site no-Origin blocked, allowed Origin and header-less client allowed, GET unaffected | Vitest | passed |
| Unauthenticated access to 6 protected routes returns non-200 | Vitest | passed |
| Forged `alg=none` JWT and the UI placeholder token rejected (401) | Vitest | passed |
| Login lockout after 5 failures (429 + Retry-After), other account unaffected | Vitest | passed |
| SQL metacharacters in login/register treated as data (401/422, users table intact) | Vitest | passed (basic only) |
| API response headers (HSTS, deny-all CSP, nosniff, no-store) | Vitest | passed |
| TypeScript typecheck of the API | tsc | passed |
| Dependency audit, API Worker | npm audit | 0 vulnerabilities |
| Dependency audit, frontend | npm audit | 18 -> 4 (critical 1 -> 0) |
| Secret scan, full git history (2 commits) | Gitleaks 8.28.0 | 11 hits, all reviewed as placeholders/fixtures; 0 after allowlist |
| Frontend production build with upgraded Next.js | next build | passed |
| Home page under enforced CSP | Playwright/Chromium | 0 CSP violations, 0 console errors |

## Failed / unresolved
| Item | Status |
|---|---|
| 4 high npm advisories (firebase -> firestore -> grpc-js) | Open; code path unused; fix would downgrade firebase |
| Semgrep `backend/` Python findings (animator, XML, urllib) | Open; service not deployed |
| Login lockout is not durable across isolates | Open |
| No MFA, email verification, password reset, session revocation, RLS, private file storage, audit log, export/delete | Not implemented |
| `?token=` in WebSocket URL; auth persisted in localStorage | Open |

## Not run (and why)
- **OWASP ZAP**: no scan target; active scans only against a dev/staging deployment you approve. Not run.
- **Trivy**: not installed in the sandbox; it is configured in CI but has not produced results yet.
- **Semgrep via CI config**: the sandbox could not reach the Semgrep registry; I ran the same rule families from the open rules repo instead, so CI results may differ slightly.
- **Playwright end-to-end auth flows, Google OAuth redirect validation, cross-user access against a live DB, file upload tests**: not run (no real Google credentials; no upload endpoint exists yet; no staging environment).
- WebSocket Origin rejection has no dedicated automated test yet.
- CSP was verified on the home page load only, not on Jitsi calls or Firebase sign-in popups.
