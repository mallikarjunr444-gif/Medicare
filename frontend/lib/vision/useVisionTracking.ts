'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FaceLandmarker, PoseLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision'
import { SessionAggregator, describeSummary, type LiveReadout, type VisionSummary } from './metrics'

// The WASM runtime is served from our own origin (copied by scripts/copy-mediapipe.mjs). Model files come from Google's
// public MediaPipe bucket unless NEXT_PUBLIC_MEDIAPIPE_MODEL_BASE points at a self-hosted folder containing the same file names.
const MODEL_BASE = process.env.NEXT_PUBLIC_MEDIAPIPE_MODEL_BASE
const FACE_MODEL = MODEL_BASE ? `${MODEL_BASE}/face_landmarker.task` : 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
const POSE_MODEL = MODEL_BASE ? `${MODEL_BASE}/pose_landmarker_lite.task` : 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'
const FRAME_MS = 66 // ~15 analysed frames per second keeps phones cool

export type VisionStatus = 'idle' | 'requesting_camera' | 'loading_models' | 'running' | 'paused' | 'error'
export type VisionErrorKind = 'denied' | 'no_camera' | 'in_use' | 'unsupported' | 'models' | 'unknown'
export interface VisionOptions { overlay: boolean; posture: boolean }

const ERROR_TEXT: Record<VisionErrorKind, string> = {
  denied: 'Camera access was blocked. You can allow it in your browser settings, or continue without the camera.',
  no_camera: 'No camera was found on this device. You can continue without the camera.',
  in_use: 'The camera is being used by another app. Close that app and try again, or continue without the camera.',
  unsupported: 'This browser cannot access the camera here (a secure https page is required). You can continue without the camera.',
  models: 'The tracking model could not be loaded. Check your connection and try again, or continue without the camera.',
  unknown: 'The camera could not be started. You can continue without the camera.',
}

export function useVisionTracking(opts: VisionOptions) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const optsRef = useRef(opts)
  const streamRef = useRef<MediaStream | null>(null)
  const faceRef = useRef<FaceLandmarker | null>(null)
  const poseRef = useRef<PoseLandmarker | null>(null)
  const aggRef = useRef(new SessionAggregator())
  const loopRef = useRef<number | null>(null)
  const runningRef = useRef(false) // analysis on/off (pause + hidden tab turn it off)
  const generation = useRef(0) // invalidates async work from a previous start/stop
  const [status, setStatus] = useState<VisionStatus>('idle')
  const [error, setError] = useState<{ kind: VisionErrorKind; message: string } | null>(null)
  const [live, setLive] = useState<LiveReadout>(() => new SessionAggregator().live)
  const [summary, setSummary] = useState<{ data: VisionSummary; lines: string[] } | null>(null)

  useEffect(() => { optsRef.current = opts }, [opts])

  const release = useCallback(() => {
    generation.current++
    runningRef.current = false
    if (loopRef.current !== null) { cancelAnimationFrame(loopRef.current); loopRef.current = null }
    streamRef.current?.getTracks().forEach((t) => t.stop()) // the camera light goes off here
    streamRef.current = null
    if (videoRef.current) { videoRef.current.srcObject = null }
    try { faceRef.current?.close() } catch { /* already closed */ }
    try { poseRef.current?.close() } catch { /* already closed */ }
    faceRef.current = null; poseRef.current = null
    const c = overlayRef.current; c?.getContext('2d')?.clearRect(0, 0, c.width, c.height)
  }, [])

  const fail = useCallback((kind: VisionErrorKind) => { release(); setError({ kind, message: ERROR_TEXT[kind] }); setStatus('error') }, [release])

  const start = useCallback(async () => {
    release()
    const gen = ++generation.current
    aggRef.current = new SessionAggregator(); setSummary(null); setError(null); setLive(aggRef.current.live)
    if (!navigator.mediaDevices?.getUserMedia) return fail('unsupported')
    setStatus('requesting_camera')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })
    } catch (e) {
      const name = (e as DOMException)?.name
      return fail(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'no_camera' : name === 'NotReadableError' || name === 'AbortError' ? 'in_use' : 'unknown')
    }
    if (gen !== generation.current) { stream.getTracks().forEach((t) => t.stop()); return }
    streamRef.current = stream
    stream.getVideoTracks()[0]?.addEventListener('ended', () => { if (gen === generation.current) fail('in_use') })
    const video = videoRef.current
    if (!video) return fail('unknown')
    video.srcObject = stream
    try { await video.play() } catch { return fail('unknown') }

    setStatus('loading_models')
    let vision: typeof import('@mediapipe/tasks-vision')
    try {
      vision = await import('@mediapipe/tasks-vision')
      const fileset = await vision.FilesetResolver.forVisionTasks('/mediapipe/wasm')
      const make = async <T,>(f: (delegate: 'GPU' | 'CPU') => Promise<T>) => { try { return await f('GPU') } catch { return await f('CPU') } }
      const face = await make((delegate) => vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate }, runningMode: 'VIDEO', numFaces: 2, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
      }))
      let pose: PoseLandmarker | null = null
      if (optsRef.current.posture) {
        try { pose = await make((delegate) => vision.PoseLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: POSE_MODEL, delegate }, runningMode: 'VIDEO', numPoses: 1 })) } catch { pose = null } // posture is optional
      }
      if (gen !== generation.current) { face.close(); pose?.close(); return }
      faceRef.current = face; poseRef.current = pose
    } catch { return fail('models') }

    runningRef.current = true
    setStatus('running')
    let lastAnalysed = 0, lastUi = 0, lastLuma = 0, frameNo = 0
    const sample = document.createElement('canvas'); sample.width = 16; sample.height = 12
    const sctx = sample.getContext('2d', { willReadFrequently: true })
    let drawing: import('@mediapipe/tasks-vision').DrawingUtils | null = null
    const C = buildConnectors(vision)
    const tick = (now: number) => {
      if (gen !== generation.current) return
      loopRef.current = requestAnimationFrame(tick)
      if (!runningRef.current || now - lastAnalysed < FRAME_MS || video.readyState < 2 || video.videoWidth === 0) return
      lastAnalysed = now
      const face = faceRef.current; if (!face) return
      let luma: number | undefined
      if (sctx && now - lastLuma > 1000) {
        lastLuma = now; sctx.drawImage(video, 0, 0, 16, 12)
        const px = sctx.getImageData(0, 0, 16, 12).data; let s = 0
        for (let i = 0; i < px.length; i += 4) s += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
        luma = s / (px.length / 4)
      }
      try {
        const res = face.detectForVideo(video, now)
        const lm = res.faceLandmarks?.[0] as NormalizedLandmark[] | undefined
        let blend: Record<string, number> | undefined
        const cats = res.faceBlendshapes?.[0]?.categories
        if (cats) { blend = {}; for (const c of cats) blend[c.categoryName] = c.score }
        let poseLm: NormalizedLandmark[] | undefined, poseRan = false
        const pose = poseRef.current
        if (pose && optsRef.current.posture && frameNo % 3 === 0) { poseRan = true; poseLm = pose.detectForVideo(video, now).landmarks?.[0] }
        frameNo++
        const readout = aggRef.current.update({ t: now, faces: res.faceLandmarks?.length ?? 0, landmarks: lm, blendshapes: blend, matrix: res.facialTransformationMatrixes?.[0]?.data, pose: poseLm, poseRan: pose && optsRef.current.posture ? poseRan : false, luma })
        // overlay
        const canvas = overlayRef.current
        if (canvas) {
          if (canvas.width !== video.videoWidth) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; drawing = null }
          const ctx = canvas.getContext('2d')
          if (ctx) {
            ctx.clearRect(0, 0, canvas.width, canvas.height)
            if (optsRef.current.overlay && lm) {
              drawing = drawing ?? new vision.DrawingUtils(ctx)
              const D = drawing
              D.drawConnectors(lm, C.oval, { color: 'rgba(255,255,255,0.45)', lineWidth: 1 })
              D.drawConnectors(lm, C.leftEye, { color: '#5eead4', lineWidth: 1.5 }); D.drawConnectors(lm, C.rightEye, { color: '#5eead4', lineWidth: 1.5 })
              D.drawConnectors(lm, C.leftBrow, { color: '#a7f3d0', lineWidth: 1.5 }); D.drawConnectors(lm, C.rightBrow, { color: '#a7f3d0', lineWidth: 1.5 })
              D.drawConnectors(lm, C.lips, { color: '#fda4af', lineWidth: 1.5 })
              D.drawConnectors(lm, C.leftIris, { color: '#fde68a', lineWidth: 1.5 }); D.drawConnectors(lm, C.rightIris, { color: '#fde68a', lineWidth: 1.5 })
            }
            if (optsRef.current.overlay && poseLm && poseLm[11] && poseLm[12] && (poseLm[11].visibility ?? 0) > 0.5 && (poseLm[12].visibility ?? 0) > 0.5) {
              ctx.strokeStyle = '#93c5fd'; ctx.lineWidth = 3; ctx.beginPath()
              ctx.moveTo(poseLm[11].x * canvas.width, poseLm[11].y * canvas.height); ctx.lineTo(poseLm[12].x * canvas.width, poseLm[12].y * canvas.height); ctx.stroke()
            }
          }
        }
        if (now - lastUi > 200) { lastUi = now; setLive({ ...readout }) }
      } catch { /* a single bad frame must not end the session */ }
    }
    loopRef.current = requestAnimationFrame(tick)
  }, [fail, release])

  const pause = useCallback(() => { runningRef.current = false; setStatus((s) => (s === 'running' ? 'paused' : s)) }, [])
  const resume = useCallback(() => { if (streamRef.current && faceRef.current) { runningRef.current = true; setStatus('running') } }, [])

  /** Stops the camera completely (the browser's camera light goes off) and returns what was measured. */
  const stop = useCallback(() => {
    const data = aggRef.current.summary()
    release()
    setSummary({ data, lines: describeSummary(data) })
    setStatus('idle')
    return data
  }, [release])
  const discard = useCallback(() => { release(); aggRef.current = new SessionAggregator(); setSummary(null); setLive(aggRef.current.live); setStatus('idle') }, [release])

  // Never analyse in a hidden tab; always release the camera when the component goes away.
  useEffect(() => {
    const onVis = () => { if (document.hidden) { if (runningRef.current) runningRef.current = false } else if (streamRef.current && faceRef.current && status === 'running') runningRef.current = true }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [status])
  useEffect(() => release, [release])

  // Callback refs, so components never read a ref object during render.
  const bindVideo = useCallback((el: HTMLVideoElement | null) => { videoRef.current = el }, [])
  const bindOverlay = useCallback((el: HTMLCanvasElement | null) => { overlayRef.current = el }, [])

  return { bindVideo, bindOverlay, status, error, live, summary, start, pause, resume, stop, discard }
}

function buildConnectors(m: typeof import('@mediapipe/tasks-vision')) {
  const F = m.FaceLandmarker
  return { oval: F.FACE_LANDMARKS_FACE_OVAL, leftEye: F.FACE_LANDMARKS_LEFT_EYE, rightEye: F.FACE_LANDMARKS_RIGHT_EYE, leftBrow: F.FACE_LANDMARKS_LEFT_EYEBROW, rightBrow: F.FACE_LANDMARKS_RIGHT_EYEBROW, lips: F.FACE_LANDMARKS_LIPS, leftIris: F.FACE_LANDMARKS_LEFT_IRIS, rightIris: F.FACE_LANDMARKS_RIGHT_IRIS }
}
