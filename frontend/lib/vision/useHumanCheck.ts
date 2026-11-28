'use client'

import { useEffect, useRef, useState } from 'react'
import { HumanGate, classifyFrame, type HumanState } from './humanCheck'

// Same hosting rule as useVisionTracking: Google's public bucket unless NEXT_PUBLIC_MEDIAPIPE_MODEL_BASE points at a folder with these file names.
const MODEL_BASE = process.env.NEXT_PUBLIC_MEDIAPIPE_MODEL_BASE
const OBJECT_MODEL = MODEL_BASE ? `${MODEL_BASE}/efficientdet_lite0.tflite` : 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite'
const FACE_MODEL = MODEL_BASE ? `${MODEL_BASE}/blaze_face_short_range.tflite` : 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'
const CHECK_FAST_MS = 120 // while still confirming the person: a quick first answer
const CHECK_STEADY_MS = 250 // afterwards 4 checks a second is plenty

type Vision = typeof import('@mediapipe/tasks-vision')
type Detectors = { vision: Vision; faces: Promise<import('@mediapipe/tasks-vision').FaceDetector>; objects: Promise<import('@mediapipe/tasks-vision').ObjectDetector> }

/**
 * Detectors are loaded ONCE per page and shared, and loading can start before the camera is on (call preloadHumanCheck()
 * when the consultation screen opens). The small face model (~0.2 MB) is separate from the larger object model (~4 MB):
 * the face model alone is enough to confirm a person, so the patient is never held up by the big download.
 */
let shared: Promise<Detectors> | null = null
function loadDetectors(): Promise<Detectors> {
  if (shared) return shared
  shared = (async () => {
    const vision = await import('@mediapipe/tasks-vision')
    const fileset = await vision.FilesetResolver.forVisionTasks('/mediapipe/wasm')
    const make = async <T,>(f: (d: 'GPU' | 'CPU') => Promise<T>) => { try { return await f('GPU') } catch { return await f('CPU') } }
    const faces = make((delegate) => vision.FaceDetector.createFromOptions(fileset, { baseOptions: { modelAssetPath: FACE_MODEL, delegate }, runningMode: 'VIDEO', minDetectionConfidence: 0.5 }))
    const objects = make((delegate) => vision.ObjectDetector.createFromOptions(fileset, { baseOptions: { modelAssetPath: OBJECT_MODEL, delegate }, runningMode: 'VIDEO', scoreThreshold: 0.35, maxResults: 6 }))
    objects.catch(() => {}) // the animal check is optional; a failed object model must not break the face check
    return { vision, faces, objects }
  })()
  shared.catch(() => { shared = null }) // allow a retry after a network failure
  return shared
}

/** Start downloading the detectors early (e.g. when the consultation page opens) so the camera check is instant. */
export function preloadHumanCheck(): void {
  if (typeof window === 'undefined') return
  void loadDetectors().catch(() => {})
}
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
    let timer: ReturnType<typeof setTimeout> | null = null
    const gate = new HumanGate({ enterFrames: 2 })
    const publish = (next: HumanCheck) => {
      const p = lastRef.current
      if (p.state === next.state && p.animal === next.animal && p.available === next.available) return
      lastRef.current = next; setResult(next)
    }
    publish({ state: 'checking', available: true })

    ;(async () => {
      let d: Detectors
      let faces: import('@mediapipe/tasks-vision').FaceDetector
      try {
        d = await loadDetectors()
        faces = await d.faces
      } catch {
        if (!cancelled) publish({ state: 'checking', available: false })
        return
      }
      if (cancelled) return
      let objects: import('@mediapipe/tasks-vision').ObjectDetector | null = null
      d.objects.then((o) => { objects = o }, () => {}) // joins in when ready; until then only the face check runs
      let lastTs = 0
      const tick = () => {
        const v = videoRef.current
        if (v && v.readyState >= 2 && v.videoWidth > 0 && !document.hidden) {
          const ts = Math.max(performance.now(), lastTs + 1); lastTs = ts // MediaPipe needs strictly increasing timestamps
          try {
            const fcs = faces.detectForVideo(v, ts).detections.map((x) => x.categories[0]?.score ?? 0)
            const objs = objects ? objects.detectForVideo(v, ts + 0.5).detections.map((x) => ({ label: x.categories[0]?.categoryName ?? '', score: x.categories[0]?.score ?? 0 })) : []
            const frame = classifyFrame({ faces: fcs, objects: objs })
            const state = gate.push(frame.verdict, frame.animal, ts)
            publish({ state, animal: gate.animal, available: true })
          } catch { /* one bad frame must not end the check */ }
        }
        if (!cancelled) timer = setTimeout(tick, gate.state === 'human' ? CHECK_STEADY_MS : CHECK_FAST_MS)
      }
      tick()
    })()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer) // the detectors are shared for the page and stay loaded
    }
  }, [enabled, videoRef])

  // When the camera is off there is nothing to check; report "checking" so a stale "human" never survives a restart.
  return enabled ? result : { state: 'checking', available: true }
}
