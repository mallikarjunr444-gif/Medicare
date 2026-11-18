'use client'

import { useState } from 'react'
import { ExternalLink, PhoneOff, Video } from 'lucide-react'

/**
 * Left panel: the video consultation only. Microphone, camera, speaker, chat and screen sharing are provided by
 * Jitsi's own toolbar inside the frame. No clinical notes, history or results are ever shown here.
 */
export function JitsiPanel({ room, displayName, onEnd }: { room: string; displayName: string; onEnd: () => void }) {
  const [loaded, setLoaded] = useState(false)
  const [left, setLeft] = useState(false)
  const hash = [
    'config.prejoinPageEnabled=false',
    'config.disableDeepLinking=true',
    'config.disableThirdPartyRequests=true',
    'config.localRecording.disable=true',
    'config.recordingService.enabled=false',
    'config.liveStreaming.enabled=false',
    'interfaceConfig.SHOW_JITSI_WATERMARK=false',
    `userInfo.displayName=${JSON.stringify(displayName)}`,
  ].join('&')
  const url = `https://meet.jit.si/${encodeURIComponent(room)}#${hash}`

  return (
    <section className="flex min-h-[520px] flex-col overflow-hidden rounded-3xl bg-[#123e39] p-4 text-white shadow-sm" aria-label="Video consultation">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Video consultation</h2>
          <p className="text-xs text-emerald-100">Private room. Recording is off.</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs ${left ? 'bg-rose-500/30' : loaded ? 'bg-emerald-400/25' : 'bg-white/10'}`} role="status">
          ● {left ? 'Call ended' : loaded ? 'Connected to room' : 'Connecting…'}
        </span>
      </div>

      <div className="relative my-3 flex-1 overflow-hidden rounded-2xl bg-black/30">
        {!left ? (
          <iframe
            title="Video consultation"
            src={url}
            allow="camera; microphone; display-capture; autoplay; clipboard-write; fullscreen"
            onLoad={() => setLoaded(true)}
            className="absolute inset-0 h-full w-full border-0"
          />
        ) : (
          <div className="grid h-full min-h-[360px] place-items-center text-center">
            <div>
              <Video className="mx-auto mb-2 opacity-70" />
              <p className="text-sm">You left the call.</p>
              <button onClick={() => { setLoaded(false); setLeft(false) }} className="mt-3 rounded-full bg-white/15 px-4 py-2 text-sm">Rejoin</button>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm">
          <ExternalLink size={14} /> Open in new tab
        </a>
        <button onClick={() => { setLeft(true); onEnd() }} className="inline-flex items-center gap-2 rounded-full bg-rose-600 px-5 py-2 text-sm font-medium">
          <PhoneOff size={14} /> End call
        </button>
      </div>
      <p className="mt-3 text-center text-[11px] leading-relaxed text-emerald-100">
        Mic, camera, speaker and screen sharing are in the video toolbar. This uses the public Jitsi server (meet.jit.si), which is not
        suitable for confidential clinical use. Self-host Jitsi or use LiveKit before real patients.
      </p>
    </section>
  )
}
