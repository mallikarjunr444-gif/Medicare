'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { mouthChannel, startLipSync, type LipSyncHandle } from '@/lib/visemes'
import type { ConsultationLanguage, DoctorId, DoctorState } from '@/lib/doctorTypes'

/** Sentence-sized pieces (the audio endpoint accepts about 200 characters at a time). */
function speechChunks(text: string, max = 170): string[] {
  const clean = text.replace(/\*+|_{2,}|#+\s*/g, '').replace(/\s+/g, ' ').trim()
  const sentences = clean.match(/[^.!?।॥…]+[.!?।॥…]*/g) ?? [clean]
  const out: string[] = []
  let cur = ''
  for (const raw of sentences) {
    let s = raw.trim()
    if (!s) continue
    while (s.length > max) {
      let cut = Math.max(s.lastIndexOf(',', max), s.lastIndexOf(' ', max))
      if (cut < max / 2) cut = max
      if (cur) { out.push(cur); cur = '' }
      out.push(s.slice(0, cut).trim())
      s = s.slice(cut).trim()
    }
    if ((cur + ' ' + s).trim().length > max) { if (cur) out.push(cur); cur = s } else cur = (cur + ' ' + s).trim()
  }
  if (cur) out.push(cur)
  return out.filter(Boolean)
}

/**
 * Last-resort voice: plays the reply through an audio element from the public Google text-to-speech endpoint, which has
 * Kannada, Hindi and English. Used when the server voice failed AND this device has no usable voice for the language.
 */
function playBackupVoice(text: string, lang: ConsultationLanguage, volume: () => number, onDone: () => void): { stop: () => void } {
  const chunks = speechChunks(text)
  let i = 0
  let stopped = false
  let current: HTMLAudioElement | null = null
  const next = () => {
    if (stopped) return
    if (i >= chunks.length) return onDone()
    const a = new Audio()
    current = a
    a.volume = volume()
    a.src = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${lang}&q=${encodeURIComponent(chunks[i])}`
    const advance = () => { a.onended = null; a.onerror = null; i++; next() }
    a.onended = advance
    a.onerror = advance // a failed piece is skipped; the captions still show it
    a.play().catch(advance)
  }
  next()
  return { stop: () => { stopped = true; if (current) { current.onended = null; current.onerror = null; current.pause(); current.removeAttribute('src') } } }
}

interface UseDoctorSpeechOptions {
  doctorId: DoctorId
  language: ConsultationLanguage
  onStateChange: (state: DoctorState) => void
  onSubtitleUpdate?: (text: string) => void
}

export function useDoctorSpeech({
  doctorId,
  language,
  onStateChange,
  onSubtitleUpdate,
}: UseDoctorSpeechOptions) {
  const lipSyncRef = useRef<LipSyncHandle | null>(null)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [audioLevel, setAudioLevel] = useState(0)
  const [isMuted, setIsMuted] = useState(false)
  const [subtitles, setSubtitles] = useState('')

  const synthRef = useRef<SpeechSynthesis | null>(null)
  const activeUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null)
  const animIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const watchdogTimerRef = useRef<NodeJS.Timeout | null>(null)
  const backupRef = useRef<{ stop: () => void } | null>(null)
  const isMutedRef = useRef(false)

  // Initialize SpeechSynthesis and ensure voices are loaded
  useEffect(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      synthRef.current = window.speechSynthesis
      // Unlock voices on load
      window.speechSynthesis.getVoices()
      window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices()
      }
    }
    // Browsers only allow speech after a user gesture. Prime the engine on the first tap/key/click so the
    // doctor's reply (which arrives later from the network) is allowed to speak.
    const unlock = () => {
      try {
        const synth = window.speechSynthesis
        if (!synth || synth.speaking) return
        const primer = new SpeechSynthesisUtterance(' ')
        primer.volume = 0
        synth.speak(primer)
      } catch {
        /* speech unavailable */
      }
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
      if (synthRef.current) {
        synthRef.current.cancel()
      }
      if (animIntervalRef.current) clearInterval(animIntervalRef.current)
      if (watchdogTimerRef.current) clearTimeout(watchdogTimerRef.current)
    }
  }, [])

  // Keep mute changes effective while a local doctor utterance is already playing.
  useEffect(() => {
    isMutedRef.current = isMuted
    if (activeUtteranceRef.current) {
      activeUtteranceRef.current.volume = isMuted ? 0 : 1
    }
  }, [isMuted])

  // Resolve matching speech voice
  const getDoctorVoice = useCallback((): SpeechSynthesisVoice | null => {
    if (!synthRef.current) return null
    const voices = synthRef.current.getVoices()
    if (!voices || voices.length === 0) return null

    const langMap: Record<ConsultationLanguage, string> = {
      kn: 'kn',
      hi: 'hi',
      en: 'en',
    }
    const prefix = langMap[language] || 'en'
    const tag = ({ kn: 'kn-in', hi: 'hi-in', en: 'en-in' } as Record<string, string>)[language] || 'en-in'
    const langVoices = voices
      .filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(prefix))
      // Best first: exact regional tag, then Google/online voices (usually clearer than OS defaults).
      .sort((x, y) => {
        const score = (v: SpeechSynthesisVoice) =>
          (v.lang.toLowerCase().replace('_', '-') === tag ? 4 : 0) + (/google|natural|neural/i.test(v.name) ? 2 : 0) + (v.localService ? 0 : 1)
        return score(y) - score(x)
      })

    if (langVoices.length > 0) {
      const wanted = doctorId === 'dr_ananya'
        ? /female|woman|girl|samantha|zira|swara|kalpana|veena|geeta|leela|neerja/i
        : /(?<!fe)male|man|boy|david|george|ravi|madhav|rishi|karthik|suresh|prabhat|hemant/i
      return langVoices.find((v) => wanted.test(v.name)) ?? langVoices[0]
    }

    // No voice for this language: return null so the engine picks one from utterance.lang
    // (reading Kannada/Hindi text with an English voice is silent or garbled).
    return null
  }, [language, doctorId])

  // Speak doctor response with watchdog & Chrome GC fix
  const speak = useCallback(
    (text: string) => {
      if (!synthRef.current) return

      // Cancel previous speech if ongoing
      synthRef.current.cancel()
      backupRef.current?.stop()
      backupRef.current = null
      if (animIntervalRef.current) clearInterval(animIntervalRef.current)
      if (watchdogTimerRef.current) clearTimeout(watchdogTimerRef.current)

      onStateChange('speaking')
      setIsSpeaking(true)
      setSubtitles(text)
      if (onSubtitleUpdate) onSubtitleUpdate(text)

      const utterance = new SpeechSynthesisUtterance(text)
      // Retain utterance on window to prevent Chrome garbage-collection lockup
      if (typeof window !== 'undefined') {
        ;(window as any).__medicare_active_utterance = utterance
      }
      activeUtteranceRef.current = utterance

      const voice = getDoctorVoice()
      // The device has voices loaded but none for this language: use the audio backup so the patient still hears the doctor.
      const noDeviceVoice = !voice && language !== 'en' && synthRef.current.getVoices().length > 0
      const bcp47Map: Record<ConsultationLanguage, string> = {
        kn: 'kn-IN',
        hi: 'hi-IN',
        en: 'en-IN',
      }

      if (voice) {
        utterance.voice = voice
        utterance.lang = voice.lang
      } else {
        utterance.lang = bcp47Map[language] || 'en-IN'
      }

      utterance.pitch = doctorId === 'dr_ananya' ? 1.08 : 0.94
      utterance.rate = 0.96
      utterance.volume = isMuted ? 0 : 1

      // Viseme frequency modulation
      // Script-aware mouth frames (works for Kannada, Hindi and English alike).
      lipSyncRef.current?.stop()
      const lipSync = startLipSync(text, utterance.rate)
      lipSyncRef.current = lipSync
      utterance.onboundary = (e) => lipSync.boundary(e.charIndex)
      animIntervalRef.current = setInterval(() => {
        setAudioLevel(Math.max(0.15, Math.min(1, mouthChannel.open)))
      }, 50)

      const handleEnd = () => {
        lipSync.stop()
        setIsSpeaking(false)
        setAudioLevel(0)
        if (animIntervalRef.current) {
          clearInterval(animIntervalRef.current)
          animIntervalRef.current = null
        }
        if (watchdogTimerRef.current) {
          clearTimeout(watchdogTimerRef.current)
          watchdogTimerRef.current = null
        }
        if (typeof window !== 'undefined') {
          delete (window as any).__medicare_active_utterance
        }
        onStateChange('listening')
      }

      let started = false
      let backupUsed = false
      const startBackup = () => {
        if (backupUsed) return
        backupUsed = true
        synthRef.current?.cancel()
        if (watchdogTimerRef.current) clearTimeout(watchdogTimerRef.current)
        watchdogTimerRef.current = setTimeout(handleEnd, Math.max(10000, (text.length / 8) * 1000 + 12000)) // never stick
        backupRef.current = playBackupVoice(text, language, () => (isMutedRef.current ? 0 : 1), () => { backupRef.current = null; handleEnd() })
      }

      utterance.onstart = () => { started = true }
      utterance.onend = handleEnd
      utterance.onerror = (e) => {
        const err = (e as SpeechSynthesisErrorEvent).error
        if (err === 'canceled' || err === 'interrupted') return handleEnd()
        startBackup() // any real failure of the device voice: the audio backup speaks instead
      }

      // Watchdog: Chrome sometimes never fires onend (or stalls on long text). Poll until playback really stops,
      // nudge a stalled engine, and force-release the speaking state after a hard cap so it can never stick.
      const startedAt = Date.now()
      const hardCapMs = Math.max(8000, (text.length / 8) * 1000 + 6000)
      const tick = () => {
        const synth = synthRef.current
        const elapsed = Date.now() - startedAt
        if (!synth || activeUtteranceRef.current !== utterance) return
        if (backupUsed) return
        if (!started && elapsed > 2500) { startBackup(); return } // the device voice never began: it is silent
        if (elapsed > hardCapMs) {
          synth.cancel()
          handleEnd()
          return
        }
        if (!synth.speaking && !synth.pending && elapsed > 1500) {
          handleEnd()
          return
        }
        if (synth.speaking && synth.paused) synth.resume()
        watchdogTimerRef.current = setTimeout(tick, 1000)
      }
      watchdogTimerRef.current = setTimeout(tick, 1500)

      if (noDeviceVoice) startBackup()
      else synthRef.current.speak(utterance)
    },
    [doctorId, language, isMuted, getDoctorVoice, onStateChange, onSubtitleUpdate]
  )

  // Barge-In & Instant Patient Interruption
  const interrupt = useCallback(() => {
    lipSyncRef.current?.stop()
    backupRef.current?.stop()
    backupRef.current = null
    if (synthRef.current) {
      synthRef.current.cancel()
    }
    if (animIntervalRef.current) {
      clearInterval(animIntervalRef.current)
      animIntervalRef.current = null
    }
    if (watchdogTimerRef.current) {
      clearTimeout(watchdogTimerRef.current)
      watchdogTimerRef.current = null
    }
    setIsSpeaking(false)
    setAudioLevel(0)
    onStateChange('interrupted')

    setTimeout(() => {
      onStateChange('listening')
    }, 400)
  }, [onStateChange])

  /** Silence the device voice without changing the doctor's state (used when server audio takes over). */
  const cancelLocalSpeech = useCallback(() => {
    if (!activeUtteranceRef.current && !synthRef.current?.speaking && !backupRef.current) return
    lipSyncRef.current?.stop()
    backupRef.current?.stop()
    backupRef.current = null
    synthRef.current?.cancel()
    activeUtteranceRef.current = null
    if (animIntervalRef.current) clearInterval(animIntervalRef.current)
    animIntervalRef.current = null
    if (watchdogTimerRef.current) clearTimeout(watchdogTimerRef.current)
    watchdogTimerRef.current = null
    setIsSpeaking(false)
    setAudioLevel(0)
  }, [])

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => !prev)
  }, [])

  return {
    isSpeaking,
    audioLevel,
    isMuted,
    subtitles,
    speak,
    cancelLocalSpeech,
    interrupt,
    toggleMute,
    setSubtitles,
  }
}
