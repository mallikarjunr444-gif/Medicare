'use client'

import { useEffect, useRef } from 'react'
import type { FaceLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision'
import { SessionAggregator, type VisionSummary } from './metrics'

const MODEL_BASE = process.env.NEXT_PUBLIC_MEDIAPIPE_MODEL_BASE
const FACE_MODEL = MODEL_BASE ? `${MODEL_BASE}/face_landmarker.task` : 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
const STEP_MS = 200 // 5 analysed frames a second is enough for blink, gaze and head measures
const REPORT_MS = 30_000

/**
 * Measures the patient's facial behaviour (blinks, gaze toward the screen, head movement, expression activation)
 * on this device while the consultation runs, and hands a small numbers-only summary to `onSummary` every 30 s.
 * No picture leaves this hook. The numbers are supporting information for the doctor, never a diagnosis.
 */
export function useConsultationObservations(videoRef: React.RefObject<HTMLVideoElement | null>, enabled: boolean, onSummary: (s: VisionSummary) => void): void {
  const cb = useRef(onSummary)
  useEffect(() => { cb.current = onSummary }, [onSummary])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null
    let reporter: ReturnType<typeof setInterval> | null = null
    let landmarker: FaceLandmarker | null = null
    const agg = new SessionAggregator()
    const sample = document.createElement('canvas'); sample.width = 16; sample.height = 12
    const sctx = sample.getContext('2d', { willReadFrequently: true })

    ;(async () => {
      try {
        const vision = await import('@mediapipe/tasks-vision')
        const fileset = await vision.FilesetResolver.forVisionTasks('/mediapipe/wasm')
        const make = async <T,>(f: (d: 'GPU' | 'CPU') => Promise<T>) => { try { return await f('GPU') } catch { return await f('CPU') } }
        const lm = await make((delegate) => vision.FaceLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: FACE_MODEL, delegate }, runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true }))
        if (cancelled) { lm.close(); return }
        landmarker = lm
      } catch { return } // optional feature: the consultation never depends on it
      let lastTs = 0, lastLuma = 0
      timer = setInterval(() => {
        const v = videoRef.current
        if (!v || !landmarker || v.readyState < 2 || v.videoWidth === 0 || document.hidden) return
        const ts = Math.max(performance.now(), lastTs + 1); lastTs = ts
        try {
          let luma: number | undefined
          if (sctx && ts - lastLuma > 1000) {
            lastLuma = ts; sctx.drawImage(v, 0, 0, 16, 12)
            const px = sctx.getImageData(0, 0, 16, 12).data; let sum = 0
            for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
            luma = sum / (px.length / 4)
          }
          const res = landmarker.detectForVideo(v, ts)
          let blend: Record<string, number> | undefined
          const cats = res.faceBlendshapes?.[0]?.categories
          if (cats) { blend = {}; for (const c of cats) blend[c.categoryName] = c.score }
          agg.update({ t: ts, faces: res.faceLandmarks?.length ?? 0, landmarks: res.faceLandmarks?.[0] as NormalizedLandmark[] | undefined, blendshapes: blend, matrix: res.facialTransformationMatrixes?.[0]?.data, poseRan: false, luma })
        } catch { /* one bad frame must not end the session */ }
      }, STEP_MS)
      reporter = setInterval(() => { if (agg.frames > 50) cb.current(agg.summary()) }, REPORT_MS)
    })()

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
      if (reporter) clearInterval(reporter)
      try { landmarker?.close() } catch { /* already closed */ }
    }
  }, [enabled, videoRef])
}
