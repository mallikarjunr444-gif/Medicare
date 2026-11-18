'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConsultationLanguage } from '@/lib/doctorTypes'

type SpeechRecognitionResult = {
  resultIndex: number
  results: ArrayLike<{
    isFinal: boolean
    0: { transcript: string }
  }>
}

type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onstart: (() => void) | null
  onresult: ((event: SpeechRecognitionResult) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

interface BrowserWindow extends Window {
  SpeechRecognition?: SpeechRecognitionConstructor
  webkitSpeechRecognition?: SpeechRecognitionConstructor
}

const LANGUAGE_TAGS: Record<ConsultationLanguage, string> = {
  kn: 'kn-IN',
  en: 'en-IN',
  hi: 'hi-IN',
}

/** Browser speech input for hands-free, turn-based consultation. */
export function useConsultationSpeechRecognition(
  language: ConsultationLanguage,
  onUtterance: (text: string) => void
) {
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const onUtteranceRef = useRef(onUtterance)
  const enabledRef = useRef(false)
  const pausedRef = useRef(false)
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const finalizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const finalPartsRef = useRef<string[]>([])
  const lastFinalPartRef = useRef('')
  const restartAttemptsRef = useRef(0)
  const lastErrorRef = useRef<string | null>(null)

  const [isSupported, setIsSupported] = useState(true)
  const [isEnabled, setIsEnabled] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    onUtteranceRef.current = onUtterance
  }, [onUtterance])

  const startRecognition = useCallback(() => {
    const recognition = recognitionRef.current
    if (!recognition || !enabledRef.current || pausedRef.current) return
    try {
      recognition.start()
    } catch (e) {
      // InvalidStateError while a stop is still settling ("already started" is harmless). Retry shortly,
      // otherwise the mic would stay dead until the user taps it.
      if (!/already started/i.test(String((e as Error)?.message))) {
        if (restartTimerRef.current) clearTimeout(restartTimerRef.current)
        restartTimerRef.current = setTimeout(startRecognition, 500)
      }
    }
  }, [])

  const start = useCallback((selectedLanguage?: ConsultationLanguage) => {
    enabledRef.current = true
    pausedRef.current = false
    setIsEnabled(true)
    setError(null)
    if (recognitionRef.current) {
      recognitionRef.current.lang = LANGUAGE_TAGS[selectedLanguage || language] || 'en-IN'
    }
    startRecognition()
  }, [language, startRecognition])

  const pause = useCallback(() => {
    pausedRef.current = true
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current)
    try {
      recognitionRef.current?.stop()
    } catch {
      // The recognition session may already be stopped.
    }
    setIsListening(false)
  }, [])

  const resume = useCallback(() => {
    if (!enabledRef.current) return
    pausedRef.current = false
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current)
    restartTimerRef.current = setTimeout(startRecognition, 180)
  }, [startRecognition])

  const stop = useCallback(() => {
    enabledRef.current = false
    pausedRef.current = true
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current)
    if (finalizeTimerRef.current) clearTimeout(finalizeTimerRef.current)
    finalPartsRef.current = []
    lastFinalPartRef.current = ''
    setTranscript('')
    setIsEnabled(false)
    setIsListening(false)
    try {
      recognitionRef.current?.stop()
    } catch {
      // The recognition session may already be stopped.
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    finalPartsRef.current = []
    lastFinalPartRef.current = ''
    setTranscript('')

    const browserWindow = window as BrowserWindow
    const Recognition = browserWindow.SpeechRecognition || browserWindow.webkitSpeechRecognition
    if (!Recognition) {
      setIsSupported(false)
      return
    }

    let active = true
    const recognition = new Recognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = LANGUAGE_TAGS[language] || 'en-IN'

    recognition.onstart = () => {
      if (active) {
        restartAttemptsRef.current = 0
        lastErrorRef.current = null
        setIsListening(true)
        setError(null)
      }
    }

    recognition.onresult = (event) => {
      if (!active) return
      restartAttemptsRef.current = 0
      let interim = ''
      const finalParts: string[] = []

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const text = event.results[index][0]?.transcript?.trim()
        if (!text) continue
        if (event.results[index].isFinal) finalParts.push(text)
        else interim = `${interim} ${text}`.trim()
      }

      for (const text of finalParts) {
        if (text === lastFinalPartRef.current) continue
        lastFinalPartRef.current = text
        finalPartsRef.current.push(text)
      }

      const pending = finalPartsRef.current.join(' ')
      setTranscript([pending, interim].filter(Boolean).join(' '))

      if (finalParts.length > 0) {
        if (finalizeTimerRef.current) clearTimeout(finalizeTimerRef.current)
        // Let short recognition fragments join into one natural sentence.
        finalizeTimerRef.current = setTimeout(() => {
          const utterance = finalPartsRef.current.join(' ').trim()
          finalPartsRef.current = []
          lastFinalPartRef.current = ''
          setTranscript('')
          if (utterance && active) onUtteranceRef.current(utterance)
        }, 850)
      }
    }

    recognition.onerror = (event) => {
      if (!active) return
      lastErrorRef.current = event.error
      // Chrome ends the session after silence (no-speech), network blips and aborts. These are recoverable:
      // onend restarts with backoff, so the mic keeps listening without the user doing anything.
      if (event.error === 'no-speech' || event.error === 'network' || event.error === 'aborted') return

      const message = event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'Allow microphone access to speak with the doctor. You can still type below.'
        : event.error === 'audio-capture'
          ? 'No microphone was found. Connect a microphone or type below.'
          : 'Voice input stopped. Tap the microphone to try again.'
      setError(message)
      enabledRef.current = false
      pausedRef.current = true
      setIsEnabled(false)
      setIsListening(false)
    }

    recognition.onend = () => {
      if (!active) return
      setIsListening(false)
      if (enabledRef.current && !pausedRef.current) {
        if (restartTimerRef.current) clearTimeout(restartTimerRef.current)
        // Backoff when Chrome keeps ending immediately (e.g. repeated no-speech / network), capped at 5 s.
        const delay = Math.min(220 * 2 ** restartAttemptsRef.current, 5000)
        restartAttemptsRef.current = Math.min(restartAttemptsRef.current + 1, 5)
        restartTimerRef.current = setTimeout(startRecognition, delay)
      }
    }

    recognitionRef.current = recognition
    setIsSupported(true)
    if (enabledRef.current && !pausedRef.current) startRecognition()

    return () => {
      active = false
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current)
      if (finalizeTimerRef.current) clearTimeout(finalizeTimerRef.current)
      finalPartsRef.current = []
      lastFinalPartRef.current = ''
      recognition.onstart = null
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      try {
        recognition.stop()
      } catch {
        // Language changes and unmounts can clean up an already stopped session.
      }
      if (recognitionRef.current === recognition) recognitionRef.current = null
    }
  }, [language, startRecognition])

  // Microphone recovery: when a mic is plugged in / permission returns / the network comes back after the
  // recogniser gave up, restart it instead of leaving voice input dead.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const recover = () => {
      const recoverable = lastErrorRef.current === 'audio-capture' || lastErrorRef.current === 'network'
      if (!recoverable || !recognitionRef.current) return
      lastErrorRef.current = null
      restartAttemptsRef.current = 0
      enabledRef.current = true
      pausedRef.current = false
      setError(null)
      setIsEnabled(true)
      startRecognition()
    }
    const devices = navigator.mediaDevices
    devices?.addEventListener?.('devicechange', recover)
    window.addEventListener('online', recover)
    return () => {
      devices?.removeEventListener?.('devicechange', recover)
      window.removeEventListener('online', recover)
    }
  }, [startRecognition])

  return {
    isSupported,
    isEnabled,
    isListening,
    transcript,
    error,
    start,
    pause,
    resume,
    stop,
  }
}
