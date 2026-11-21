'use client'

import { AlertTriangle, Check, ClipboardList, Copy, Pause, Play, Square } from 'lucide-react'
import toast from 'react-hot-toast'
import { psych, errorMessage, type Assignment, type ConsultationState, type Instrument } from '@/lib/psychApi'

const RESTRICTED = [
  ['WAIS-IV', 'Authorized administration and results entry only (coming later)'],
  ['CAARS', 'Authorized forms and scoring only (coming later)'],
  ['PAI', 'Authorized results entry only (coming later)'],
]

export function PsychologistPanel({ state, instruments, refresh }: { state: ConsultationState; instruments: Instrument[]; refresh: () => void }) {
  const id = state.id
  const consented = !!state.consents.assessment && !!state.consents.data_processing
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); refresh() } catch (e) { toast.error(errorMessage(e)) } }
  const copy = async () => { try { await navigator.clipboard.writeText(state.join_code ?? ''); toast.success('Join code copied') } catch { /* ignore */ } }
  const assignedIds = new Set(state.assignments.filter((a) => !['completed', 'ended'].includes(a.status)).map((a) => a.instrument))
  const btn = 'inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs'

  const controls = (a: Assignment) => (
    <div className="mt-2 flex flex-wrap gap-2">
      {a.status === 'assigned' && <button className={btn} onClick={() => run(() => psych.action(a.id, 'start'))}><Play size={12} />Start</button>}
      {a.status === 'active' && <button className={btn} onClick={() => run(() => psych.action(a.id, 'pause'))}><Pause size={12} />Pause</button>}
      {a.status === 'paused' && <button className={btn} onClick={() => run(() => psych.action(a.id, 'resume'))}><Play size={12} />Resume</button>}
      {['assigned', 'active', 'paused'].includes(a.status) && <button className={btn} onClick={() => run(() => psych.action(a.id, 'end'))}><Square size={12} />End</button>}
    </div>
  )

  return (
    <section className="max-h-[calc(100vh-6rem)] space-y-4 overflow-y-auto rounded-3xl bg-white p-5 shadow-sm" aria-label="Clinician workspace">
      {(state.alerts ?? []).filter((a) => !a.acknowledged_at).map((al) => (
        <div key={al.id} role="alert" className="rounded-2xl border border-rose-400 bg-rose-50 p-3 text-sm text-rose-900">
          <div className="flex items-center gap-2 font-semibold"><AlertTriangle size={16} />Safety alert</div>
          <p className="mt-1">{al.message}</p>
          <button className={`${btn} mt-2 bg-white`} onClick={() => run(() => psych.ack(al.id))}>Acknowledge</button>
        </div>
      ))}

      <div className="rounded-2xl bg-teal-50 p-4">
        <p className="text-xs text-slate-600">Patient join code</p>
        <div className="mt-1 flex items-center gap-2">
          <span className="font-mono text-2xl tracking-widest">{state.join_code}</span>
          <button className={btn} onClick={copy} aria-label="Copy join code"><Copy size={12} />Copy</button>
        </div>
        <p className="mt-1 text-xs text-slate-600">{state.patient_joined ? 'Patient has joined.' : 'Waiting for the patient to join.'}</p>
        <div className="mt-2 flex gap-2">
          {state.status === 'scheduled' && <button className="rounded-lg bg-teal-700 px-3 py-1.5 text-xs text-white" onClick={() => run(() => psych.setStatus(id, 'start'))}>Start consultation</button>}
          {state.status !== 'ended' && <button className={btn} onClick={() => { if (confirm('End this consultation?')) run(() => psych.setStatus(id, 'end')) }}>End consultation</button>}
        </div>
      </div>

      <div>
        <h3 className="font-semibold">Patient</h3>
        {state.intake ? (
          <dl className="mt-1 grid grid-cols-2 gap-x-3 text-sm">
            <dt className="text-slate-500">Name</dt><dd>{state.intake.preferred_name || state.intake.full_name || '—'}</dd>
            <dt className="text-slate-500">Age</dt><dd>{state.intake.age ?? '—'}</dd>
            <dt className="text-slate-500">Language</dt><dd>{state.intake.preferred_language || '—'}</dd>
            <dt className="text-slate-500">Occupation</dt><dd>{state.intake.occupation || '—'}</dd>
          </dl>
        ) : <p className="text-sm text-slate-500">Patient has not completed intake yet.</p>}
        <p className="mt-2 text-xs">Consent: {consented ? <span className="text-emerald-700">assessment + data processing granted</span> : <span className="text-amber-700">not yet granted — assessments are blocked</span>}</p>
      </div>

      <div>
        <div className="flex items-center gap-2"><ClipboardList size={18} className="text-teal-700" /><h3 className="font-semibold">Assessments</h3></div>
        <div className="mt-2 space-y-2">
          {instruments.map((ins) => (
            <div key={ins.id} className="flex items-center justify-between rounded-xl border p-3">
              <div><p className="text-sm font-medium">{ins.name}</p><p className="text-xs text-slate-500">{ins.purpose}</p></div>
              <button disabled={!consented || assignedIds.has(ins.id) || state.status === 'ended'} onClick={() => run(() => psych.assign(id, ins.id))} className="rounded-lg bg-teal-700 px-3 py-1.5 text-xs text-white disabled:opacity-40">{assignedIds.has(ins.id) ? 'Assigned' : 'Assign'}</button>
            </div>
          ))}
          {RESTRICTED.map(([n, d]) => (
            <div key={n} className="rounded-xl border border-dashed p-3 opacity-70"><p className="text-sm font-medium">{n}</p><p className="text-xs text-slate-500">{d}</p></div>
          ))}
        </div>
        {state.assignments.length > 0 && <h4 className="mt-4 text-sm font-semibold">In this consultation</h4>}
        {state.assignments.map((a) => (
          <div key={a.id} className="mt-2 rounded-xl border p-3">
            <div className="flex justify-between text-sm"><span className="font-medium">{a.name}</span><span className="text-xs capitalize text-slate-500">{a.status}</span></div>
            {a.status === 'active' && <p className="text-xs text-slate-500">{a.answered_count}/{a.total_items} answered</p>}
            {controls(a)}
          </div>
        ))}
      </div>

      {(state.results ?? []).length > 0 && (
        <div>
          <h3 className="font-semibold">Results</h3>
          {(state.results ?? []).map((r) => (
            <div key={r.assignment_id} className="mt-2 rounded-xl border p-3 text-sm">
              <div className="flex items-center justify-between"><span className="font-medium">{r.name}</span><Check size={14} className="text-emerald-600" /></div>
              {r.total !== null ? <p>Score {r.total} · {r.label}</p> : <p>Screen: {r.screening} ({r.flags.shadedCount ?? 0} shaded responses)</p>}
              {r.flags.item9Positive && <p className="text-rose-700">Item 9 endorsed — clinical review needed.</p>}
              <p className="mt-1 text-xs text-slate-500">{r.notice}</p>
              {instruments.find((i) => i.id === r.instrument)?.attribution && <p className="mt-1 text-[11px] text-slate-500">{instruments.find((i) => i.id === r.instrument)?.attribution}</p>}
              <details className="mt-1 text-xs"><summary className="cursor-pointer">Item answers</summary>
                <ol className="mt-1 list-decimal pl-5">{Object.entries(r.answers).sort((a, b) => +a[0] - +b[0]).map(([k, v]) => <li key={k}>{v}</li>)}</ol>
              </details>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-slate-500">Screening results support, but never replace, clinical judgment. No AI-generated diagnosis is produced.</p>
    </section>
  )
}
