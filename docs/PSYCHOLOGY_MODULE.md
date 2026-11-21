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

## Stages 7-16 (added)
- **Observer questionnaire**: psychologist creates a link (needs the patient's observer consent). Only a SHA-256 of the token is stored, the link works once, expires in 14 days, can be revoked, stops working if consent is withdrawn, and shows nothing about the patient. The form is informal and unscored (not a validated scale).
- **Supplementary cognitive tasks** (reaction time, digit span) run with jsPsych. The server recomputes every summary from the raw trials. They are not IQ tests or WAIS-IV subtests.
- **Licensed instruments (WAIS-IV, CAARS, PAI)**: the psychologist enters results they obtained by administering the licensed test (date, administrator, licence reference, attestation). MediCare contains no items, norms or scoring for them, and stores them apart from screening scores.
- **Clinical interview**: psychologist-led structured sections with findings, supporting/contradicting evidence, duration, frequency, severity and impact. Impressions are entered by the psychologist only.
- **Psychologist workspace** (a separate tab; the video stays connected): Dashboard (assigned/completed/pending, scores, earlier results, observers, tasks, licensed results, alerts, missing information), Clinical notes, Patient history, Interview, Licensed results, Observers & tasks, Report. All routes are psychologist-only and return 404 to other psychologists.
- **Report**: a draft is assembled deterministically from recorded data (no language model is used, so nothing can be invented). Missing items are listed and marked `[Not provided]`. Approval needs the psychologist's name and credentials, an explicit review confirmation, all safety alerts acknowledged, and acknowledgement of remaining gaps. Approved reports are locked. "Print / save as PDF" uses the browser.

## Native equivalents of the non-bundled tools (added)
- **PEBL/PsychoPy-style tasks**: reaction time, digit span, Stroop colour-word, 1-back, all on jsPsych. Correctness and summaries are recomputed on the server from raw trials. Supplementary only (not IQ, not diagnostic).
- **Mini-IPIP** (public-domain IPIP, wording and keys as verified against psytools): five descriptive trait scores out of 20, no cut-offs, not a PAI replacement.
- **Questionnaire builder** (instead of LimeSurvey/JATOS): the psychologist writes questions and answer options; the patient sees them only once started; answers are validated; never scored; included in the dashboard and report as "unscored, not a validated instrument".

## Third-party projects reviewed (cloned and checked)
| Project | Licence | Decision |
|---|---|---|
| jsPsych | MIT | **Used** (npm `jspsych`, `plugin-html-keyboard-response`, `plugin-survey-text`) for the cognitive tasks |
| psytools | MIT code; per-instrument text licences | **Used as a reference**: GAD-7/PHQ-9/ASRS-6 wording and scoring cross-checked. GAD-7 and PHQ-9: free to reproduce. ASRS-6: free with mandatory attribution (now shown wherever it appears) and no modifications |
| OpenScales | CC BY-NC-SA 4.0 | Reference only (non-commercial licence; no content copied) |
| PEBL | GPL-2 | Not bundled (GPL); equivalent tasks rebuilt natively on jsPsych |
| PsychoPy | GPL-3 | Not bundled (GPL); equivalent tasks rebuilt natively on jsPsych |
| JATOS | Apache-2 | Not used (needs a Java server); jsPsych runs in the page and results go to the Worker |
| LimeSurvey | GPL | Not bundled (GPL, PHP server); built-in questionnaire builder instead |
| IPIP | public domain | **Used**: Mini-IPIP |

## Still to do before real patients
Self-hosted Jitsi, ASRS wording sign-off, a clinical validation review, a data-retention policy, and a legal/privacy review (consent text, data residency).
