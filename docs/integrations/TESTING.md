# Testing & verification (what was actually run)

| Check | Result |
|---|---|
| `tsc --noEmit` (Worker, website) | clean |
| Worker tests (Vitest + in-process Postgres incl. pgcrypto) | **192 / 192 pass**; 31 are new in `test/integrations.test.ts` |
| Website production build (`next build`, static export) | succeeds |
| Browser (Chromium, mocked API, real CSP) — `captcha → email code → sign-in`, wrong code, sign-up carries proof, captcha-off path | 8/8 pass, 0 CSP violations |
| Browser — profile "Privacy and sharing": consent gates the doctor form, grant, revoke, FHIR download | 7/7 pass, 0 CSP violations |
| Migration 004 on Neon dev branch | applied; column, 2 tables and constraint verified |

## Mutation checks (do the tests catch regressions?)
Each protection was removed in turn and the suite had to fail:
OTP attempt cap removed → fails ✔ · captcha replay protection removed → fails ✔ · read-time doctor-consent check removed → initially **passed**
(withdrawing consent also revoked grants, so the check was never exercised alone); a test was added that withdraws consent directly in the
database, and the mutation is now caught ✔.

## What is NOT verified
- Real Firebase App Check tokens (tests use generated RSA keys and a fake key endpoint, not Google's).
- Real email delivery (the HTTP mail call is stubbed) and real reCAPTCHA v3.
- FHIR output against a FHIR validator/server.
- Umami, GlitchTip, Jitsi self-hosting (not deployed).
- Production database (migrations 003/004 not applied there) and a live deploy of this branch.
- Load/penetration testing; OWASP ZAP and Trivy have not been run.
