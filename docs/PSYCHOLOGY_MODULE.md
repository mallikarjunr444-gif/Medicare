# Psychological Assessment & Video Consultation (foundation, stages 1–6)

Two-panel room: left = Jitsi video (no keys), right = patient form or psychologist workspace.

## Roles
- **Psychologist**: signs in with a registered (non-guest) account whose email is in `PSYCHOLOGIST_EMAILS`
  (comma-separated Worker var) or whose `users.is_psychologist` is true. Creates a consultation and gets an 8-char join code.
- **Patient**: joins by code (guest identity is created automatically). Never sees scores, alerts or other patients.

## Flow
Join → intake (age auto-calculated) → consents (recording is off and cannot be enabled here) →
psychologist assigns GAD-7 / PHQ-9 / ASRS-6 (blocked without `assessment` + `data_processing` consent) →
start / pause / resume / end → patient answers (autosaved draft) → atomic submit → psychologist sees score, band, answers.
PHQ-9 item 9 > 0 raises a safety alert for the psychologist and shows the patient a support message (call 112).

## Rules enforced server-side
Immutable responses (corrections need a reason and are audited), append-only audit log (ids/actions only),
no AI diagnosis, proprietary tests (WAIS-IV, CAARS, PAI) are not reproduced.

## Config / caveats
- Schema is created idempotently by the Worker on first call (`psychSchema.ts`; also `migrations/001_psychology.sql`).
- Public `meet.jit.si` is **not** suitable for confidential clinical use; self-host Jitsi (or a BAA-covered provider) before real patients.
- Verify ASRS-v1.1 wording/licensing before production use.
- Not yet built: stages 7–16 (observer invites, cognitive tasks, authorized-result entry, DSM interview, notes/history, AI report, PDF).
