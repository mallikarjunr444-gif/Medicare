/* eslint-disable react-hooks/refs -- the hook owns its refs internally and exposes only stable callbacks; the rule cannot see through that */
'use client'

import { useState } from 'react'
import { Camera, CameraOff, Pause, Play, ShieldCheck } from 'lucide-react'
import { useVisionTracking } from '@/lib/vision/useVisionTracking'
import type { VisionSummary } from '@/lib/vision/metrics'

const GAZE = { toward_screen: 'Toward screen (estimate)', away_from_screen: 'Away from screen (estimate)', unknown: 'No estimate' } as const
const QUALITY = { good: 'Good', fair: 'Fair', poor: 'Poor', none: '—' } as const
const LIGHT = { ok: 'Adequate', dim: 'Dim — move to a brighter spot', bright: 'Very bright', unknown: '—' } as const
const BUSY = { requesting_camera: 'Waiting for camera permission…', loading_models: 'Loading tracking model (first time may take a few seconds)…' } as const

export function VisionDashboard({ onResult }: { onResult?: (data: VisionSummary, lines: string[]) => void }) {
  const [consent, setConsent] = useState(false)
  const [overlay, setOverlay] = useState(true)
  const [posture, setPosture] = useState(false)
  const v = useVisionTracking({ overlay, posture })
  const active = v.status === 'running' || v.status === 'paused'
  const busy = v.status === 'requesting_camera' || v.status === 'loading_models'
  const cameraOn = active || busy
  const row = (k: string, val: string) => <div className="flex justify-between gap-3 border-b border-slate-100 py-1.5 text-sm"><span className="text-slate-500">{k}</span><span className="text-right font-medium">{val}</span></div>

  return (
    <section className="rounded-3xl bg-white p-5 shadow-sm" aria-label="Camera observations">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><Camera size={18} className="text-teal-700" /><h2 className="font-semibold">Camera observations (optional)</h2></div>
        <span role="status" className={`rounded-full px-3 py-1 text-xs ${cameraOn ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>Camera: {v.status === 'paused' ? 'On (analysis paused)' : cameraOn ? 'On' : 'Off'}</span>
      </div>
      <div className="mt-3 flex gap-2 rounded-2xl bg-teal-50 p-3 text-xs text-slate-700"><ShieldCheck size={16} className="mt-0.5 shrink-0 text-teal-700" />
        <p>Video is analysed on your device only. No video, images or audio are uploaded or saved. Only counts and averages (for example, blink count or how often your face was visible) are kept, and only if you choose to. You can stop the camera at any time. The session works fully without it.</p></div>

      {!cameraOn && (
        <div className="mt-4 space-y-2">
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />I agree to let this page use my camera on this device for the observations described above.</label>
          <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />Show facial landmark overlay</label>
          <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={posture} onChange={(e) => setPosture(e.target.checked)} />Also observe upper-body posture (needs your shoulders in view)</label>
          <button disabled={!consent} onClick={v.start} className="mt-1 inline-flex items-center gap-2 rounded-xl bg-teal-700 px-4 py-2 text-sm text-white disabled:opacity-40"><Camera size={16} />Start camera</button>
        </div>
      )}
      {v.error && <p role="alert" className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{v.error.message}</p>}
      {busy && <p className="mt-3 text-sm text-slate-600" aria-live="polite">{BUSY[v.status as keyof typeof BUSY]}</p>}

      <div className={cameraOn ? 'mt-4 grid gap-4 md:grid-cols-2' : 'hidden'}>
        <div className="relative overflow-hidden rounded-2xl bg-slate-900">
          <video ref={v.bindVideo} playsInline muted className="aspect-[4/3] w-full -scale-x-100 object-cover" aria-label="Camera preview" />
          <canvas ref={v.bindOverlay} className="pointer-events-none absolute inset-0 h-full w-full -scale-x-100 object-cover" aria-hidden />
        </div>
        <div>
          {row('Face detected', v.live.faceVisible ? (v.live.multipleFaces ? 'Yes (more than one face)' : 'Yes') : 'No')}
          {row('Tracking status', v.status === 'running' ? 'Active' : v.status === 'paused' ? 'Paused' : 'Starting')}
          {row('Tracking quality', QUALITY[v.live.quality])}
          {row('Face in frame', v.live.faceVisible ? (v.live.inFrame ? 'Yes' : 'Partly out of frame') : '—')}
          {row('Lighting', LIGHT[v.live.lighting])}
          {row('Head orientation', v.live.head ? `turn ${Math.abs(v.live.head.yaw).toFixed(0)}° · tilt ${Math.abs(v.live.head.pitch).toFixed(0)}° · roll ${Math.abs(v.live.head.roll).toFixed(0)}°` : '—')}
          {row('Gaze', GAZE[v.live.gaze])}
          {row('Blink events', `${v.live.blinks}${v.live.blinks ? ` (~${v.live.blinksPerMin.toFixed(0)}/min)` : ''}`)}
          {posture && row('Upper body', v.live.posture ? `shoulder tilt ${v.live.posture.tilt.toFixed(0)}° · ${v.live.posture.closer === 'similar' ? 'similar distance' : v.live.posture.closer === 'closer' ? 'closer than at start' : 'further than at start'}` : 'Not in view')}
          {v.live.quality === 'poor' && v.status === 'running' && <p className="mt-2 text-xs text-amber-800">Tracking is struggling. Face the camera, keep your face in the frame and improve the lighting.</p>}
          <div className="mt-3 flex gap-2">
            {v.status === 'running' ? <button onClick={v.pause} className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs"><Pause size={14} />Pause analysis</button> : v.status === 'paused' ? <button onClick={v.resume} className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs"><Play size={14} />Resume</button> : null}
            <button onClick={() => { const d = v.stop(); onResult?.(d, []) }} className="inline-flex items-center gap-1 rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-white"><CameraOff size={14} />Stop camera</button>
          </div>
        </div>
      </div>

      {v.summary && !cameraOn && (
        <div className="mt-4 rounded-2xl border p-4">
          <h3 className="text-sm font-semibold">What the camera measured</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{v.summary.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
          <button onClick={v.discard} className="mt-3 rounded-lg border px-3 py-1.5 text-xs">Discard these observations</button>
        </div>
      )}
    </section>
  )
}
