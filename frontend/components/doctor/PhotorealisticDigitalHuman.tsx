'use client'

import { mouthChannel } from '@/lib/visemes'
import React, { useRef, useEffect, useMemo, useState } from 'react'
import type { DoctorId, DoctorState } from '@/lib/doctorTypes'
import { DOCTORS } from '@/lib/doctorTypes'
import { DOCTOR_FACE_DATA, DOCTOR_HAIR } from '@/lib/doctorFaceData'
import { PortraitWarp } from '@/lib/portraitWarp'
import { readVoiceDrive } from '@/lib/audioEnergy'
import { EXPRESSION_POSE, type DoctorExpression } from '@/lib/doctorExpression'
import {
  RotateCcw,
  WifiOff,
} from 'lucide-react'

interface PhotorealisticDigitalHumanProps {
  doctorId: DoctorId
  doctorState: DoctorState
  isMuted?: boolean
  hasSeparateTtsAudio?: boolean
  subtitles?: string
  /** 0..1 level for speech that has no audio element (browser speech synthesis fallback). */
  fallbackSpeechLevel?: number
  /** Facial expression: neutral, warm (gentle smile) or concerned. */
  expression?: DoctorExpression
  /** Adds eye drift and swaying hair on top of the blinking and head motion (used on the landing page). */
  lifelike?: boolean
  speakingVideoSrc?: string | null
  speakingVideoStartAt?: number
  getSpeakingAudioTime?: () => number | null
  onSpeakingVideoEnded?: () => void
  onSpeakingVideoError?: () => void
  onStateChange?: (state: DoctorState) => void
  onReconnect?: () => void
  className?: string
}

const FACE_ANCHORS = {
  dr_ananya: { eyes: [{ x: 0.459, y: 0.193 }, { x: 0.539, y: 0.183 }], mouth: { x: 0.502, y: 0.294 }, eyeWidth: 0.025, mouthWidth: 0.032 },
  dr_arjun: { eyes: [{ x: 0.489, y: 0.198 }, { x: 0.548, y: 0.189 }], mouth: { x: 0.522, y: 0.296 }, eyeWidth: 0.022, mouthWidth: 0.028 },
} as const

export function PhotorealisticDigitalHuman({
  doctorId,
  doctorState,
  isMuted = false,
  hasSeparateTtsAudio = false,
  subtitles = '',
  fallbackSpeechLevel = 0,
  expression = 'neutral',
  lifelike = false,
  speakingVideoSrc = null,
  speakingVideoStartAt = 0,
  getSpeakingAudioTime,
  onSpeakingVideoEnded,
  onSpeakingVideoError,
  onStateChange,
  onReconnect,
  className = '',
}: PhotorealisticDigitalHumanProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const lightRef = useRef<HTMLDivElement>(null)
  // Wraps canvas + speaking video so breathing and head sway move both together.
  const stageRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const animFrameRef = useRef<number | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [imageLoaded, setImageLoaded] = useState(false)
  const [playbackBlocked, setPlaybackBlocked] = useState(false)
  const [videoReady, setVideoReady] = useState(false)

  // Physiological Simulation state refs (avoid React re-render lag)
  const simRef = useRef({
    startTime: 0,
    lastFrameTime: 0,
    lastTick: 0,
    openEnv: 0,
    nextBlinkAt: 2.4,
    blinkStartedAt: -1,
    breathing: 0,
    head: { pitch: 0, yaw: 0, roll: 0, targetPitch: 0, targetYaw: 0, targetRoll: 0 },
    brows: { lift: 0, furrow: 0 },
    mouth: { open: 0, wide: 1 },
    browLift: 0,
    smile: 0,
    exprBrow: 0,
    doubleBlink: false,
    gaze: { x: 0, y: 0, tx: 0, ty: 0, next: 1.4 },
  })
  const expressionRef = useRef<DoctorExpression>(expression)
  useEffect(() => {
    expressionRef.current = expression
  }, [expression])
  const fallbackLevelRef = useRef(fallbackSpeechLevel)
  useEffect(() => {
    fallbackLevelRef.current = fallbackSpeechLevel
  }, [fallbackSpeechLevel])

  const doctor = DOCTORS[doctorId] || DOCTORS.dr_arjun
  const photoSrc = doctorId === 'dr_ananya' ? '/doctor/dr_ananya.jpg' : '/doctor/dr_arjun.jpg'
  // Normalized landmark estimates for the two bundled portraits. This keeps
  // the fallback animation local and inexpensive; no cloud model or GPU needed.
  const face = FACE_ANCHORS[doctorId]
  const warp = useMemo(() => {
    const key = doctorId === 'dr_ananya' ? 'dr_ananya' : 'dr_arjun'
    return new PortraitWarp(DOCTOR_FACE_DATA[key], lifelike ? DOCTOR_HAIR[key] : undefined)
  }, [doctorId, lifelike])

  // Preload Doctor High-Res Photograph
  useEffect(() => {
    setImageLoaded(false)
    const img = new Image()
    img.src = photoSrc
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      imageRef.current = img
      setImageLoaded(true)
    }
  }, [photoSrc])

  // Synchronized Video playback for speaking animation
  useEffect(() => {
    const video = videoRef.current
    if (!video) {
      setPlaybackBlocked(false)
      setVideoReady(false)
      return
    }
    video.pause()
    setPlaybackBlocked(false)
    setVideoReady(false)
    if (doctorState !== 'speaking' || !speakingVideoSrc) return

    let cancelled = false
    const startFromMatchingAudioTime = () => {
      if (cancelled) return
      const audioTime = getSpeakingAudioTime?.()
      if (getSpeakingAudioTime && audioTime === null) return
      const startAt = audioTime ?? speakingVideoStartAt
      const latestSafeTime = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.04) : startAt
      video.currentTime = Math.min(Math.max(0, startAt), latestSafeTime)
      video.play().catch(() => setPlaybackBlocked(true))
    }

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      startFromMatchingAudioTime()
    } else {
      video.addEventListener('loadedmetadata', startFromMatchingAudioTime, { once: true })
    }

    return () => {
      cancelled = true
      video.removeEventListener('loadedmetadata', startFromMatchingAudioTime)
    }
  }, [doctorState, speakingVideoSrc, speakingVideoStartAt, getSpeakingAudioTime])

  // Subtle idle/listening movement while the real response video is prepared.
  useEffect(() => {
    if (!imageLoaded) return

    const canvas = canvasRef.current
    if (!canvas) return
    // alpha: true so, while the lip-sync video plays, the canvas can be transparent except for the eyelids.
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
    }
    if (!ctx) return
    // Keep one clock across effect re-runs (state/video changes) so blink timing is not reset.
    if (!simRef.current.startTime) simRef.current.startTime = performance.now()

    const render = (now: number) => {
      animFrameRef.current = requestAnimationFrame(render)

      const t = (now - simRef.current.startTime) / 1000
      const sim = simRef.current
      // Head/breathing motion is applied every display frame (a 24 fps transform looks like shaking).
      // Only the heavier canvas repaint is capped to ~24 fps for laptops without a discrete GPU.
      const dt = Math.min(0.1, Math.max(0.001, sim.lastTick ? (now - sim.lastTick) / 1000 : 1 / 60))
      sim.lastTick = now
      const repaint = now - sim.lastFrameTime >= 1000 / 24
      if (repaint) sim.lastFrameTime = now

      if (t >= sim.nextBlinkAt) {
        sim.blinkStartedAt = t
        // Mostly single blinks every 2.5-6 s, sometimes a quick double blink, as people do.
        sim.doubleBlink = Math.random() < 0.18
        sim.nextBlinkAt = t + (sim.doubleBlink ? 0.55 : 2.5 + Math.random() * 3.5)
      }
      const blinkCurve = (age: number) =>
        age < 0 ? 0 : age < 0.08 ? age / 0.08 : age < 0.26 ? 1 - (age - 0.08) / 0.18 : 0
      let blink = blinkCurve(t - sim.blinkStartedAt)
      if (sim.doubleBlink) blink = Math.max(blink, blinkCurve(t - sim.blinkStartedAt - 0.3))

      // ─────────────────────────────────────────────────────────────
      // 1. Subtle idle breathing
      // ─────────────────────────────────────────────────────────────
      const breathPhase = Math.sin(t * 1.46)
      // Base scale > 1 so head sway / breathing never exposes the edge of the frame.
      sim.breathing = 1.05 + breathPhase * 0.006

      // ─────────────────────────────────────────────────────────────
      // Eye drift: mostly small glances around the camera, now and then a look to the side, always
      // coming back. Moves are quick (a saccade), then hold still.
      if (lifelike) {
        const g = sim.gaze
        if (t >= g.next) {
          const aside = Math.abs(g.tx) < 0.5 && Math.random() < 0.3
          g.tx = aside ? (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.4) : (Math.random() - 0.5) * 0.5
          g.ty = aside ? (Math.random() - 0.65) * 0.9 : (Math.random() - 0.5) * 0.3
          g.next = t + (aside ? 0.8 + Math.random() * 0.8 : 1.6 + Math.random() * 2.4)
        }
        const follow = 1 - Math.exp(-dt * 16)
        g.x += (g.tx - g.x) * follow
        g.y += (g.ty - g.y) * follow
      }

      // 2. Conversational Head Kinematics & Posture by State
      // ─────────────────────────────────────────────────────────────
      // Slow, incommensurate drifts so the motion never visibly loops.
      const drift = (f1: number, f2: number) => Math.sin(t * f1) * 0.6 + Math.sin(t * f2 + 1.7) * 0.4
      // Syllable-rate mouth openings must not drive the head directly (that reads as shaking):
      // use a slow envelope (~0.4 s) so the head only follows overall speaking energy.
      sim.openEnv += (sim.mouth.open - sim.openEnv) * (1 - Math.exp(-dt * 2.5))
      const open = sim.openEnv
      switch (doctorState) {
        case 'listening':
          // Attentive: head tilted slightly to one side, slow nods of understanding.
          sim.head.targetPitch = 2.2 + Math.max(0, Math.sin(t * 0.9)) ** 6 * 3.2
          sim.head.targetYaw = drift(0.31, 0.53) * 1.6
          sim.head.targetRoll = 3.2 + drift(0.4, 0.7) * 0.9
          sim.brows.lift = 0.1
          sim.brows.furrow = 0.0
          break

        case 'thinking':
          // Considering: eyes up, head tilted to the other side.
          sim.head.targetPitch = -2.4 + Math.sin(t * 0.8) * 0.6
          sim.head.targetYaw = 3.6 + Math.sin(t * 0.7) * 0.8
          sim.head.targetRoll = -3.6 + Math.sin(t * 0.5) * 0.7
          sim.brows.lift = 0.0
          sim.brows.furrow = 0.18
          break

        case 'speaking':
          // Beats on emphasis (driven by mouth energy), plus a changing tilt like a person explaining.
          sim.head.targetPitch = open * 1.8 - 0.3 + Math.sin(t * 1.3) * 0.4
          sim.head.targetYaw = drift(0.45, 0.8) * 1.5
          sim.head.targetRoll = Math.sin(t * 0.38) * 2.0 + (open - 0.3) * 0.5
          sim.brows.lift = open * 0.12
          sim.brows.furrow = 0.0
          break

        case 'interrupted':
          sim.head.targetPitch = -1.2
          sim.head.targetYaw = 0
          sim.head.targetRoll = 2.0
          sim.brows.lift = 0.22
          break

        case 'idle':
        default:
          sim.head.targetPitch = drift(0.35, 0.6) * 1.0
          sim.head.targetYaw = drift(0.27, 0.44) * 1.4
          sim.head.targetRoll = drift(0.22, 0.5) * 1.2
          sim.brows.lift = 0
          sim.brows.furrow = 0
          break
      }

      // Smooth lerp damping
      const lerp = 1 - Math.exp(-dt * 1.6) // frame-rate independent damping
      sim.head.pitch += (sim.head.targetPitch - sim.head.pitch) * lerp
      sim.head.yaw += (sim.head.targetYaw - sim.head.yaw) * lerp
      sim.head.roll += (sim.head.targetRoll - sim.head.roll) * lerp

      // Breathing + head motion are CSS on the wrapper, so the lip-sync video moves with them.
      const stage = stageRef.current
      if (stage) {
        stage.style.transform = `perspective(900px) translate3d(${(sim.head.yaw * 2.5).toFixed(2)}px, ${(sim.head.pitch * 2).toFixed(2)}px, 0) rotateY(${sim.head.yaw * 1.2}deg) rotateX(${-sim.head.pitch * 0.9}deg) rotate(${sim.head.roll}deg) scale(${sim.breathing})`
      }

      // A soft key light that slides across the face as the head turns and tilts, which sells the 3D depth.
      const light = lightRef.current
      if (light) {
        light.style.backgroundPosition = `${50 + sim.head.yaw * 5}% ${40 - sim.head.pitch * 4}%`
        light.style.opacity = String(0.55 + Math.abs(sim.head.roll) * 0.04)
      }

      if (!repaint) return

      // The lip-sync video plays over the canvas and never blinks (only the jaw is regenerated).
      // While it plays, the canvas goes transparent except for the eyelids, drawn on top.
      const overlayEyes = doctorState === 'speaking' && videoReady && !!speakingVideoSrc

      // ─────────────────────────────────────────────────────────────
      // Canvas drawing for the listening portrait
      // ─────────────────────────────────────────────────────────────
      const width = canvas.width
      const height = canvas.height
      const img = imageRef.current
      if (!img) return

      ctx.clearRect(0, 0, width, height)

      ctx.save()

      // Draw Base Doctor Photorealistic Portrait
      const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight)
      const drawWidth = img.naturalWidth * scale
      const drawHeight = img.naturalHeight * scale
      // Bias the crop upward so the doctor's hair remains in frame in a wide viewport.
      if (!overlayEyes) ctx.drawImage(img, (width - drawWidth) / 2, (height - drawHeight) * 0.25, drawWidth, drawHeight)

      // Animate the real photograph: eyelids, jaw/lips (driven by the voice that is playing), brows.
      const drawX = (width - drawWidth) / 2
      const drawY = (height - drawHeight) * 0.25
      const forceVoice = process.env.NODE_ENV !== 'production' && typeof window !== 'undefined' && (window as unknown as { __portraitForceVoice?: boolean }).__portraitForceVoice
      const voice = doctorState === 'speaking' || forceVoice ? readVoiceDrive() : null
      let openTarget = 0
      let wideTarget = 1
      if (voice) {
        openTarget = Math.min(1, Math.max(0, voice.level * 1.4 - 0.05))
        wideTarget = 0.97 + voice.bright * 0.1
      } else if (doctorState === 'speaking' && mouthChannel.active) {
        // Viseme frames from the spoken text (device voice, any language).
        openTarget = mouthChannel.open
        wideTarget = mouthChannel.wide
      } else if (doctorState === 'speaking' && fallbackLevelRef.current > 0) {
        openTarget = Math.min(1, fallbackLevelRef.current * 0.8)
        wideTarget = 1 + (openTarget - 0.4) * 0.1
      }
      const mouth = sim.mouth
      mouth.open += (openTarget - mouth.open) * (openTarget > mouth.open ? 0.6 : 0.3)
      mouth.wide += (wideTarget - mouth.wide) * 0.3
      if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') (window as unknown as { __portraitMouth?: number }).__portraitMouth = mouth.open
      sim.browLift += (Math.min(1, mouth.open * 1.4) * 0.6 - sim.browLift) * 0.1
      // Expression eases in over about a second so it never snaps. Smile is eased down while the mouth is wide open.
      const ex = EXPRESSION_POSE[expressionRef.current]
      sim.smile += (ex.smile * (1 - Math.min(1, mouth.open * 1.5)) - sim.smile) * 0.06
      sim.exprBrow += (ex.brow - sim.exprBrow) * 0.06

      const debug = typeof window !== 'undefined' && process.env.NODE_ENV !== 'production'
        ? (window as unknown as { __portraitPose?: Partial<{ blink: number; open: number; wide: number; brow: number }> }).__portraitPose
        : undefined
      ctx.save()
      ctx.translate(drawX, drawY)
      ctx.scale(drawWidth / img.naturalWidth, drawHeight / img.naturalHeight)
      if (lifelike && !overlayEyes) warp.drawHair(ctx, img, t)
      if (overlayEyes) {
        warp.drawEyesOnly(ctx, img, debug?.blink ?? blink)
      } else {
        warp.draw(ctx, img, {
          blink: debug?.blink ?? blink,
          open: debug?.open ?? mouth.open,
          wide: debug?.wide ?? mouth.wide,
          brow: debug?.brow ?? Math.min(1, sim.browLift + sim.exprBrow),
          smile: sim.smile,
          gazeX: lifelike ? sim.gaze.x : 0,
          gazeY: lifelike ? sim.gaze.y : 0,
        })
      }
      ctx.restore()

      ctx.restore()
    }

    animFrameRef.current = requestAnimationFrame(render)

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    }
  }, [imageLoaded, doctorId, doctorState, speakingVideoSrc, videoReady, warp, lifelike])

  return (
    <div className={`relative w-full h-full bg-slate-950 flex items-center justify-center overflow-hidden select-none ${className}`}>
      {/* Dynamic Cinematic Hospital Consultation Ambient Lighting */}
      <div className="absolute inset-0 bg-gradient-to-b from-slate-900/30 via-slate-950/10 to-slate-950/70 pointer-events-none z-10" />

      {/* When Doctor is speaking with neural generated video, show synchronized video stream */}
      <div ref={stageRef} className="absolute inset-0 will-change-transform">
      <canvas
        ref={canvasRef}
        width={1600}
        height={900}
        // Above the speaking video only while it supplies the eyelids; otherwise it is the base layer.
        style={{ zIndex: doctorState === 'speaking' && videoReady ? 5 : 0 }}
        className="absolute inset-0 h-full w-full object-cover object-[center_25%] filter contrast-[1.03] brightness-[1.01]"
      />

      <div
        ref={lightRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[6] mix-blend-soft-light"
        style={{ backgroundImage: 'radial-gradient(ellipse 45% 55% at center, rgba(255,236,214,.55), rgba(255,236,214,0) 70%)', backgroundSize: '160% 160%', backgroundRepeat: 'no-repeat' }}
      />

      {speakingVideoSrc && doctorState === 'speaking' && (
        <video
          key={speakingVideoSrc}
          ref={videoRef}
          src={speakingVideoSrc}
          playsInline
          muted={isMuted || hasSeparateTtsAudio}
          className={`absolute inset-0 h-full w-full object-cover object-[center_25%] filter contrast-[1.03] brightness-[1.01] transition-opacity duration-150 ${videoReady ? 'opacity-100' : 'opacity-0'}`}
          onPlaying={() => setVideoReady(true)}
          onWaiting={() => setVideoReady(false)}
          onEnded={() => {
            setVideoReady(false)
            if (onSpeakingVideoEnded) onSpeakingVideoEnded()
            else onStateChange?.('listening')
          }}
          onError={() => onSpeakingVideoError?.()}
        />
      )}
      </div>

      {playbackBlocked && speakingVideoSrc && doctorState === 'speaking' && (
        <button
          type="button"
          onClick={() => videoRef.current?.play().then(() => setPlaybackBlocked(false)).catch(() => setPlaybackBlocked(true))}
          className="absolute z-30 h-12 rounded-xl bg-white px-5 text-[15px] font-bold text-clinic-ink shadow-[0_8px_24px_rgba(15,47,54,.35)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-clinic-teal/40"
        >
          Tap to hear the reply
        </button>
      )}

      {/* Disconnected State Overlay */}
      {doctorState === 'disconnected' && (
        <div role="alert" className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-clinic-ink/90 p-6 text-center backdrop-blur-sm">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-white/10 text-white">
            <WifiOff size={26} aria-hidden="true" />
          </div>
          <h3 className="mb-1.5 text-[20px] font-bold text-white">Connection lost</h3>
          <p className="mb-6 max-w-sm text-[15px] leading-relaxed text-white/80">
            The link to {doctor.name} dropped. Your conversation is saved. Reconnect to carry on.
          </p>
          <button
            onClick={onReconnect}
            className="inline-flex h-12 items-center gap-2 rounded-xl bg-white px-5 text-[15px] font-bold text-clinic-ink transition hover:bg-clinic-mist focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/40"
          >
            <RotateCcw size={17} aria-hidden="true" />
            Reconnect
          </button>
        </div>
      )}

      {/* Live subtitles: large, high contrast, sized for Kannada and Devanagari glyphs */}
      {subtitles && (
        <div className="pointer-events-none absolute inset-x-4 bottom-5 z-20 flex justify-center sm:inset-x-8" aria-live="polite" aria-atomic="true">
          <p className="line-clamp-3 max-w-3xl rounded-2xl bg-clinic-ink/90 px-5 py-3 text-center text-[17px] font-semibold leading-[1.65] text-white shadow-[0_6px_20px_rgba(15,47,54,.35)] sm:text-[19px]">
            {subtitles}
          </p>
        </div>
      )}
    </div>
  )
}
