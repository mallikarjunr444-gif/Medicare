'use client'

import React, { useEffect, useRef, useState } from 'react'
import { useHumanCheck, preloadHumanCheck, type HumanCheck } from '@/lib/vision/useHumanCheck'
import {
  CameraOff,
  Mic,
  MicOff,
  User,
  Minimize2,
  Maximize2,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'

export type CameraStatus = 'starting' | 'live' | 'denied' | 'no_camera' | 'in_use' | 'lost' | 'unsupported'
export interface CameraReport { camera: CameraStatus; human: HumanCheck }

interface PatientWebcamPiPProps {
  /** The consultation is active, so the camera must be on. There is no off switch: the camera is required. */
  isCameraOn: boolean
  isMicOn: boolean
  onToggleMic: () => void
  /** Increase to ask the browser for the camera again (after the patient fixed a permission or closed another app). */
  retryToken?: number
  /** Camera state and the person-or-not check, reported whenever either changes. */
  onStatusChange?: (r: CameraReport) => void
  /** Called with a small JPEG data URL when the picture changes noticeably (the doctor watches for changes). */
  onFrame?: (jpegDataUrl: string) => void
  className?: string
}

export function PatientWebcamPiP({
  isCameraOn,
  isMicOn,
  onToggleMic,
  retryToken = 0,
  onStatusChange,
  onFrame,
  className = '',
}: PatientWebcamPiPProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('starting')
  const [isMinimized, setIsMinimized] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const onFrameRef = useRef(onFrame)
  useEffect(() => {
    onFrameRef.current = onFrame
  }, [onFrame])

  // The doctor watches for changes: a cheap 32x24 grayscale diff every 3 s decides whether a frame is worth sending.
  useEffect(() => {
    if (!isCameraOn || !onFrameRef.current) return
    const small = document.createElement('canvas')
    small.width = 32
    small.height = 24
    const big = document.createElement('canvas')
    big.width = 320
    big.height = 240
    const sctx = small.getContext('2d', { willReadFrequently: true })
    const bctx = big.getContext('2d')
    if (!sctx || !bctx) return
    let prev: Uint8ClampedArray | null = null
    let lastSent = 0
    const startedAt = Date.now()
    const timer = setInterval(() => {
      const v = videoRef.current
      if (!v || v.readyState < 2 || document.hidden) return
      sctx.drawImage(v, 0, 0, 32, 24)
      const px = sctx.getImageData(0, 0, 32, 24).data
      const gray = new Uint8ClampedArray(32 * 24)
      for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3
      let diff = 0
      if (prev) for (let i = 0; i < gray.length; i++) diff += Math.abs(gray[i] - prev[i])
      diff /= gray.length
      prev = gray
      const now = Date.now()
      const first = lastSent === 0 && now - startedAt > 6000
      const changed = diff > 10 && now - lastSent > 25000
      const heartbeat = lastSent > 0 && now - lastSent > 90000
      if (!(first || changed || heartbeat)) return
      bctx.drawImage(v, 0, 0, 320, 240)
      lastSent = now
      onFrameRef.current?.(big.toDataURL('image/jpeg', 0.6))
    }, 3000)
    return () => clearInterval(timer)
  }, [isCameraOn])

  useEffect(() => {
    let active = true
    const release = () => {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      if (videoRef.current) videoRef.current.srcObject = null
    }

    async function setupCamera() {
      if (!isCameraOn) { release(); return }
      setCameraStatus('starting')
      if (!navigator.mediaDevices?.getUserMedia) { setCameraStatus('unsupported'); return }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
          audio: false,
        })
        if (!active) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        const track = stream.getVideoTracks()[0]
        // Unplugged, permission revoked, or covered by the system: the camera is gone and the call must say so.
        track?.addEventListener('ended', () => { if (active) setCameraStatus('lost') })
        track?.addEventListener('mute', () => { if (active) setCameraStatus('lost') })
        track?.addEventListener('unmute', () => { if (active) setCameraStatus('live') })
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.play().catch(() => {})
        }
        setCameraStatus('live')
      } catch (err) {
        if (!active) return
        const name = (err as DOMException)?.name
        setCameraStatus(name === 'NotFoundError' || name === 'OverconstrainedError' ? 'no_camera' : name === 'NotReadableError' || name === 'AbortError' ? 'in_use' : 'denied')
      }
    }

    setupCamera()
    return () => { active = false; release() }
  }, [isCameraOn, retryToken])

  // Start downloading the detectors now, in parallel with the browser's camera permission prompt.
  useEffect(() => { preloadHumanCheck() }, [])

  // Is it a person? Runs only while the camera is live.
  const human = useHumanCheck(videoRef, isCameraOn && cameraStatus === 'live')
  const onStatusRef = useRef(onStatusChange)
  useEffect(() => { onStatusRef.current = onStatusChange }, [onStatusChange])
  useEffect(() => { onStatusRef.current?.({ camera: cameraStatus, human }) }, [cameraStatus, human])

  if (isMinimized) {
    return (
      <div
        onClick={() => setIsMinimized(false)}
        className="cursor-pointer inline-flex h-10 items-center gap-2 rounded-full bg-white/95 px-3.5 text-clinic-ink shadow-[0_1px_3px_rgba(15,47,54,.25)] transition hover:bg-white group"
        title="Show your camera"
      >
        <span className="h-2 w-2 rounded-full bg-clinic-teal" aria-hidden="true" />
        <span className="text-[13px] font-semibold">Your camera</span>
        <ChevronUp size={15} className="text-clinic-muted" aria-hidden="true" />
      </div>
    )
  }

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border-2 border-white bg-clinic-ink shadow-[0_4px_16px_rgba(15,47,54,.35)] transition-all group ${
        isExpanded ? 'w-72 sm:w-80 aspect-[4/3]' : 'w-44 sm:w-52 aspect-[4/3]'
      } ${className}`}
    >
      {/* Realtime Video Stream */}
      {isCameraOn && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover transform -scale-x-100"
        />
      )}

      {/* Camera Off / Privacy Fallback */}
      {!isCameraOn && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-clinic-ink p-3 text-center">
          <div className="mb-1.5 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white">
            <User size={20} />
          </div>
          <span className="text-[13px] font-semibold text-white/85">Camera is off</span>
        </div>
      )}

      {/* Camera problem (the call shows full instructions) */}
      {isCameraOn && cameraStatus !== 'live' && cameraStatus !== 'starting' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-clinic-ink p-2 text-center text-[13px] font-semibold text-white">
          <CameraOff size={20} className="mb-1" aria-hidden="true" />
          <span>Camera is off</span>
        </div>
      )}

      {/* Label Badge Overlay */}
      <div className="absolute bottom-2 left-2 z-10 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[12px] font-semibold text-white">
        <span className={`h-1.5 w-1.5 rounded-full ${cameraStatus === 'live' && human.state === 'human' ? 'bg-teal-300' : cameraStatus === 'live' ? 'bg-amber-300' : 'bg-slate-400'}`} aria-hidden="true" />
        <span>{cameraStatus === 'live' && human.state === 'animal' ? `Not a person${human.animal ? ` (${human.animal})` : ''}` : 'You'}</span>
      </div>

      {/* Quick Camera, Mic, Minimize & Expand Controls */}
      <div className="absolute top-2 right-2 z-10 flex items-center gap-1 opacity-90 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onToggleMic}
          className={`h-8 w-8 flex items-center justify-center rounded-lg text-white transition-colors ${
            isMicOn ? 'bg-black/60 hover:bg-black/80' : 'bg-clinic-brick hover:bg-clinic-brick-deep'
          }`}
          title={isMicOn ? 'Turn microphone off' : 'Turn microphone on'} aria-label={isMicOn ? 'Turn microphone off' : 'Turn microphone on'}
        >
          {isMicOn ? <Mic size={15} /> : <MicOff size={15} />}
        </button>

        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="h-8 w-8 flex items-center justify-center rounded-lg text-white bg-black/60 hover:bg-black/80 transition-colors"
          title={isExpanded ? 'Shrink preview' : 'Enlarge preview'} aria-label={isExpanded ? 'Shrink preview' : 'Enlarge preview'}
        >
          {isExpanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>

        <button
          onClick={() => setIsMinimized(true)}
          className="h-8 w-8 flex items-center justify-center rounded-lg text-white bg-black/60 hover:bg-black/80 transition-colors"
          title="Hide preview" aria-label="Hide preview"
        >
          <ChevronDown size={15} />
        </button>
      </div>
    </div>
  )
}
