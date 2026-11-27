// Server-side doctor voice for Kannada, Hindi and English (free-tier friendly, Workers-compatible).
//
// Providers (TTS_PROVIDER = auto | gemini | google_translate | off):
//   gemini            Official Gemini speech API. Free tier with an AI Studio key (GEMINI_API_KEY). Two doctor voices.
//   google_translate  Keyless Google Translate speech endpoint. UNOFFICIAL: it can be rate-limited or blocked and has
//                     one voice for both doctors. Used by `auto` only when no Gemini key is configured.
// Voice is never left to one provider: synthesizeSpeech walks a chain (Gemini -> Cloudflare Workers AI MeloTTS for
// English -> keyless Google), each with its own short timeout, and only when all fail does the caller fall back to the
// browser's own voice (which itself has a further audio backup in the frontend). No reply text is ever invented.
import type { Env } from "./env";

export interface SpeechPart {
  mime: string;
  data: string; // base64
  text: string;
}

const MAX_CHARS = 170; // keeps each chunk under the Google endpoint's ~200 character limit

/** Splits a reply into sentence-sized chunks (handles Latin, Devanagari and Kannada punctuation). */
export function splitForSpeech(text: string, max = MAX_CHARS): string[] {
  const clean = text.replace(/\*+|_{2,}|#+\s*/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?।॥…]+[.!?।॥…]*/g) ?? [clean];
  const out: string[] = [];
  let cur = "";
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; };
  for (const s of sentences.map((x) => x.trim()).filter(Boolean)) {
    if (s.length > max) {
      push();
      let rest = s;
      while (rest.length > max) {
        let cut = Math.max(rest.lastIndexOf(",", max), rest.lastIndexOf(" ", max));
        if (cut < max / 2) cut = max;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      cur = rest;
    } else if ((cur + " " + s).trim().length > max) {
      push();
      cur = s;
    } else {
      cur = (cur + " " + s).trim();
    }
  }
  push();
  return out.filter(Boolean);
}

/** Cheap base64 for Worker CPU limits: chunked btoa, no per-byte string concatenation of the whole buffer. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}

/**
 * Wraps base64 16-bit mono PCM in a WAV container without decoding it. The header is 54 bytes (a multiple of 3,
 * thanks to a 2-byte JUNK chunk), so its base64 can simply be prepended to the PCM's base64.
 */
export function pcmBase64ToWavBase64(pcmB64: string, sampleRate = 24000): string {
  const pad = pcmB64.endsWith("==") ? 2 : pcmB64.endsWith("=") ? 1 : 0;
  const dataLen = (pcmB64.length * 3) / 4 - pad;
  const h = new DataView(new ArrayBuffer(54));
  const tag = (o: number, s: string) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  tag(0, "RIFF"); h.setUint32(4, 46 + dataLen, true); tag(8, "WAVE");
  tag(12, "fmt "); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, sampleRate, true); h.setUint32(28, sampleRate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
  tag(36, "JUNK"); h.setUint32(40, 2, true); h.setUint16(44, 0, true);
  tag(46, "data"); h.setUint32(50, dataLen, true);
  return bytesToBase64(new Uint8Array(h.buffer)) + pcmB64;
}

type Provider = "gemini" | "google_translate" | "off";

export function ttsProvider(env: Pick<Env, "TTS_PROVIDER" | "GEMINI_API_KEY">): Provider {
  const p = String(env.TTS_PROVIDER || "auto").toLowerCase();
  if (p === "off") return "off";
  if (p === "gemini") return env.GEMINI_API_KEY ? "gemini" : "off";
  if (p === "google_translate") return "google_translate";
  return env.GEMINI_API_KEY ? "gemini" : "google_translate";
}

async function geminiSpeak(env: Env, text: string, doctorId: string): Promise<SpeechPart> {
  const model = env.TTS_MODEL || "gemini-2.5-flash-preview-tts";
  const voice = doctorId === "dr_ananya" ? env.TTS_VOICE_FEMALE || "Kore" : env.TTS_VOICE_MALE || "Charon";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": String(env.GEMINI_API_KEY) },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
  });
  if (!res.ok) throw new Error(`tts_gemini_${res.status}`);
  const j: any = await res.json();
  const part = j?.candidates?.[0]?.content?.parts?.find((p: any) => p?.inlineData?.data)?.inlineData;
  if (!part?.data) throw new Error("tts_gemini_empty");
  const rate = Number(/rate=(\d+)/.exec(String(part.mimeType))?.[1]) || 24000;
  return { mime: "audio/wav", data: pcmBase64ToWavBase64(part.data, rate), text };
}

/** Cloudflare Workers AI text-to-speech (MeloTTS, English only). Uses the Worker's own AI binding: no extra key, no extra host. */
async function workersAiSpeak(env: Env, text: string): Promise<SpeechPart> {
  if (!env.AI) throw new Error("tts_workersai_unbound");
  const out: any = await env.AI.run("@cf/myshell-ai/melotts", { prompt: text, lang: "en" });
  const audio = out?.audio ?? out;
  let b64: string | null = null;
  if (typeof audio === "string") b64 = audio.replace(/^data:[^,]*,/, "");
  else if (audio instanceof Uint8Array || audio instanceof ArrayBuffer) b64 = bytesToBase64(audio instanceof Uint8Array ? audio : new Uint8Array(audio));
  if (!b64 || b64.length < 200) throw new Error("tts_workersai_empty");
  return { mime: "audio/mpeg", data: b64, text };
}

async function googleTranslateSpeak(text: string, language: string): Promise<SpeechPart> {
  const tl = language === "kn" ? "kn" : language === "hi" ? "hi" : "en";
  let lastStatus = 0;
  // Two client ids: when one is rate-limited the other is often still served.
  for (const client of ["tw-ob", "gtx"]) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=${client}&tl=${tl}&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", referer: "https://translate.google.com/" } });
    if (res.ok) {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length >= 200) return { mime: "audio/mpeg", data: bytesToBase64(buf), text };
      lastStatus = -1;
    } else lastStatus = res.status;
  }
  throw new Error(lastStatus === -1 ? "tts_google_empty" : `tts_google_${lastStatus}`);
}

export type Engine = "gemini" | "workers_ai" | "google_translate";

/** Ordered list of engines to try for this language. Empty when the server voice is switched off. */
export function ttsChain(env: Pick<Env, "TTS_PROVIDER" | "GEMINI_API_KEY" | "AI">, language: string): Engine[] {
  const want = String(env.TTS_PROVIDER || "auto").toLowerCase();
  if (want === "off") return [];
  const chain: Engine[] = [];
  if (env.GEMINI_API_KEY) chain.push("gemini");
  if (env.AI && language === "en") chain.push("workers_ai");
  chain.push("google_translate");
  // An explicitly named engine goes first; the others stay behind it as backups.
  const first = want as Engine;
  return chain.includes(first) ? [first, ...chain.filter((e) => e !== first)] : chain;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("tts_timeout")), ms); });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
    work.catch(() => {}); // avoid an unhandled rejection if the timeout won
  }
}

/**
 * Synthesises a reply into ordered audio parts, trying each engine in turn. `timeoutMs` bounds one engine; the whole
 * chain is bounded at twice that. Throws the last error only when every engine failed, so the caller can fall back
 * to the device voice.
 */
export async function synthesizeSpeech(env: Env, text: string, language: string, doctorId: string, timeoutMs = 4500): Promise<SpeechPart[]> {
  const chain = ttsChain(env, language);
  if (!chain.length) return [];
  const chunks = splitForSpeech(text).slice(0, 6);
  if (!chunks.length) return [];
  const deadline = Date.now() + timeoutMs * 2;
  let lastError: Error = new Error("tts_failed");
  for (const engine of chain) {
    const left = Math.min(timeoutMs, deadline - Date.now());
    if (left <= 0) break;
    try {
      const run = (c: string) => (engine === "gemini" ? geminiSpeak(env, c, doctorId) : engine === "workers_ai" ? workersAiSpeak(env, c) : googleTranslateSpeak(c, language));
      return await withTimeout(Promise.all(chunks.map(run)), left);
    } catch (e) {
      lastError = e as Error;
      console.error("tts_engine_failed", engine, String(lastError.message).slice(0, 80));
    }
  }
  throw lastError;
}
