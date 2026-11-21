'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, ClipboardList, ShieldCheck, UserRound } from 'lucide-react'
import toast from 'react-hot-toast'
import { psych, psychX, errorMessage, type Assignment, type ConsultationState, type Instrument, type TaskRun, type CustomForm } from '@/lib/psychApi'
import dynamic from 'next/dynamic'

// jsPsych touches `window` when imported, so it must only load in the browser.
const CognitiveTask = dynamic(() => import('./CognitiveTask').then((m) => m.CognitiveTask), { ssr: false, loading: () => <p className="text-sm text-slate-500">Loading activity…</p> })

const CONSENTS: [string, string, string][] = [
  ['online_consultation', 'Online psychological consultation', 'required'],
  ['assessment', 'Psychological assessment', 'required'],
  ['data_processing', 'Processing and storage of my assessment information', 'required'],
  ['observer_questionnaire', 'Optional: a partner or observer may be invited to complete a questionnaire about me', 'optional'],
  ['recording', 'Optional: record this consultation (not available in this version; nothing is recorded)', 'optional'],
]

const STATUS_TEXT: Record<Assignment['status'], string> = {
  assigned: 'Waiting for your psychologist to start it',
  active: 'In progress',
  paused: 'Paused by your psychologist',
  completed: 'Completed',
  ended: 'Ended',
}

function AssessmentForm({ assignment, instrument, onDone }: { assignment: Assignment; instrument: Instrument; onDone: (support: string | null) => void }) {
  const [answers, setAnswers] = useState<Record<string, number>>(assignment.draft ?? {})
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const complete = instrument.items.every((_, i) => answers[String(i)] !== undefined)
  const answered = Object.keys(answers).length

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const choose = (i: number, v: number) => {
    const next = { ...answers, [String(i)]: v }
    setAnswers(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { psych.saveDraft(assignment.id, next).catch(() => undefined) }, 600) // autosave progress
  }
  const submit = async () => {
    setBusy(true)
    try { onDone((await psych.submit(assignment.id, answers)).support_message) } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }

  return (
    <div className="rounded-2xl border p-4">
      <h3 className="font-semibold">{instrument.name}</h3>
      <p className="text-xs text-slate-500">{instrument.intro}</p>
      {instrument.attribution && <p className="mt-1 text-[11px] text-slate-500">{instrument.attribution}</p>}
      <div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-100" aria-hidden><div className="h-full bg-teal-600" style={{ width: `${(answered / instrument.items.length) * 100}%` }} /></div>
      {instrument.items.map((q, i) => (
        <fieldset key={i} className="mt-4">
          <legend className="text-sm">{i + 1}. {q}</legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {instrument.options.map((o, v) => (
              <label key={o} className={`cursor-pointer rounded-lg border p-2 text-xs ${answers[String(i)] === v ? 'border-teal-700 bg-teal-50' : ''}`}>
                <input type="radio" className="mr-1" name={`${assignment.id}-${i}`} checked={answers[String(i)] === v} onChange={() => choose(i, v)} />{o}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <button disabled={!complete || busy} onClick={submit} className="mt-4 w-full rounded-xl bg-teal-700 p-3 text-sm font-medium text-white disabled:opacity-40">
        {busy ? 'Submitting…' : 'Submit responses'}
      </button>
      <p className="mt-2 text-[11px] text-slate-500">Once submitted, your answers cannot be changed by you. Tell your psychologist if you made a mistake.</p>
    </div>
  )
}

export function PatientPanel({ state, instruments, refresh }: { state: ConsultationState; instruments: Instrument[]; refresh: () => void }) {
  const id = state.id
  const [form, setForm] = useState({ full_name: '', preferred_name: '', date_of_birth: '', contact: '', preferred_language: '', occupation: '' })
  const [age, setAge] = useState<number | null>(state.intake?.age ?? null)
  const [saved, setSaved] = useState(false)
  const [support, setSupport] = useState<string | null>(null)
  const seeded = useRef(false)
  const [tasks, setTasks] = useState<TaskRun[]>([])
  const [running, setRunning] = useState<string | null>(null)
  const [forms, setForms] = useState<CustomForm[]>([])
  const [formAnswers, setFormAnswers] = useState<Record<string, Record<string, number>>>({})
  const [formBusy, setFormBusy] = useState(false)

  useEffect(() => {
    if (running) return // don't re-render the task host while a task is running
    let live = true
    const load = () => { psychX.tasks(id).then((t) => { if (live) setTasks(t) }).catch(() => undefined); psychX.forms(id).then((f) => { if (live) setForms(f) }).catch(() => undefined) }
    load()
    const t = setInterval(load, 4000)
    return () => { live = false; clearInterval(t) }
  }, [id, running])

  useEffect(() => {
    if (seeded.current || !state.intake) return
    seeded.current = true
    const i = state.intake
    setForm({ full_name: i.full_name ?? '', preferred_name: i.preferred_name ?? '', date_of_birth: i.dob ?? '', contact: i.contact ?? '', preferred_language: i.preferred_language ?? '', occupation: i.occupation ?? '' })
  }, [state.intake])

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => { setForm({ ...form, [k]: e.target.value }); setSaved(false) }
  const save = async () => {
    try { setAge((await psych.saveIntake(id, form)).age); setSaved(true) } catch (e) { toast.error(errorMessage(e)) }
  }
  const toggle = async (kind: string, granted: boolean) => {
    try { await psych.setConsent(id, kind, granted); refresh() } catch (e) { toast.error(errorMessage(e)) }
  }
  const find = (a: Assignment) => instruments.find((x) => x.id === a.instrument)
  const field = 'mt-1 w-full rounded-xl border p-3 text-sm'

  return (
    <section className="max-h-[calc(100vh-6rem)] space-y-4 overflow-y-auto rounded-3xl bg-white p-5 shadow-sm" aria-label="Patient information and assessments">
      <div>
        <div className="flex items-center gap-2"><UserRound size={18} className="text-teal-700" /><h2 className="font-semibold">About you</h2></div>
        <p className="mt-1 text-xs text-slate-500">Share only what you are comfortable with. Everything here is optional except what your psychologist asks for.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs">Full legal name<input className={field} value={form.full_name} onChange={set('full_name')} autoComplete="name" /></label>
          <label className="text-xs">Preferred name<input className={field} value={form.preferred_name} onChange={set('preferred_name')} /></label>
          <label className="text-xs">Date of birth<input type="date" className={field} value={form.date_of_birth} onChange={set('date_of_birth')} /></label>
          <label className="text-xs">Age (calculated)<input readOnly className={`${field} bg-slate-50`} value={age ?? ''} /></label>
          <label className="text-xs">Contact information<input className={field} value={form.contact} onChange={set('contact')} /></label>
          <label className="text-xs">Preferred language
            <select className={field} value={form.preferred_language} onChange={set('preferred_language')}>
              <option value="">Prefer not to answer</option><option value="en">English</option><option value="kn">ಕನ್ನಡ (Kannada)</option><option value="hi">हिन्दी (Hindi)</option><option value="other">Other</option>
            </select>
          </label>
          <label className="text-xs sm:col-span-2">Occupation or education<input className={field} value={form.occupation} onChange={set('occupation')} /></label>
        </div>
        <button onClick={save} className="mt-3 rounded-xl bg-teal-700 px-4 py-2 text-sm text-white">Save information</button>
        {saved && <span role="status" className="ml-3 text-xs text-emerald-700"><Check size={14} className="mr-1 inline" />Saved</span>}
      </div>

      <div className="rounded-2xl bg-teal-50 p-4">
        <div className="flex items-center gap-2"><ShieldCheck size={18} className="text-teal-700" /><h3 className="font-semibold">Consent</h3></div>
        {CONSENTS.map(([kind, label, level]) => (
          <label key={kind} className="mt-3 flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={!!state.consents[kind]} disabled={kind === 'recording'} onChange={(e) => toggle(kind, e.target.checked)} />
            <span>{label}{level === 'required' && <span className="ml-1 text-xs text-slate-500">(needed for assessments)</span>}</span>
          </label>
        ))}
        <p className="mt-2 text-xs text-slate-500">You can withdraw consent at any time by unticking a box.</p>
      </div>

      <div>
        <div className="flex items-center gap-2"><ClipboardList size={18} className="text-teal-700" /><h2 className="font-semibold">Your assessments</h2></div>
        <p className="mt-1 text-xs text-slate-500">Your psychologist chooses which assessments you complete and when they start.</p>
        <div className="mt-3 space-y-3">
          {state.assignments.length === 0 && <p className="rounded-xl border border-dashed p-4 text-sm text-slate-500">No assessments assigned yet.</p>}
          {state.assignments.map((a) => {
            const ins = find(a)
            return (
              <div key={a.id}>
                <div className="flex items-center justify-between rounded-xl border p-3">
                  <div><p className="text-sm font-medium">{a.name}</p><p className="text-xs text-slate-500">{STATUS_TEXT[a.status]}{a.status === 'active' ? ` · ${a.answered_count}/${a.total_items} answered` : ''}</p></div>
                  {a.status === 'completed' && <Check size={18} className="text-emerald-600" aria-label="Completed" />}
                </div>
                {a.status === 'active' && ins && <div className="mt-2"><AssessmentForm assignment={a} instrument={ins} onDone={(s) => { setSupport(s); refresh() }} /></div>}
              </div>
            )
          })}
        </div>
        {tasks.length > 0 && (
          <div className="mt-4 space-y-2">
            <h3 className="text-sm font-semibold">Short activities</h3>
            {tasks.map((t) => (
              <div key={t.id} className="rounded-xl border p-3">
                <div className="flex items-center justify-between">
                  <div><p className="text-sm font-medium">{t.name}</p><p className="text-xs text-slate-500">{t.status === 'assigned' ? 'Waiting for your psychologist to start it' : t.status === 'active' ? 'Ready' : 'Completed'}</p></div>
                  {t.status === 'active' && running !== t.id && <button className="rounded-lg bg-teal-700 px-3 py-1.5 text-xs text-white" onClick={() => setRunning(t.id)}>Start</button>}
                  {t.status === 'completed' && <Check size={18} className="text-emerald-600" aria-label="Completed" />}
                </div>
                {running === t.id && (
                  <div className="mt-2">
                    <CognitiveTask task={t.task} onDone={async (trials) => { await psychX.submitTask(t.id, trials); setRunning(null); refresh() }} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {forms.length > 0 && (
          <div className="mt-4 space-y-2">
            <h3 className="text-sm font-semibold">Questionnaires from your psychologist</h3>
            {forms.map((f) => {
              const a = formAnswers[f.id] ?? {}
              const complete = !!f.items && f.items.every((_, i) => a[String(i)] !== undefined)
              return (
                <div key={f.id} className="rounded-xl border p-3">
                  <div className="flex items-center justify-between"><p className="text-sm font-medium">{f.title}</p><p className="text-xs text-slate-500">{f.status === 'assigned' ? 'Waiting for your psychologist to start it' : f.status === 'active' ? 'In progress' : 'Completed'}</p></div>
                  {f.status === 'active' && f.items && f.options && (
                    <div>
                      {f.intro && <p className="mt-1 text-xs text-slate-500">{f.intro}</p>}
                      {f.items.map((q, i) => (
                        <fieldset key={i} className="mt-3"><legend className="text-sm">{i + 1}. {q}</legend>
                          <div className="mt-1 flex flex-wrap gap-2">{f.options!.map((o, v) => <label key={o} className={`cursor-pointer rounded-lg border px-2 py-1 text-xs ${a[String(i)] === v ? 'border-teal-700 bg-teal-50' : ''}`}><input type="radio" className="mr-1" name={`${f.id}-${i}`} checked={a[String(i)] === v} onChange={() => setFormAnswers({ ...formAnswers, [f.id]: { ...a, [String(i)]: v } })} />{o}</label>)}</div>
                        </fieldset>
                      ))}
                      <button disabled={!complete || formBusy} className="mt-3 w-full rounded-xl bg-teal-700 p-2 text-sm text-white disabled:opacity-40" onClick={async () => { setFormBusy(true); try { await psychX.submitForm(f.id, a); refresh() } catch (e) { toast.error(errorMessage(e)) } finally { setFormBusy(false) } }}>Submit</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {support && <div role="alert" className="mt-3 rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800">{support}</div>}
      </div>
      <p className="text-xs leading-relaxed text-slate-500">Screening questionnaires are not diagnoses. If you are in immediate danger, call 112.</p>
    </section>
  )
}
