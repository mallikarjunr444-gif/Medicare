// Server-side doctor voice for Kannada, Hindi and English (free-tier friendly, Workers-compatible).
//
// Providers (TTS_PROVIDER = auto | gemini | google_translate | off):
//   gemini            Official Gemini speech API. Free tier with an AI Studio key (GEMINI_API_KEY). Two doctor voices.
//   google_translate  Keyless Google Translate speech endpoint. UNOFFICIAL: it can be rate-limited or blocked and has
//                     one voice for both doctors.
//   melotts           Cloudflare Workers AI (English only), no key needed.
// Engines form a FALLBACK CHAIN (gemini -> google_translate -> melotts): if one fails for a reply, the next one speaks it.
// Only if every engine fails does the caller fall back to the browser's own voice; no reply text is ever invented.
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
    signal: AbortSignal.timeout(5000),
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

async function googleTranslateSpeak(text: string, language: string): Promise<SpeechPart> {
  const tl = language === "kn" ? "kn" : language === "hi" ? "hi" : "en";
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${tl}&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", referer: "https://translate.google.com/" }, signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`tts_google_${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < 200) throw new Error("tts_google_empty");
  return { mime: "audio/mpeg", data: bytesToBase64(buf), text };
}

export type Engine = "gemini" | "google_translate" | "melotts";

/** Engines to try, best first. Keyless engines are always kept as a backup so a missing/limited key never means silence. */
export function ttsChain(env: Pick<Env, "TTS_PROVIDER" | "GEMINI_API_KEY"> & { AI?: unknown }, language: string): Engine[] {
  const p = String(env.TTS_PROVIDER || "auto").toLowerCase();
  if (p === "off") return [];
  const chain: Engine[] = [];
  if (env.GEMINI_API_KEY && p !== "google_translate") chain.push("gemini");
  chain.push("google_translate");
  if (language === "en" && env.AI) chain.push("melotts"); // MeloTTS has no Kannada/Hindi voice
  return chain;
}

/** Workers AI MeloTTS (English). Returns base64 MP3. */
async function meloSpeak(env: Env, text: string): Promise<SpeechPart> {
  if (!env.AI) throw new Error("tts_melo_no_binding");
  const out: any = await Promise.race([
    env.AI.run("@cf/myshell-ai/melotts" as any, { prompt: text, lang: "en" } as any),
    new Promise((_, rej) => setTimeout(() => rej(new Error("tts_melo_timeout")), 6000)),
  ]);
  const audio = typeof out === "string" ? out : out?.audio;
  if (typeof audio === "string" && audio.length > 100) return { mime: "audio/mpeg", data: audio, text };
  if (audio instanceof Uint8Array || audio instanceof ArrayBuffer) return { mime: "audio/mpeg", data: bytesToBase64(new Uint8Array(audio as ArrayBuffer)), text };
  throw new Error("tts_melo_empty");
}

function speakWith(engine: Engine, env: Env, text: string, language: string, doctorId: string): Promise<SpeechPart> {
  if (engine === "gemini") return geminiSpeak(env, text, doctorId);
  if (engine === "melotts") return meloSpeak(env, text);
  return googleTranslateSpeak(text, language);
}

/**
 * Synthesises a reply into ordered audio parts, trying each engine in the chain. An engine that fails once is skipped
 * for the rest of this reply. Throws only if every engine failed, so the caller can use the device voice.
 */
export async function synthesizeSpeech(env: Env, text: string, language: string, doctorId: string, timeoutMs = 9000): Promise<SpeechPart[]> {
  const chain = ttsChain(env, language);
  if (!chain.length) return [];
  const chunks = splitForSpeech(text).slice(0, 6);
  if (!chunks.length) return [];
  const dead = new Set<Engine>();
  const one = async (c: string): Promise<SpeechPart> => {
    let last: unknown = new Error("tts_no_engine");
    for (const engine of chain) {
      if (dead.has(engine)) continue;
      try {
        return await speakWith(engine, env, c, language, doctorId);
      } catch (e) {
        last = e;
        dead.add(engine);
        console.error("tts_engine_failed", engine, String((e as Error)?.message).slice(0, 80));
      }
    }
    throw last;
  };
  const work = Promise.all(chunks.map(one));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("tts_timeout")), timeoutMs); });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
    work.catch(() => {}); // avoid an unhandled rejection if the timeout won
  }
}
