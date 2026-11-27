# Security Test Report

Environment: local sandbox only. Nothing was run against production. Results are from commands actually executed on 2026-11-26/27.

## Passed
| Test | Tool | Result |
|---|---|---|
| API unit/integration suite (12 files) incl. 10 origin/header/throttle tests and 11 account-protection tests | Vitest + in-process Postgres (PGlite) | 161/161 passed |
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

| Durable lockout survives a fresh app instance; keys stored hashed | Vitest | passed |
| Logout/logout-all/password-change revoke old tokens; current password required | Vitest | passed |
| Email verify + reset: hashed single-use expiring tokens, generic response for unknown emails, old sessions revoked, guest/Google accounts get no reset mail | Vitest (mail provider mocked) | passed |
| TOTP matches RFC 6238 vector; MFA lifecycle incl. replay rejection and single-use recovery codes; secret encrypted at rest | Vitest | passed |
| Export contains only caller's data and no hashes/secrets; delete needs confirmation + password and leaves other users intact | Vitest | passed |
| Mutation check: removing the revocation check made 4 tests fail (tests do detect it) | manual | confirmed |
| Migration 003 applies cleanly on real Neon Postgres (dev branch, 15 existing users untouched) | Neon MCP | passed |
| New sign-in/MFA/reset/verify/security screens, 15 UI checks incl. no stored password, token scrubbed from URL, no CSP violation | Playwright/Chromium with **mocked API** | passed |

## Failed / unresolved
| Item | Status |
|---|---|
| 4 high npm advisories (firebase -> firestore -> grpc-js) | Open; code path unused; fix would downgrade firebase |
| Semgrep `backend/` Python findings (animator, XML, urllib) | Open; service not deployed |
| Login lockout is not durable across isolates | Open |
| RLS, private report file storage | Not implemented |
| Real email delivery, real Google sign-in, WebSocket ticket consumption, full UI against a live API | Not tested (see below) |
| `?token=` in WebSocket URL; auth persisted in localStorage | Open |

## Not run (and why)
- **OWASP ZAP**: no scan target; active scans only against a dev/staging deployment you approve. Not run.
- **Trivy**: not installed in the sandbox; it is configured in CI but has not produced results yet.
- **Semgrep via CI config**: the sandbox could not reach the Semgrep registry; I ran the same rule families from the open rules repo instead, so CI results may differ slightly.
- **Playwright end-to-end auth flows, Google OAuth redirect validation, cross-user access against a live DB, file upload tests**: not run (no real Google credentials; no upload endpoint exists yet; no staging environment).
- WebSocket Origin rejection and one-time-ticket consumption have no automated test (WebSocket needs the Workers runtime).
- The UI tests used a mocked API; the backend is tested separately in-process. They have not been run together against a deployed API.
- The single-use reset-token claim is also protected by deleting tokens afterwards, so removing only the atomic claim would not fail a test.
- CSP was verified on the home page load only, not on Jitsi calls or Firebase sign-in popups.
