'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { toast } from 'react-hot-toast'
import { mouthChannel, startLipSync, type LipSyncHandle } from '@/lib/visemes'
import type { ConsultationLanguage, DoctorId, DoctorState } from '@/lib/doctorTypes'

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
  const voiceHintShownRef = useRef(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [audioLevel, setAudioLevel] = useState(0)
  const [isMuted, setIsMuted] = useState(false)
  const [subtitles, setSubtitles] = useState('')

  const synthRef = useRef<SpeechSynthesis | null>(null)
  const activeUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null)
  const animIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const watchdogTimerRef = useRef<NodeJS.Timeout | null>(null)

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
      if (!voice && language !== 'en' && !voiceHintShownRef.current && synthRef.current.getVoices().length > 0) {
        voiceHintShownRef.current = true
        toast(
          language === 'kn'
            ? 'This device has no Kannada voice, so you will see captions and lip movement but hear no sound. Install "Kannada" text-to-speech (Android: Settings → Text-to-speech output) or use Hindi/English.'
            : 'This device has no Hindi voice, so you will see captions and lip movement but hear no sound. Install a Hindi text-to-speech voice in your device settings.',
          { duration: 9000 },
        )
      }
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

      utterance.onend = handleEnd
      utterance.onerror = (e) => {
        const err = (e as SpeechSynthesisErrorEvent).error
        if ((err === 'language-unavailable' || err === 'synthesis-unavailable') && !voiceHintShownRef.current) {
          voiceHintShownRef.current = true
          toast(
            language === 'kn'
              ? 'No Kannada voice found on this device. Install "Kannada" in Settings → Text-to-speech output to hear the doctor.'
              : 'No voice found for this language on this device. Install it in Settings → Text-to-speech output to hear the doctor.',
            { duration: 9000 },
          )
        }
        handleEnd()
      }

      // Watchdog: Chrome sometimes never fires onend (or stalls on long text). Poll until playback really stops,
      // nudge a stalled engine, and force-release the speaking state after a hard cap so it can never stick.
      const startedAt = Date.now()
      const hardCapMs = Math.max(8000, (text.length / 8) * 1000 + 6000)
      const tick = () => {
        const synth = synthRef.current
        const elapsed = Date.now() - startedAt
        if (!synth || activeUtteranceRef.current !== utterance) return
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

      synthRef.current.speak(utterance)
    },
    [doctorId, language, isMuted, getDoctorVoice, onStateChange, onSubtitleUpdate]
  )

  // Barge-In & Instant Patient Interruption
  const interrupt = useCallback(() => {
    lipSyncRef.current?.stop()
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

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => !prev)
  }, [])

  return {
    isSpeaking,
    audioLevel,
    isMuted,
    subtitles,
    speak,
    interrupt,
    toggleMute,
    setSubtitles,
  }
}
