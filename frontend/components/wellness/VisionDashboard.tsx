/* eslint-disable react-hooks/refs -- the hook owns its refs internally and exposes only stable callbacks; the rule cannot see through that */
'use client'

import { useState } from 'react'
import { Camera, CameraOff, ShieldCheck } from 'lucide-react'
import { useVisionTracking } from '@/lib/vision/useVisionTracking'
import { describeSummary, type VisionSummary } from '@/lib/vision/metrics'

const BUSY = { requesting_camera: 'Waiting for camera permission…', loading_models: 'Getting ready…' } as const

/**
 * Background camera observation. Tracking runs silently on the device: no preview, no landmark
 * overlay and no live numbers are shown. A small "Camera on" badge and a Stop button always stay
 * visible so the person knows when the camera is in use. Results go to `onResult` (for the
 * clinician-facing report), never to the screen.
 */
export function VisionDashboard({ onResult }: { onResult?: (data: VisionSummary, lines: string[]) => void }) {
  const [consent, setConsent] = useState(false)
  const [posture, setPosture] = useState(false)
  const v = useVisionTracking({ overlay: false, posture })
  const active = v.status === 'running' || v.status === 'paused'
  const busy = v.status === 'requesting_camera' || v.status === 'loading_models'
  const cameraOn = active || busy

  return (
    <section className="rounded-3xl bg-white p-5 shadow-sm" aria-label="Camera observations">
      {/* The video element must stay mounted for the tracker; it is kept off-screen and never shown. */}
      <video ref={v.bindVideo} playsInline muted aria-hidden tabIndex={-1} className="pointer-events-none fixed left-0 top-0 h-px w-px opacity-0" />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><Camera size={18} className="text-teal-700" /><h2 className="font-semibold">Camera (optional)</h2></div>
        <span role="status" className={`rounded-full px-3 py-1 text-xs ${cameraOn ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>Camera: {v.status === 'paused' ? 'On (paused)' : cameraOn ? 'On' : 'Off'}</span>
      </div>
      <div className="mt-3 flex gap-2 rounded-2xl bg-teal-50 p-3 text-xs text-slate-700"><ShieldCheck size={16} className="mt-0.5 shrink-0 text-teal-700" />
        <p>The camera is analysed quietly on your device only. Nothing is shown on screen, and no video or images are uploaded or saved. Only simple counts and averages are kept, and only if you choose to. You can stop it at any time, and the session works fully without it.</p></div>

      {!cameraOn && (
        <div className="mt-4 space-y-2">
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />I agree to let this page use my camera on this device for the observations described above.</label>
          <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={posture} onChange={(e) => setPosture(e.target.checked)} />Also observe upper-body posture (needs your shoulders in view)</label>
          <button disabled={!consent} onClick={v.start} className="mt-1 inline-flex items-center gap-2 rounded-xl bg-teal-700 px-4 py-2 text-sm text-white disabled:opacity-40"><Camera size={16} />Start camera</button>
        </div>
      )}
      {v.error && <p role="alert" className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{v.error.message}</p>}
      {busy && <p className="mt-3 text-sm text-slate-600" aria-live="polite">{BUSY[v.status as keyof typeof BUSY]}</p>}

      {cameraOn && (
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-sm text-slate-600">{active ? 'Camera is on. Carry on with your session.' : ''}</p>
          <button onClick={() => { const d = v.stop(); onResult?.(d, describeSummary(d)) }} className="inline-flex items-center gap-1 rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-white"><CameraOff size={14} />Stop camera</button>
        </div>
      )}

      {v.summary && !cameraOn && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border p-3 text-sm">
          <span className="text-slate-600">Camera stopped. Observations are held on this device only.</span>
          <button onClick={v.discard} className="rounded-lg border px-3 py-1.5 text-xs">Discard observations</button>
        </div>
      )}
    </section>
  )
}
