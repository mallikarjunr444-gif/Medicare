'use client'

import { CameraOff, Loader2, ScanFace } from 'lucide-react'
import type { CameraReport } from '../video/PatientWebcamPiP'
import { humanMessage } from '@/lib/vision/humanCheck'

interface CameraGateProps {
  report: CameraReport | null
  /** True once the camera had been working, i.e. it was switched off or lost in the middle of the consultation. */
  midCall: boolean
  onRetry: () => void
  onEnd: () => void
}

/** Full-screen stop shown while the camera is off or the picture is not a person. */
export function CameraGate({ report, midCall, onRetry, onEnd }: CameraGateProps) {
  const camera = report?.camera ?? 'starting'
  let title = 'Turn your camera on to continue'
  let body = ''
  let steps: string[] = []
  let busy = false

  if (camera === 'starting') {
    title = 'Turning on your camera…'
    body = 'Your browser will ask for permission. Choose Allow so the doctor can see you.'
    busy = true
  } else if (camera === 'denied') {
    body = 'The camera is blocked, so it could not start by itself. Please turn it on yourself:'
    steps = ['Tap the camera or lock icon next to the web address.', 'Set Camera to Allow.', 'Come back here and press “Try again”.']
  } else if (camera === 'no_camera') {
    body = 'No camera was found on this device. Plug one in or use a device with a camera, then press “Try again”.'
  } else if (camera === 'in_use') {
    body = 'Another app is using the camera. Close it, then press “Try again”.'
  } else if (camera === 'unsupported') {
    body = 'This browser cannot use the camera here. Open the site in an up-to-date browser over a secure (https) link.'
  } else if (camera === 'lost') {
    body = midCall ? 'Your camera turned off during the consultation. The consultation continues as soon as it is back on.' : 'Your camera stopped. Turn it on, then press “Try again”.'
  } else {
    // camera is live but the person check has not passed
    const h = report!.human
    if (h.state === 'checking') { title = 'Checking your camera…'; body = humanMessage('checking'); busy = true }
    else { title = h.state === 'animal' ? 'Please show yourself, not an animal' : 'Please move into view'; body = humanMessage(h.state, h.animal) }
  }
  const live = camera === 'live'

  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="camera-gate-title" className="fixed inset-0 z-[60] flex items-center justify-center bg-clinic-ink/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-3xl bg-white p-6 text-center shadow-[0_20px_60px_rgba(15,47,54,.45)]">
        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-clinic-porcelain text-clinic-ink">
          {busy ? <Loader2 size={26} className="motion-safe:animate-spin" aria-hidden="true" /> : live ? <ScanFace size={26} aria-hidden="true" /> : <CameraOff size={26} aria-hidden="true" />}
        </div>
        <h2 id="camera-gate-title" className="text-[20px] font-bold text-clinic-ink">{title}</h2>
        <p className="mt-2 text-[15px] leading-snug text-clinic-muted">{body}</p>
        {steps.length > 0 && (
          <ol className="mx-auto mt-3 max-w-xs list-decimal space-y-1 pl-5 text-left text-[14px] text-clinic-ink">
            {steps.map((x) => <li key={x}>{x}</li>)}
          </ol>
        )}
        <p className="mt-3 text-[12px] text-clinic-muted">The camera is required for every consultation. It is checked on your device and pictures are not saved.</p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
          {!live && camera !== 'starting' && (
            <button onClick={onRetry} className="h-11 rounded-xl bg-clinic-teal px-5 text-[14px] font-semibold text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-clinic-teal/30">Try again</button>
          )}
          <button onClick={onEnd} className="h-11 rounded-xl border border-clinic-hairline px-5 text-[14px] font-semibold text-clinic-ink transition hover:bg-clinic-porcelain focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-clinic-teal/25">End consultation</button>
        </div>
      </div>
    </div>
  )
}
