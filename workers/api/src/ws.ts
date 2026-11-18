import { subjectFromToken } from "./auth";
import { DOCTORS, systemPrompt } from "./doctors";
import { evaluatePatientQuery, validateAiResponse } from "./safety";
import type { Env, Query } from "./env";

const LANGS: Record<string, string> = { kn: "Kannada (ಕನ್ನಡ script)", en: "English", hi: "Hindi (देवनागरी script)" };
const MAX_TEXT = 4000;

/** Only the consultation languages the prompts know about may reach the model. */
export function normaliseLanguage(value: unknown): string {
  const code = String(value ?? "en").trim().toLowerCase().replace("_", "-").split("-")[0];
  return Object.hasOwn(LANGS, code) ? code : "en";
}

const STOP = new Set("the and for are but not you your have has had with that this from they them what when where which who whom how why can could would should will was were been being about into than then there here also just very some any more most such only over after before again does did doing its our out off too few own same both each other these those".split(" "));

/** OR-query over the user's words so natural sentences still match. */
export function searchTerms(text: string): string {
  const words = (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w));
  return [...new Set(words)].slice(0, 12).join(" | ");
}

/** Reference excerpts from the knowledge base; never throws (chat works without it). */
export async function retrieve(query: Query, doctorId: string, text: string): Promise<string> {
  const q = searchTerms(text);
  if (!q) return "";
  try {
    const rows = await query(
      `SELECT title, left(content, 700) AS body FROM knowledge_chunks
       WHERE collection = $1 AND approved AND tsv @@ to_tsquery('english', $2)
       ORDER BY ts_rank_cd(tsv, to_tsquery('english', $2)) DESC LIMIT 3`,
      [doctorId === "dr_ananya" ? "mental_wellness" : "medical", q],
    );
    if (!rows.length) return "";
    return (
      "\nReference excerpts (informational only, may be incomplete or outdated; do not read aloud verbatim, never invent sources):\n" +
      rows.map((r, i) => `[${i + 1}] ${r.title}: ${r.body}`).join("\n")
    );
  } catch {
    return "";
  }
}

/** Protects the free AI allowance: per-user hourly cap plus a global daily cap. */
export async function chatAllowed(
  query: Query,
  userId: string,
  env: Pick<Env, "AI_USER_HOURLY_CAP" | "AI_DAILY_CAP">,
): Promise<"ok" | "user_limit" | "daily_limit"> {
  // Unlimited by default; set AI_USER_HOURLY_CAP / AI_DAILY_CAP to a positive number to enable a cap.
  const userCap = Number(env.AI_USER_HOURLY_CAP) || 0;
  const dayCap = Number(env.AI_DAILY_CAP) || 0;
  if (userCap <= 0 && dayCap <= 0) return "ok";
  const [u, d] = await Promise.all([
    query(
      `SELECT count(*)::int AS n FROM messages m JOIN sessions s ON s.id = m.session_id
       WHERE s.user_id = $1 AND m.role = 'user' AND m.created_at > now() - interval '1 hour'`,
      [userId],
    ),
    query(`SELECT count(*)::int AS n FROM messages WHERE role = 'assistant' AND created_at > date_trunc('day', now())`),
  ]);
  if (userCap > 0 && u[0].n >= userCap) return "user_limit";
  if (dayCap > 0 && d[0].n >= dayCap) return "daily_limit";
  return "ok";
}

type Chat = { role: "system" | "user" | "assistant"; content: string };

function tokenOf(chunk: any): string {
  if (typeof chunk?.response === "string") return chunk.response;
  return chunk?.choices?.[0]?.delta?.content ?? "";
}

/**
 * Workers AI models, newest-supported first. `@cf/meta/llama-3.1-8b-instruct` was retired by Cloudflare
 * (error 5028 "deprecated"), which broke every reply. Defaults here must not carry a planned deprecation
 * date in the Workers AI catalog. Kannada/Hindi use the larger model; English uses a cheaper one.
 */
export const DEFAULT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
export const DEFAULT_MODEL_LARGE = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export function modelFor(env: Env, language: string): string {
  return language === "kn" || language === "hi"
    ? env.AI_MODEL_LARGE || DEFAULT_MODEL_LARGE
    : env.AI_MODEL || DEFAULT_MODEL;
}

/** Primary model, then the other default as a same-provider fallback if Cloudflare retires the first. */
export function modelChain(env: Env, language: string): string[] {
  const primary = modelFor(env, language);
  return [...new Set([primary, DEFAULT_MODEL_LARGE, DEFAULT_MODEL])];
}

/** Reads an SSE stream (Workers AI or OpenAI-style) and returns the full text. */
export async function readSse(
  stream: ReadableStream<Uint8Array>,
  onToken: (t: string) => void,
  signal: { aborted: boolean },
): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const t = tokenOf(JSON.parse(data));
        if (t) {
          full += t;
          onToken(t);
        }
      } catch {
        /* partial JSON: ignore */
      }
    }
  }
  if (signal.aborted) await reader.cancel().catch(() => {});
  return full;
}

export type AiErrorKind = "quota" | "transient" | "config" | "other";

export class AiError extends Error {
  constructor(message: string, public status?: number, public retryAfterMs?: number) {
    super(message);
  }
}

/** Workers AI: 5028 = model deprecated, 5007 = no such model. Retrying the same model can never help. */
export function isModelGone(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e).toLowerCase();
  return /\b(5028|5007)\b|was deprecated|no such model|model .* not found/.test(msg);
}

/** Distinguishes exhausted quota (never retry) from temporary overload/network trouble (retry). */
export function classifyAiError(e: unknown): AiErrorKind {
  const msg = String((e as any)?.message ?? e).toLowerCase();
  const status = (e as any)?.status as number | undefined;
  if (isModelGone(e)) return "config";
  if (msg.includes("ai_not_configured") || msg.includes("ai_binding_missing") || status === 401 || status === 403 || status === 404) return "config";
  if (/daily|allocation|neurons|quota|insufficient|billing|exceeded your|4006/.test(msg)) return "quota";
  if (status && [500, 502, 503, 504, 429].includes(status)) return "transient";
  if (/capacity|overload|temporar|timeout|timed out|network|fetch failed|unavailable|try again|internal|3040|\b(429|500|502|503|504)\b/.test(msg)) return "transient";
  return "other";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Streams a Workers AI completion, calling onToken per piece. */
async function streamWorkersAi(
  env: Env,
  messages: Chat[],
  language: string,
  onToken: (t: string) => void,
  signal: { aborted: boolean },
): Promise<string> {
  if (!env.AI) throw new Error("ai_binding_missing");
  let lastErr: unknown;
  for (const model of modelChain(env, language)) {
    try {
      const out: any = await env.AI.run(model, { messages, stream: true, max_tokens: 320, temperature: 0.6 });
      return await readSse(out as ReadableStream<Uint8Array>, onToken, signal);
    } catch (e) {
      lastErr = e;
      if (!isModelGone(e)) throw e;
      console.error("ai_model_unavailable", model, String((e as Error).message).slice(0, 160));
    }
  }
  throw lastErr;
}

/** Any OpenAI-compatible streaming endpoint (Groq, Gemini, OpenRouter…). */
async function streamExternal(
  env: Env,
  messages: Chat[],
  language: string,
  onToken: (t: string) => void,
  signal: { aborted: boolean },
): Promise<string> {
  const base = (env.AI_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
  const model = (language === "kn" || language === "hi" ? env.AI_MODEL_LARGE_EXTERNAL : env.AI_MODEL_EXTERNAL) ||
    env.AI_MODEL_EXTERNAL || "llama-3.3-70b-versatile";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.AI_API_KEY}` },
    body: JSON.stringify({ model, messages, stream: true, max_tokens: 320, temperature: 0.6 }),
  });
  if (!res.ok || !res.body) {
    const ra = Number(res.headers.get("retry-after"));
    throw new AiError(`external_ai_${res.status}`, res.status, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
  }
  return readSse(res.body, onToken, signal);
}

/** Uses the external provider when configured (much larger free limits), with Workers AI as fallback. */
export async function streamAi(
  env: Env,
  messages: Chat[],
  language: string,
  onToken: (t: string) => void,
  signal: { aborted: boolean },
): Promise<string> {
  const order: Array<typeof streamWorkersAi> = [];
  if (env.AI_API_KEY) order.push(streamExternal);
  if (env.AI) order.push(streamWorkersAi);
  if (!order.length) throw new Error("ai_not_configured");
  const attempts = Math.max(1, Number(env.AI_MAX_ATTEMPTS) || 3);
  let lastErr: unknown;
  for (const provider of order) {
    let emitted = false;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await provider(env, messages, language, (t) => ((emitted = true), onToken(t)), signal);
      } catch (e) {
        lastErr = e;
        console.error("ai_provider_failed", provider === streamExternal ? "external" : "workers_ai", attempt, String((e as Error).message).slice(0, 160));
        if (emitted || signal.aborted) throw e; // never retry/switch providers mid-reply
        if (classifyAiError(e) !== "transient" || attempt === attempts) break;
        const base = Math.min(4000, 400 * 2 ** (attempt - 1));
        const wait = Math.min(8000, (e as AiError).retryAfterMs ?? base + Math.random() * base * 0.5);
        await sleep(env.AI_RETRY_DELAY_MS === "0" ? 0 : wait);
      }
    }
  }
  throw lastErr;
}

export async function handleWs(req: Request, env: Env, makeQuery: (e: Env) => Query, sessionId: string) {
  if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
  const url = new URL(req.url);
  const cookie = req.headers.get("Cookie")?.match(new RegExp(`(?:^|;\\s*)${env.AUTH_COOKIE_NAME}=([^;]+)`))?.[1];
  const token = url.searchParams.get("token") || cookie || "";

  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  const send = (o: unknown) => {
    try {
      server.send(JSON.stringify(o));
    } catch {
      /* closed */
    }
  };

  const query = makeQuery(env);
  const uid = token ? await subjectFromToken(env, token) : null;
  const session = uid
    ? (await query(
        `SELECT s.id, s.status, a.avatar_metadata AS meta FROM sessions s JOIN avatars a ON a.id = s.avatar_id
         WHERE s.id = $1 AND s.user_id = $2`,
        [sessionId, uid],
      ))[0]
    : undefined;
  if (!session || session.status !== "active") {
    server.close(4401, "Unauthorized");
    return new Response(null, { status: 101, webSocket: client });
  }
  const doctorId: string = session.meta?.doctor_id in DOCTORS ? session.meta.doctor_id : "dr_arjun";
  let language = "en";
  let turn = { aborted: false };
  let busy = false;

  server.addEventListener("message", (ev: MessageEvent) => {
    let data: any;
    try {
      data = JSON.parse(String(ev.data));
    } catch {
      return send({ type: "error", message: "Invalid message" });
    }
    switch (data?.type) {
      case "ping":
        return send({ type: "pong" });
      case "set_language":
        language = normaliseLanguage(data.language);
        return;
      case "stop":
      case "interrupt":
        turn.aborted = true;
        return send({ type: "interrupted", message: "Interrupted" });
      case "audio": {
        if (typeof data.audio !== "string" || !data.audio) return send({ type: "error", message: "Missing audio data" });
        if (data.audio.length > 6_000_000) return send({ type: "error", message: "Audio payload too large" });
        turn.aborted = true;
        const mine = (turn = { aborted: false });
        void transcribeThenRun(data.audio, mine);
        return;
      }
      case "text": {
        const text = typeof data.text === "string" ? data.text.trim().slice(0, MAX_TEXT) : "";
        if (!text) return send({ type: "error", message: "Empty message" });
        turn.aborted = true; // barge-in
        const mine = (turn = { aborted: false });
        void run(text, mine);
        return;
      }
      case "frame": {
        void observe(data.image);
        return;
      }
      case "set_voice":
        return;
    }
  });


  // The doctor watches the patient's camera. A small frame is described by a free vision model; if something is
  // notable the doctor asks about it, gently, like a clinician would. Observations are never stored or diagnosed.
  let lastObserved = 0;
  async function observe(image: unknown) {
    const now = Date.now();
    if (busy || !env.AI || typeof image !== "string" || now - lastObserved < 15_000) return;
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(image);
    if (!m || m[1].length > 200_000) return;
    lastObserved = now;
    busy = true;
    const mine = { aborted: false };
    try {
      const bin = atob(m[1]);
      const bytes = Array.from({ length: bin.length }, (_, i) => bin.charCodeAt(i));
      const v: any = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
        image: bytes,
        max_tokens: 60,
        prompt:
          "USER: This is a still frame from a patient's video consultation. In one short sentence, describe only what a doctor would clearly notice: a face showing pain or distress, holding a body part, visible redness or swelling, pale or sweaty look, slumped posture, or coughing. Do not guess or diagnose. If nothing stands out, answer exactly NONE.\nASSISTANT:",
      });
      const seen = String(v?.description ?? v?.response ?? "").trim();
      if (!seen || /^none\b/i.test(seen) || seen.length < 8) return;
      const hist = (
        await query(`SELECT role, content FROM messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT 10`, [sessionId])
      ).reverse() as Chat[];
      const lang = LANGS[language] ?? language;
      const sys = `${systemPrompt(doctorId)}\nCurrent consultation language: ${lang}. Respond entirely in ${lang}; use 1-2 short sentences, no markdown.\nYou can see the patient on camera. A camera check noted (it may be wrong): "${seen}". Gently mention what you noticed and ask how they are feeling or if something hurts. Never state a diagnosis. Do not mention cameras or AI analysis.`;
      const reply = await streamAi(env, [{ role: "system", content: sys }, ...hist, { role: "user", content: "(The patient is quietly on camera.)" }], language, (t) => send({ type: "token", token: t }), mine);
      const content = validateAiResponse(reply.trim());
      if (!content) return;
      send({ type: "message", role: "assistant", content });
      await query(`INSERT INTO messages (id, session_id, role, content) VALUES ($1,$2,'assistant',$3)`, [crypto.randomUUID(), sessionId, content]);
    } catch (e) {
      console.error("ws_observe_failed", String((e as Error).message).slice(0, 160)); // silent: observing is optional
    } finally {
      busy = false;
    }
  }

  async function transcribeThenRun(b64: string, mine: { aborted: boolean }) {
    try {
      send({ type: "status", message: "Transcribing audio…", stage: "transcription" });
      const r: any = await env.AI!.run("@cf/openai/whisper-large-v3-turbo", { audio: b64, language });
      const text = String(r?.text ?? "").trim();
      if (!text) return send({ type: "error", message: "Could not transcribe audio" });
      send({ type: "transcription", text });
      await run(text, mine);
    } catch (e) {
      console.error("ws_stt_failed", String((e as Error).message).slice(0, 200));
      send({ type: "error", message: "Could not transcribe audio" });
    }
  }

  async function run(text: string, mine: { aborted: boolean }) {
    while (busy) await new Promise((r) => setTimeout(r, 25));
    busy = true;
    try {
      const gate = await chatAllowed(query, uid!, env);
      if (gate !== "ok") {
        return send({
          type: "error",
          message:
            gate === "user_limit"
              ? "You've reached the hourly message limit. Please try again a little later."
              : "The free doctor service has reached today's limit. Please try again tomorrow.",
        });
      }
      send({ type: "status", message: "Thinking…", stage: "llm" });
      // Save the user's message, load history and (for kn/hi) translate for retrieval all at once:
      // none depends on another, so this costs one round trip instead of three.
      const saveUser = query(`INSERT INTO messages (id, session_id, role, content) VALUES ($1,$2,'user',$3)`, [
        crypto.randomUUID(),
        sessionId,
        text,
      ]);
      const loadHist = query(`SELECT role, content FROM messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT 14`, [
        sessionId,
      ]);
      const translate = (async () => {
        if (language === "en" || !env.AI) return text;
        // Knowledge base is English: get an English search phrase for Kannada/Hindi input.
        try {
          const t: any = await env.AI.run(modelFor(env, "en"), {
            messages: [{ role: "user", content: `Translate to English, output only the translation:\n${text}` }],
            max_tokens: 80,
          });
          return String(t?.response ?? text);
        } catch {
          return text; /* fall back to original text */
        }
      })();
      const [, prior, searchText] = await Promise.all([saveUser, loadHist, translate]);
      // The history was read before the new message landed, so add it here (kept out of the DB race).
      const hist = [...(prior as Chat[]).reverse(), { role: "user", content: text } as Chat];
      // Deterministic emergency escalation runs before any AI reply (same rules as the Python service).
      const triage = [text, searchText].map(evaluatePatientQuery).find((t) => t.is_emergency);
      if (triage) {
        const reply = triage.emergency_message!;
        await query(`INSERT INTO messages (id, session_id, role, content) VALUES ($1,$2,'assistant',$3)`, [
          crypto.randomUUID(), sessionId, reply,
        ]);
        send({ type: "message", role: "assistant", content: reply, triage: 4, is_emergency: true });
        return;
      }
      const refs = await retrieve(query, doctorId, searchText);
      const lang = LANGS[language] ?? language;
      const sys = `${systemPrompt(doctorId)}\nCurrent consultation language: ${lang}. Respond entirely in ${lang}; use 1-3 short sentences, no markdown or lists.${refs}`;
      const reply = await streamAi(env, [{ role: "system", content: sys }, ...hist], language, (t) => send({ type: "token", token: t }), mine);
      if (mine.aborted) return;
      const content = validateAiResponse(reply.trim()) || "I'm here. Could you tell me a little more?";
      // Deliver first; persisting is not on the user's critical path.
      send({ type: "message", role: "assistant", content });
      await query(`INSERT INTO messages (id, session_id, role, content) VALUES ($1,$2,'assistant',$3)`, [
        crypto.randomUUID(),
        sessionId,
        content,
      ]);
    } catch (e) {
      console.error("ws_turn_failed", String((e as Error).message).slice(0, 200));
      const kind = classifyAiError(e);
      send({
        type: "error",
        code: kind === "quota" ? "ai_quota" : kind === "transient" ? "ai_busy" : kind === "config" ? "ai_unconfigured" : "ai_error",
        recoverable: kind !== "config",
        message:
          kind === "quota"
            ? "The AI doctor has reached its free daily limit. Please try again tomorrow."
            : kind === "transient"
              ? "The AI doctor is temporarily busy. Your call is still connected; please say or send your message again in a moment."
              : kind === "config"
                ? "The AI doctor is not available right now."
                : "Something went wrong while preparing the reply. Your call is still connected; please try again.",
      });
    } finally {
      busy = false;
    }
  }

  return new Response(null, { status: 101, webSocket: client });
}
