/**
 * Doctor voice for the landing page (hero greeting + language viewer).
 *
 * Order of preference, per line:
 *  1. A recorded neural voice from /audio/landing/<kind>-<lang>.mp3 when one has been generated
 *     (scripts/generate-landing-voices.py). Sounds the same on every device.
 *  2. The best female voice installed on the visitor's device for that language (neural/online
 *     voices first), spoken a little slower and higher for a warm tone.
 *  3. No voice for that language on this device: report it so the UI can say so honestly.
 *
 * Only one line plays at a time; starting a new one ends the previous one. Mouth shapes are
 * published on `mouthChannel` (device voice) or read from the playing audio (recorded voice), so
 * the animated portrait follows whatever is actually being said.
 */
import lines from './landingLines.json'
import { attachAudioAnalyser } from './audioEnergy'
import { startLipSync, type LipSyncHandle } from './visemes'

export type LandingLang = 'kn' | 'hi' | 'en'
export type LandingKind = 'greet' | 'reply'
export type NoVoiceReason = 'unsupported' | 'no-voice'

export interface SpeakCallbacks {
  onStart?: () => void
  onEnd?: () => void
  onNoVoice?: (reason: NoVoiceReason) => void
}

export const lineText = (kind: LandingKind, lang: LandingLang): string => lines[kind][lang]

const TAG: Record<LandingLang, string> = { kn: 'kn-in', hi: 'hi-in', en: 'en-in' }
const BCP47: Record<LandingLang, string> = { kn: 'kn-IN', hi: 'hi-IN', en: 'en-IN' }
const FEMALE = /female|woman|swara|sapna|neerja|kalpana|veena|lekha|heera|priya|soumya|aria|jenny|sonia|zira|samantha|karen|tessa|google (hindi|kannada|uk english female|us english)/i
const MALE = /(?<!fe)male|madhur|gagan|prabhat|ravi|hemant|rishi|david|mark|george|daniel/i

function rankVoice(v: SpeechSynthesisVoice, lang: LandingLang): number {
  const tag = v.lang.toLowerCase().replace('_', '-')
  return (
    (tag === TAG[lang] ? 4 : 0) +
    (FEMALE.test(v.name) ? 5 : 0) -
    (MALE.test(v.name) ? 6 : 0) +
    (/natural|neural|online|google/i.test(v.name) ? 3 : 0) +
    (v.localService ? 0 : 1)
  )
}

function pickVoice(lang: LandingLang): SpeechSynthesisVoice | null {
  const matches = window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(lang))
  if (!matches.length) return null
  return matches.sort((a, b) => rankVoice(b, lang) - rankVoice(a, lang))[0]
}

/** Voices load asynchronously in Chrome; wait briefly for them instead of failing on the first tap. */
function voicesReady(): Promise<void> {
  const synth = window.speechSynthesis
  if (synth.getVoices().length) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      synth.removeEventListener('voiceschanged', done)
      resolve()
    }
    synth.addEventListener('voiceschanged', done)
    window.setTimeout(done, 1200)
  })
}

let manifest: Promise<Set<string>> | null = null
function recordedClips(): Promise<Set<string>> {
  manifest ??= fetch('/audio/landing/manifest.json')
    .then((r) => (r.ok ? (r.json() as Promise<string[]>) : []))
    .catch(() => [] as string[])
    .then((ids) => new Set(ids))
  return manifest
}

let active: { id: number; stop: () => void } | null = null
let counter = 0

/** Stop whatever is playing (ends it normally, so UI state resets through onEnd). */
export function stopSpeaking() {
  active?.stop()
}

export function speakLine(kind: LandingKind, lang: LandingLang, cb: SpeakCallbacks = {}) {
  if (typeof window === 'undefined') return
  stopSpeaking()
  const id = ++counter
  const text = lineText(kind, lang)
  let finished = false
  let lip: LipSyncHandle | null = null
  let audio: HTMLAudioElement | null = null
  let watchdog: number | undefined

  const finish = () => {
    if (finished) return
    finished = true
    window.clearTimeout(watchdog)
    lip?.stop()
    if (audio) {
      audio.onended = audio.onerror = audio.onplaying = null
      audio.pause()
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    if (active?.id === id) active = null
    cb.onEnd?.()
  }
  active = { id, stop: finish }

  const speakWithDevice = async () => {
    if (!('speechSynthesis' in window)) {
      cb.onNoVoice?.('unsupported')
      finish()
      return
    }
    await voicesReady()
    if (finished) return
    const voice = pickVoice(lang)
    if (!voice && lang !== 'en') {
      cb.onNoVoice?.('no-voice')
      finish()
      return
    }
    const utterance = new SpeechSynthesisUtterance(text)
    // Keep a reference: Chrome can garbage-collect a playing utterance and never fire onend.
    ;(window as unknown as { __landingUtterance?: SpeechSynthesisUtterance }).__landingUtterance = utterance
    if (voice) utterance.voice = voice
    utterance.lang = voice?.lang ?? BCP47[lang]
    utterance.rate = 0.92
    utterance.pitch = 1.1
    lip = startLipSync(text, utterance.rate)
    utterance.onstart = () => cb.onStart?.()
    utterance.onboundary = (e) => lip?.boundary(e.charIndex)
    utterance.onend = finish
    utterance.onerror = finish
    watchdog = window.setTimeout(finish, Math.max(6000, text.length * 140 + 4000))
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
  }

  void recordedClips().then((clips) => {
    if (finished) return
    const clipId = `${kind}-${lang}`
    if (!clips.has(clipId)) return void speakWithDevice()
    audio = new Audio(`/audio/landing/${clipId}.mp3`)
    attachAudioAnalyser(audio, false)
    audio.onplaying = () => cb.onStart?.()
    audio.onended = finish
    audio.onerror = () => {
      audio = null
      void speakWithDevice()
    }
    audio.play().catch(() => {
      audio = null
      void speakWithDevice()
    })
  })
}
