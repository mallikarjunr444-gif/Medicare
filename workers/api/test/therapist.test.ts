import { describe, expect, it, vi, afterEach } from "vitest";
import { fallbackReply, openingLine, planNext, PSYCH_TOPICS, GP_TOPICS } from "../src/therapist";
import { checkScope } from "../src/scope";
import { ttsChain, synthesizeSpeech } from "../src/tts";
import { streamAi, maxTokensFor } from "../src/ws";

describe("therapist interview plan", () => {
  it("the doctor opens the session in each language, stating it is an AI", () => {
    expect(openingLine("dr_ananya", "en")).toMatch(/not a licensed psychologist/);
    expect(openingLine("dr_ananya", "kn")).toContain("ಅನನ್ಯಾ");
    expect(openingLine("dr_arjun", "hi")).toContain("स्मित");
  });
  it("walks through the topics in order, one at a time", () => {
    const asked = new Set<string>();
    const order: string[] = [];
    for (let i = 0; i < 9; i++) {
      const p = planNext("dr_ananya", asked, "", i + 1);
      if (!p.topic) break;
      order.push(p.topic.key);
      asked.add(p.topic.key);
    }
    expect(order).toEqual(PSYCH_TOPICS.map((t) => t.key));
    expect(order.indexOf("safety")).toBeGreaterThan(order.indexOf("mood")); // risk is asked after rapport, once
  });
  it("does not ask what the client already volunteered", () => {
    const p = planNext("dr_ananya", new Set(), "I have been very anxious and cannot sleep for 3 weeks", 2);
    expect(p.topic?.key).toBe("mood");
    expect(p.directive).toContain("anxiety");
    expect(p.directive).toContain("ONE");
  });
  it("finishes with free conversation after the plan, and has a GP history plan", () => {
    const all = new Set(PSYCH_TOPICS.map((t) => t.key));
    const p = planNext("dr_ananya", all, "", 12);
    expect(p.topic).toBeNull();
    expect(planNext("dr_arjun", new Set(), "", 1).topic?.key).toBe(GP_TOPICS[0].key);
  });
  it("scripted fallback is a short acknowledgement plus the planned question, in the right language", () => {
    const t = PSYCH_TOPICS[1];
    expect(fallbackReply("dr_ananya", "kn", t)).toContain(t.q.kn);
    expect(fallbackReply("dr_ananya", "hi", t)).toContain("सुन रही हूँ");
    expect(fallbackReply("dr_arjun", "en", null)).toBe("Thank you for telling me that.");
  });
  it("all scripted questions exist in all three languages", () => {
    for (const t of [...PSYCH_TOPICS, ...GP_TOPICS]) for (const l of ["en", "hi", "kn"] as const) expect(t.q[l].length).toBeGreaterThan(10);
  });
  it("world war questions are out of scope", () => {
    expect(checkScope("tell me about world war two please").allowed).toBe(false);
  });
});

describe("voice fallback chain", () => {
  const orig = globalThis.fetch;
  afterEach(() => { globalThis.fetch = orig; });
  it("orders engines: Gemini, keyless Google, then MeloTTS for English only", () => {
    expect(ttsChain({ GEMINI_API_KEY: "k", AI: {} }, "en")).toEqual(["gemini", "google_translate", "melotts"]);
    expect(ttsChain({ GEMINI_API_KEY: "k", AI: {} }, "kn")).toEqual(["gemini", "google_translate"]);
    expect(ttsChain({}, "kn")).toEqual(["google_translate"]);
    expect(ttsChain({ TTS_PROVIDER: "off" }, "en")).toEqual([]);
  });
  it("falls back to the next engine when the first fails", async () => {
    globalThis.fetch = (async (u: any) =>
      String(u).includes("googleapis") ? new Response("quota", { status: 429 }) : new Response(new Uint8Array(400).fill(7))) as any;
    const parts = await synthesizeSpeech({ GEMINI_API_KEY: "k" } as any, "ನಮಸ್ಕಾರ. ಹೇಗಿದ್ದೀರಿ?", "kn", "dr_ananya");
    expect(parts.length).toBeGreaterThan(0);
    expect(parts[0].mime).toBe("audio/mpeg");
  });
  it("uses Workers AI MeloTTS in English when both web engines fail", async () => {
    globalThis.fetch = (async () => new Response("blocked", { status: 403 })) as any;
    const env: any = { AI: { run: async () => ({ audio: "A".repeat(300) }) } };
    const parts = await synthesizeSpeech(env, "Hello, how are you?", "en", "dr_arjun");
    expect(parts[0].data).toBe("A".repeat(300));
  });
  it("throws only when every engine failed (device voice then speaks)", async () => {
    globalThis.fetch = (async () => new Response("no", { status: 500 })) as any;
    await expect(synthesizeSpeech({} as any, "ನಮಸ್ಕಾರ", "kn", "dr_ananya")).rejects.toThrow();
  });
});

describe("AI backup model", () => {
  it("tries the backup Workers AI model when the first fails with an unclassified error", async () => {
    const calls: string[] = [];
    const sse = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: {"response":"ok"}\n')); c.close(); } });
    const env: any = { AI: { run: async (model: string) => { calls.push(model); if (calls.length === 1) throw new Error("InferenceUpstreamError: weird"); return sse(); } } };
    const out = await streamAi(env, [{ role: "user", content: "hi" }], "kn", () => {}, { aborted: false });
    expect(out).toBe("ok");
    expect(calls.length).toBe(2);
  });
  it("gives Kannada and Hindi a bigger token budget than English", () => {
    expect(maxTokensFor("kn")).toBeGreaterThan(maxTokensFor("en"));
  });
});
