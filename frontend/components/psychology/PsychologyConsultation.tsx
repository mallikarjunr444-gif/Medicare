'use client'

import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import toast from 'react-hot-toast'
import { ensureIdentity, errorMessage, psych, signIn, type ConsultationState, type Instrument } from '@/lib/psychApi'
import { JitsiPanel } from './JitsiPanel'
import { PatientPanel } from './PatientPanel'
import { PsychologistPanel } from './PsychologistPanel'
import { ClinicianWorkspace } from './ClinicianWorkspace'

export function PsychologyConsultation({ onExit }: { onExit: () => void }) {
  const [mode, setMode] = useState<'lobby' | 'room'>('lobby')
  const [id, setId] = useState<string | null>(null)
  const [state, setState] = useState<ConsultationState | null>(null)
  const [instruments, setInstruments] = useState<Instrument[]>([])
  const [code, setCode] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [panel, setPanel] = useState<'room' | 'workspace'>('room')

  const refresh = useCallback(async () => {
    if (!id) return
    try { setState(await psych.state(id)) } catch { /* transient; next poll retries */ }
  }, [id])

  useEffect(() => {
    if (mode !== 'room' || !id) return
    refresh()
    const t = setInterval(refresh, 4000)
    return () => clearInterval(t)
  }, [mode, id, refresh])

  const enter = async (cid: string) => {
    setInstruments(await psych.instruments())
    setId(cid); setMode('room')
  }
  const join = async () => {
    setBusy(true)
    try { await ensureIdentity(); await enter((await psych.join(code.trim())).id) } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  const start = async () => {
    setBusy(true)
    try {
      await signIn(email.trim(), password)
      const me = await psych.me()
      if (!me.is_psychologist) { toast.error('This account is not registered as a psychologist.'); return }
      await enter((await psych.create()).id)
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }

  const input = 'w-full rounded-xl border p-3 text-sm'
  if (mode === 'lobby') {
    return (
      <main className="mx-auto max-w-3xl p-4">
        <button onClick={onExit} className="mb-4 inline-flex items-center gap-1 text-sm"><ArrowLeft size={16} />Back</button>
        <h1 className="text-2xl font-semibold">Psychological consultation</h1>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <section className="rounded-3xl bg-white p-5 shadow-sm">
            <h2 className="font-semibold">I am a patient</h2>
            <p className="mt-1 text-xs text-slate-500">Enter the join code your psychologist gave you.</p>
            <input className={`${input} mt-3 font-mono uppercase tracking-widest`} maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} placeholder="JOIN CODE" aria-label="Join code" />
            <button disabled={busy || code.trim().length < 6} onClick={join} className="mt-3 w-full rounded-xl bg-teal-700 p-3 text-sm text-white disabled:opacity-40">Join consultation</button>
          </section>
          <section className="rounded-3xl bg-white p-5 shadow-sm">
            <h2 className="font-semibold">I am a psychologist</h2>
            <p className="mt-1 text-xs text-slate-500">Sign in with your registered psychologist account.</p>
            <input className={`${input} mt-3`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" autoComplete="username" />
            <input className={`${input} mt-2`} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoComplete="current-password" />
            <button disabled={busy || !email || !password} onClick={start} className="mt-3 w-full rounded-xl bg-teal-700 p-3 text-sm text-white disabled:opacity-40">Start new consultation</button>
          </section>
        </div>
        <p className="mt-4 text-xs text-slate-500">This is a screening and documentation tool, not a diagnostic service. In an emergency call 112.</p>
      </main>
    )
  }

  if (!state) return <main className="p-8 text-sm text-slate-500">Loading consultation…</main>
  const name = state.role === 'psychologist' ? 'Psychologist' : state.intake?.preferred_name || 'Patient'
  const isPsy = state.role === 'psychologist'
  return (
    <main className="mx-auto max-w-7xl p-4">
      {isPsy && (
        <div className="mb-3 flex gap-2 print:hidden" role="tablist" aria-label="Consultation view">
          {(['room', 'workspace'] as const).map((p) => (
            <button key={p} role="tab" aria-selected={panel === p} onClick={() => setPanel(p)} className={`rounded-xl border px-4 py-2 text-sm ${panel === p ? 'border-teal-700 bg-teal-50' : 'bg-white'}`}>{p === 'room' ? 'Consultation' : 'Psychologist workspace'}</button>
          ))}
        </div>
      )}
      {/* The video stays mounted while the psychologist uses the workspace, so the call is never dropped. */}
      <div className={panel === 'workspace' ? 'hidden' : 'grid gap-4 lg:grid-cols-2'}>
        <JitsiPanel room={state.room} displayName={name} onEnd={() => { setMode('lobby'); setState(null); setId(null); setPanel('room') }} />
        {isPsy
          ? <PsychologistPanel state={state} instruments={instruments} refresh={refresh} />
          : <PatientPanel state={state} instruments={instruments} refresh={refresh} />}
      </div>
      {isPsy && panel === 'workspace' && <ClinicianWorkspace state={state} />}
    </main>
  )
}
