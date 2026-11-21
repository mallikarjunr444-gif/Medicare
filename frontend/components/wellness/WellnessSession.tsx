'use client'

import { ArrowLeft } from 'lucide-react'
import { VisionDashboard } from './VisionDashboard'

export function WellnessSession({ onExit }: { onExit: () => void }) {
  return (
    <main className="mx-auto max-w-4xl space-y-4 p-4">
      <button onClick={onExit} className="inline-flex items-center gap-1 text-sm"><ArrowLeft size={16} />Back</button>
      <div>
        <h1 className="text-2xl font-semibold">Dr. Ananya — wellness session</h1>
        <p className="mt-1 text-sm text-slate-600">Dr. Ananya is an AI wellness companion, not a licensed psychologist, and cannot diagnose. The camera is optional and runs quietly in the background. It only records simple measurements, such as whether your face was in view, and never shows or infers emotion, honesty or mental health.</p>
      </div>
      <VisionDashboard />
      <p className="text-xs text-slate-500">If you are in immediate danger or thinking about harming yourself, call 112 (India) or your local emergency number now.</p>
    </main>
  )
}
