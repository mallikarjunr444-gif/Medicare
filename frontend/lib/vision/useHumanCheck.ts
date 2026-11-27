'use client'

import { useEffect, useRef, useState } from 'react'
import { HumanGate, classifyFrame, type HumanState } from './humanCheck'

// Same hosting rule as useVisionTracking: Google's public bucket unless NEXT_PUBLIC_MEDIAPIPE_MODEL_BASE points at a folder with these file names.
const MODEL_BASE = process.env.NEXT_PUBLIC_MEDIAPIPE_MODEL_BASE
const OBJECT_MODEL = MODEL_BASE ? `${MODEL_BASE}/efficientdet_lite0.tflite` : 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite'
const FACE_MODEL = MODEL_BASE ? `${MODEL_BASE}/blaze_face_short_range.tflite` : 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'
const CHECK_MS = 250 // 4 checks a second is plenty for "is someone there"

export interface HumanCheck {
  state: HumanState
  animal?: string
  /** False when the detector models could not be loaded. The caller decides what that means (the call does not lock a patient out of care). */
  available: boolean
}

/** Runs on the video element's frames on this device only; nothing is uploaded or stored. */
export function useHumanCheck(videoRef: React.RefObject<HTMLVideoElement | null>, enabled: boolean): HumanCheck {
  const [result, setResult] = useState<HumanCheck>({ state: 'checking', available: true })
  const lastRef = useRef<HumanCheck>(result)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null
    let objects: import('@mediapipe/tasks-vision').ObjectDetector | null = null
    let faces: import('@mediapipe/tasks-vision').FaceDetector | null = null
    const gate = new HumanGate()
    const publish = (next: HumanCheck) => {
      const p = lastRef.current
      if (p.state === next.state && p.animal === next.animal && p.available === next.available) return
      lastRef.current = next; setResult(next)
    }
    publish({ state: 'checking', available: true })

    ;(async () => {
      try {
        const vision = await import('@mediapipe/tasks-vision')
        const fileset = await vision.FilesetResolver.forVisionTasks('/mediapipe/wasm')
        const make = async <T,>(f: (d: 'GPU' | 'CPU') => Promise<T>) => { try { return await f('GPU') } catch { return await f('CPU') } }
        const [o, f] = await Promise.all([
          make((delegate) => vision.ObjectDetector.createFromOptions(fileset, { baseOptions: { modelAssetPath: OBJECT_MODEL, delegate }, runningMode: 'VIDEO', scoreThreshold: 0.35, maxResults: 6 })),
          make((delegate) => vision.FaceDetector.createFromOptions(fileset, { baseOptions: { modelAssetPath: FACE_MODEL, delegate }, runningMode: 'VIDEO', minDetectionConfidence: 0.5 })),
        ])
        if (cancelled) { o.close(); f.close(); return }
        objects = o; faces = f
      } catch {
        if (!cancelled) publish({ state: 'checking', available: false })
        return
      }
      let lastTs = 0
      timer = setInterval(() => {
        const v = videoRef.current
        if (!v || !objects || !faces || v.readyState < 2 || v.videoWidth === 0 || document.hidden) return
        const ts = Math.max(performance.now(), lastTs + 1); lastTs = ts // MediaPipe needs strictly increasing timestamps
        try {
          const objs = objects.detectForVideo(v, ts).detections.map((d) => ({ label: d.categories[0]?.categoryName ?? '', score: d.categories[0]?.score ?? 0 }))
          const fcs = faces.detectForVideo(v, ts).detections.map((d) => d.categories[0]?.score ?? 0)
          const frame = classifyFrame({ faces: fcs, objects: objs })
          const state = gate.push(frame.verdict, frame.animal, ts)
          publish({ state, animal: gate.animal, available: true })
        } catch { /* one bad frame must not end the check */ }
      }, CHECK_MS)
    })()

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
      try { objects?.close() } catch { /* already closed */ }
      try { faces?.close() } catch { /* already closed */ }
    }
  }, [enabled, videoRef])

  // When the camera is off there is nothing to check; report "checking" so a stale "human" never survives a restart.
  return enabled ? result : { state: 'checking', available: true }
}
