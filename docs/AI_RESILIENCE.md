# AI consultation resilience (Nov 2026 outage fix)

## Root cause
Every doctor reply failed with Workers AI error `5028: @cf/meta/infire-llama-3.1-8b-instruct was deprecated on 2026-05-30`.
The Worker's default model `@cf/meta/llama-3.1-8b-instruct` had been retired by Cloudflare. The old catch-all handler
then showed "free AI service is busy or has used up its daily allowance", which was wrong (not a quota problem).
The provider is **Cloudflare Workers AI** (binding `AI`), plus an optional OpenAI-compatible provider
(`AI_API_KEY`, default base URL Groq) that is tried first when the secret is set. It is not Gemini unless `AI_BASE_URL` points there.

## Behaviour now
- English: `@cf/meta/llama-4-scout-17b-16e-instruct`; Kannada/Hindi: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (tested in en/kn/hi).
- If Cloudflare retires a model (5028/5007) the Worker tries the next default model on the same provider, never another vendor silently.
- 429/500/502/503/504: retried with exponential backoff + jitter, honouring `Retry-After`. Quota (4006/"daily"), 401/403/404 and retired models are never retried.
- Each provider failure is logged (`ai_provider_failed`, `ai_model_unavailable`) with status only, never keys.
- WebSocket `error` events carry `code` (`ai_quota`, `ai_busy`, `ai_unconfigured`, `ai_error`) and `recoverable`.
- No fallback text is ever presented as a doctor reply. The medical safety engine (`safety.ts`) is untouched.
- Frontend: an AI failure shows "AI doctor unavailable" and keeps the call, video and microphone running.
- Speech playback watchdog re-arms until playback stops and force-releases "speaking" after a hard cap.
- Speech recognition restarts after Chrome `no-speech`/`network`/`aborted` with backoff, retries failed starts, and recovers on mic `devicechange` / coming back online.

## Files changed
`workers/api/src/ws.ts`, `workers/api/test/ws.test.ts`, `frontend/components/doctor/DoctorVideoCall.tsx`,
`frontend/components/doctor/useDoctorSpeech.ts`, `frontend/components/doctor/useConsultationSpeechRecognition.ts`.

## Environment variables (all optional)
| Name | Purpose |
|---|---|
| `AI_MODEL` / `AI_MODEL_LARGE` | Override Workers AI model for English / Kannada+Hindi |
| `AI_API_KEY` (secret) | OpenAI-compatible provider key, tried before Workers AI |
| `AI_BASE_URL` | Base URL for that provider (default `https://api.groq.com/openai/v1`); **must match the key's provider** |
| `AI_MODEL_EXTERNAL` / `AI_MODEL_LARGE_EXTERNAL` | Model names on that provider |
| `AI_MAX_ATTEMPTS` | Attempts per provider for temporary errors (default 3) |
| `AI_RETRY_DELAY_MS` | Set `0` to disable backoff sleeps (tests) |
| `AI_USER_HOURLY_CAP` / `AI_DAILY_CAP` | Optional usage caps |

## Server voice (Kannada / Hindi / English)
`workers/api/src/tts.ts` synthesises each reply and streams it as `audio_chunk` events *before* the final `message`, so the
browser plays the server audio (lips follow the real audio via the Web Audio analyser) and does not also speak with its own voice.
If synthesis fails or takes over 7 s, the browser's own voice is used and a single notice is shown.

| Variable | Purpose |
|---|---|
| `TTS_PROVIDER` | `auto` (default), `gemini`, `google_translate`, `off` |
| `GEMINI_API_KEY` (secret) | Free key from aistudio.google.com/apikey. Official API, two doctor voices (Charon / Kore). Enables `gemini` in `auto` |
| `TTS_MODEL` | Default `gemini-2.5-flash-preview-tts` |
| `TTS_VOICE_MALE` / `TTS_VOICE_FEMALE` | Default `Charon` / `Kore` |

Without a Gemini key, `auto` uses the keyless Google Translate speech endpoint. It is **unofficial**, may be rate-limited or blocked,
and has a single voice. Set `GEMINI_API_KEY` for the supported path.
