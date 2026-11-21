'use client'

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { errorMessage, psychX, type ConsultationState, type Dashboard, type NoteRow, type Report } from '@/lib/psychApi'

const TABS = ['Dashboard', 'Clinical notes', 'Patient history', 'Interview', 'Licensed results', 'Observers & tasks', 'Report'] as const
type Tab = (typeof TABS)[number]
const input = 'w-full rounded-xl border p-2 text-sm'
const btn = 'rounded-lg bg-teal-700 px-3 py-1.5 text-xs text-white disabled:opacity-40'
const ghost = 'rounded-lg border px-3 py-1.5 text-xs'
const pretty = (k: string) => k.replace(/_/g, ' ')
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString() : '—')

function Dash({ id }: { id: string }) {
  const [d, setD] = useState<Dashboard | null>(null)
  useEffect(() => { psychX.dashboard(id).then(setD).catch((e) => toast.error(errorMessage(e))) }, [id])
  if (!d) return <p className="text-sm text-slate-500">Loading…</p>
  return (
    <div className="space-y-4 text-sm">
      {d.alerts.filter((a) => !a.acknowledged_at).length > 0 && <div role="alert" className="rounded-xl border border-rose-400 bg-rose-50 p-3 text-rose-900">Unacknowledged safety alerts: {d.alerts.filter((a) => !a.acknowledged_at).map((a) => a.message).join(' · ')}</div>}
      <section><h3 className="font-semibold">Assessments</h3>
        {d.assessments.length === 0 && <p className="text-slate-500">None assigned.</p>}
        {d.assessments.map((a) => (
          <div key={a.id} className="mt-2 rounded-xl border p-3">
            <div className="flex justify-between"><b>{a.name}</b><span className="capitalize text-slate-500">{a.status}</span></div>
            {a.result && <p>{a.result.total !== null ? `Score ${a.result.total} — ` : 'Screen: '}{a.result.label ?? a.result.screening}{a.result.corrected ? ' (corrected)' : ''}</p>}
            {a.result && <p className="text-xs text-slate-500">{a.result.notice}</p>}
          </div>
        ))}
      </section>
      {d.comparison.length > 0 && <section><h3 className="font-semibold">Earlier results (same patient)</h3>
        {d.comparison.map((c, i) => <p key={i}>{c.name}: {c.total_score ?? '—'} ({c.severity}) · {fmt(c.submitted_at)}</p>)}</section>}
      <section><h3 className="font-semibold">Custom questionnaires <span className="font-normal text-slate-500">(unscored)</span></h3>
        {d.forms.length === 0 ? <p className="text-slate-500">None.</p> : d.forms.map((f) => <div key={f.id} className="mt-1"><p>{f.title}: {f.status}</p>{f.answers && <ul className="ml-4 list-disc text-xs">{f.items.map((q, i) => <li key={i}>{q} → {f.options[f.answers![String(i)]]}</li>)}</ul>}</div>)}</section>
      <section><h3 className="font-semibold">Observer questionnaires</h3>
        {d.observers.length === 0 ? <p className="text-slate-500">None invited.</p> : d.observers.map((o) => <p key={o.id}>{o.label}{o.relationship ? ` (${o.relationship})` : ''}: {o.status}</p>)}</section>
      <section><h3 className="font-semibold">Supplementary tasks <span className="font-normal text-slate-500">(not IQ or diagnostic)</span></h3>
        {d.tasks.length === 0 ? <p className="text-slate-500">None.</p> : d.tasks.map((t) => <p key={t.id}>{t.name}: {t.status}{t.summary ? ` — ${JSON.stringify(t.summary)}` : ''}</p>)}</section>
      <section><h3 className="font-semibold">Licensed instrument results</h3>
        {d.external.length === 0 ? <p className="text-slate-500">None entered.</p> : d.external.map((e) => <p key={e.id}>{e.name} · {e.administered_on} · {e.scores.map((s) => `${s.label} ${s.value}`).join(', ')}</p>)}</section>
      <section><h3 className="font-semibold">Missing information</h3>
        {d.missing.length === 0 ? <p className="text-emerald-700">Nothing missing.</p> : <ul className="list-disc pl-5 text-amber-800">{d.missing.map((m, i) => <li key={i}>{m}</li>)}</ul>}</section>
    </div>
  )
}

function Notes({ id, history }: { id: string; history: boolean }) {
  const [kinds, setKinds] = useState<string[]>([])
  const [notes, setNotes] = useState<NoteRow[]>([])
  const [kind, setKind] = useState('')
  const [body, setBody] = useState('')
  const [prior, setPrior] = useState<Awaited<ReturnType<typeof psychX.history>> | null>(null)
  const load = useCallback(async () => {
    try {
      const r = await psychX.notes(id)
      const list = history ? r.kinds.history : r.kinds.notes
      setKinds(list); setKind((k) => (list.includes(k) ? k : list[0]))
      setNotes(r.notes.filter((n) => list.includes(n.kind)))
      if (history) setPrior(await psychX.history(id))
    } catch (e) { toast.error(errorMessage(e)) }
  }, [id, history])
  useEffect(() => { load() }, [load])
  const add = async () => { try { await psychX.addNote(id, kind, body); setBody(''); load() } catch (e) { toast.error(errorMessage(e)) } }
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-slate-500">Visible to psychologists only. Never shown to the patient.</p>
      <div className="flex gap-2"><select className={input} value={kind} onChange={(e) => setKind(e.target.value)}>{kinds.map((k) => <option key={k} value={k}>{pretty(k)}</option>)}</select></div>
      <textarea className={input} rows={4} maxLength={8000} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Note text" />
      <button className={btn} disabled={!body.trim()} onClick={add}>Add entry</button>
      {notes.map((n) => <div key={n.id} className="rounded-xl border p-3"><p className="text-xs capitalize text-slate-500">{pretty(n.kind)} · {fmt(n.created_at)}</p><p className="whitespace-pre-wrap">{n.body}</p></div>)}
      {history && prior && (
        <div><h3 className="mt-4 font-semibold">Assessment timeline</h3>
          {prior.consultations.length === 0 ? <p className="text-slate-500">No consultations yet.</p> : prior.consultations.map((c) => <p key={c.id}>{fmt(c.created_at)} · {c.status} · {c.assessments} assessment(s) · {c.approved_reports} approved report(s)</p>)}
          {prior.history.filter((h) => !notes.some((n) => n.id === h.id)).map((h) => <div key={h.id} className="mt-2 rounded-xl border p-3"><p className="text-xs capitalize text-slate-500">{pretty(h.kind)} · {fmt(h.created_at)} (earlier consultation)</p><p className="whitespace-pre-wrap">{h.body}</p></div>)}
        </div>)}
    </div>
  )
}

const SECTIONS = [['presenting', 'Presenting symptoms'], ['history', 'Relevant history'], ['functioning', 'Functional impairment'], ['risk', 'Risk and safety'], ['criteria', 'Diagnostic criteria review'], ['formulation', 'Clinical formulation']] as const
const FIELDS = ['findings', 'supporting_evidence', 'contradicting_evidence', 'duration', 'frequency', 'severity', 'functional_impact'] as const
function Interview({ id }: { id: string }) {
  const [data, setData] = useState<Record<string, any>>({})
  useEffect(() => { psychX.interview(id).then((r) => setData(r.data)).catch(() => undefined) }, [id])
  const set = (s: string, f: string, v: string) => setData({ ...data, [s]: { ...(data[s] ?? {}), [f]: v } })
  const save = async () => { try { await psychX.saveInterview(id, data); toast.success('Interview saved') } catch (e) { toast.error(errorMessage(e)) } }
  return (
    <div className="space-y-4 text-sm">
      <p className="text-xs text-slate-500">Psychologist-led. Nothing here is generated by AI. Diagnostic impressions are yours alone.</p>
      {SECTIONS.map(([sid, title]) => (
        <details key={sid} className="rounded-xl border p-3"><summary className="cursor-pointer font-medium">{title}</summary>
          {FIELDS.map((f) => <label key={f} className="mt-2 block text-xs capitalize">{pretty(f)}<textarea className={input} rows={f === 'findings' ? 3 : 2} maxLength={4000} value={data[sid]?.[f] ?? ''} onChange={(e) => set(sid, f, e.target.value)} /></label>)}
        </details>
      ))}
      <label className="block text-xs">Diagnostic impressions (entered by you)<textarea className={input} rows={3} maxLength={4000} value={data.impressions ?? ''} onChange={(e) => setData({ ...data, impressions: e.target.value })} /></label>
      <button className={btn} onClick={save}>Save interview</button>
    </div>
  )
}

function Licensed({ id }: { id: string }) {
  const [f, setF] = useState({ instrument: 'wais4', administered_on: '', administered_by: '', authorization_ref: '', comments: '', attest: false })
  const [rows, setRows] = useState([{ label: '', value: '', note: '' }])
  const save = async () => {
    try { await psychX.external(id, { ...f, scores: rows.filter((r) => r.label && r.value) }); toast.success('Result stored'); setRows([{ label: '', value: '', note: '' }]) } catch (e) { toast.error(errorMessage(e)) }
  }
  return (
    <div className="space-y-3 text-sm">
      <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900">Enter only results you obtained by administering the licensed test yourself. MediCare does not contain WAIS-IV, CAARS or PAI items, norms or scoring, and will not compute or interpret them. Results are stored separately from MediCare screening scores and from supplementary tasks.</p>
      <select className={input} value={f.instrument} onChange={(e) => setF({ ...f, instrument: e.target.value })}><option value="wais4">WAIS-IV</option><option value="caars">CAARS</option><option value="pai">PAI</option></select>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs">Date administered<input type="date" className={input} value={f.administered_on} onChange={(e) => setF({ ...f, administered_on: e.target.value })} /></label>
        <label className="text-xs">Administered by<input className={input} value={f.administered_by} onChange={(e) => setF({ ...f, administered_by: e.target.value })} /></label>
        <label className="text-xs sm:col-span-2">Licence / authorization reference<input className={input} value={f.authorization_ref} onChange={(e) => setF({ ...f, authorization_ref: e.target.value })} /></label>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-3 gap-2">
          <input className={input} placeholder="Score name" value={r.label} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
          <input className={input} placeholder="Value" value={r.value} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          <input className={input} placeholder="Note (optional)" value={r.note} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} />
        </div>
      ))}
      <button className={ghost} onClick={() => setRows([...rows, { label: '', value: '', note: '' }])}>+ Add score</button>
      <textarea className={input} rows={2} placeholder="Comments" value={f.comments} onChange={(e) => setF({ ...f, comments: e.target.value })} />
      <label className="flex gap-2 text-xs"><input type="checkbox" checked={f.attest} onChange={(e) => setF({ ...f, attest: e.target.checked })} />I administered this instrument under a valid licence and these values are from the official scoring.</label>
      <button className={btn} disabled={!f.attest} onClick={save}>Store result</button>
    </div>
  )
}

function Extras({ id }: { id: string }) {
  const [label, setLabel] = useState('')
  const [rel, setRel] = useState('')
  const [link, setLink] = useState<string | null>(null)
  const [d, setD] = useState<Dashboard | null>(null)
  const [form, setForm] = useState({ title: '', intro: '', options: 'Never\nSometimes\nOften', items: '' })
  const lines = (v: string) => v.split('\n').map((x) => x.trim()).filter(Boolean)
  const load = useCallback(() => psychX.dashboard(id).then(setD).catch(() => undefined), [id])
  useEffect(() => { load() }, [load])
  const invite = async () => {
    try { const r = await psychX.invite(id, label, rel); setLink(`${window.location.origin}/?observer=${r.token}`); setLabel(''); setRel(''); load() } catch (e) { toast.error(errorMessage(e)) }
  }
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); load() } catch (e) { toast.error(errorMessage(e)) } }
  return (
    <div className="space-y-4 text-sm">
      <section><h3 className="font-semibold">Invite an observer</h3>
        <p className="text-xs text-slate-500">Needs the patient&apos;s observer consent. The link works once, expires in 14 days and shows nothing about the patient.</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-3"><input className={input} placeholder="Observer name" value={label} onChange={(e) => setLabel(e.target.value)} /><input className={input} placeholder="Relationship" value={rel} onChange={(e) => setRel(e.target.value)} /><button className={btn} disabled={!label.trim()} onClick={invite}>Create link</button></div>
        {link && <p className="mt-2 break-all rounded-xl bg-teal-50 p-2 text-xs">Copy now — it will not be shown again: <b>{link}</b></p>}
        {d?.observers.map((o) => <div key={o.id} className="mt-2 flex items-center justify-between rounded-xl border p-2"><span>{o.label} — {o.status}</span>{o.status === 'pending' && <button className={ghost} onClick={() => run(() => psychX.revokeInvite(o.id))}>Revoke</button>}</div>)}
      </section>
      <section><h3 className="font-semibold">Build a questionnaire</h3>
        <p className="text-xs text-slate-500">Your own questions, one per line, with shared answer options. It is not a validated instrument, so MediCare never scores it. Do not copy copyrighted tests.</p>
        <input className={`${input} mt-2`} placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <input className={`${input} mt-2`} placeholder="Instructions for the patient (optional)" value={form.intro} onChange={(e) => setForm({ ...form, intro: e.target.value })} />
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="text-xs">Answer options (one per line, 2–7)<textarea className={input} rows={4} value={form.options} onChange={(e) => setForm({ ...form, options: e.target.value })} /></label>
          <label className="text-xs">Questions (one per line)<textarea className={input} rows={4} value={form.items} onChange={(e) => setForm({ ...form, items: e.target.value })} /></label>
        </div>
        <button className={`${btn} mt-2`} disabled={!form.title.trim() || lines(form.items).length < 1 || lines(form.options).length < 2} onClick={() => run(async () => { await psychX.createForm(id, { title: form.title, intro: form.intro, options: lines(form.options), items: lines(form.items) }); setForm({ ...form, title: '', items: '' }) })}>Assign questionnaire</button>
        {d?.forms.map((f) => <div key={f.id} className="mt-2 flex items-center justify-between rounded-xl border p-2"><span>{f.title} — {f.status}</span>{f.status === 'assigned' && <button className={btn} onClick={() => run(() => psychX.startForm(f.id))}>Start for patient</button>}</div>)}
      </section>
      <section><h3 className="font-semibold">Supplementary cognitive tasks</h3>
        <p className="text-xs text-slate-500">Built with jsPsych. Not IQ tests, not WAIS-IV subtests.</p>
        <div className="mt-2 flex flex-wrap gap-2"><button className={ghost} onClick={() => run(() => psychX.assignTask(id, 'reaction'))}>Assign reaction time</button><button className={ghost} onClick={() => run(() => psychX.assignTask(id, 'digitspan'))}>Assign digit span</button><button className={ghost} onClick={() => run(() => psychX.assignTask(id, 'stroop'))}>Assign Stroop</button><button className={ghost} onClick={() => run(() => psychX.assignTask(id, 'nback'))}>Assign 1-back</button></div>
        {d?.tasks.map((t) => <div key={t.id} className="mt-2 flex items-center justify-between rounded-xl border p-2"><span>{t.name} — {t.status}</span>{t.status === 'assigned' && <button className={btn} onClick={() => run(() => psychX.startTask(t.id))}>Start for patient</button>}</div>)}
      </section>
    </div>
  )
}

function ReportTab({ id }: { id: string }) {
  const [r, setR] = useState<Report | null>(null)
  const [sections, setSections] = useState<Record<string, string>>({})
  const [name, setName] = useState('')
  const [cred, setCred] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [gaps, setGaps] = useState(false)
  const load = useCallback(async () => { const x = await psychX.report(id); setR(x); setSections(x.sections ?? {}) }, [id])
  useEffect(() => { load().catch(() => undefined) }, [load])
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast.success(ok); await load() } catch (e) { toast.error(errorMessage(e)) } }
  if (!r) return <p className="text-sm text-slate-500">Loading…</p>
  const approved = r.status === 'approved'
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-slate-500">{r.draft_notice ?? 'The draft is assembled only from recorded data. It never diagnoses. You must review, edit and approve it.'}</p>
      {!approved && <button className={btn} onClick={() => act(() => psychX.generateReport(id), 'Draft generated from current data')}>{r.exists ? 'Regenerate draft (overwrites edits)' : 'Generate draft'}</button>}
      {r.exists && r.missing && r.missing.length > 0 && <div className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900"><b>Missing information:</b><ul className="list-disc pl-5">{r.missing.map((m, i) => <li key={i}>{m}</li>)}</ul></div>}
      {approved && r.order.map(([k, title]) => (
        <div key={k} className="break-inside-avoid"><h4 className="text-xs font-semibold">{title}</h4><p className="whitespace-pre-wrap">{sections[k]}</p></div>
      ))}
      {r.exists && !approved && r.order.map(([k, title]) => (
        <label key={k} className="block text-xs font-medium">{title}
          <textarea className={`${input} mt-1 font-normal`} rows={k === 'identification' || k === 'results' ? 6 : 3} value={sections[k] ?? ''} onChange={(e) => setSections({ ...sections, [k]: e.target.value })} />
        </label>
      ))}
      {r.exists && !approved && (
        <div className="space-y-2 rounded-xl border p-3">
          <button className={ghost} onClick={() => act(() => psychX.saveReport(id, sections), 'Edits saved')}>Save edits</button>
          <div className="grid gap-2 sm:grid-cols-2"><input className={input} placeholder="Your full name" value={name} onChange={(e) => setName(e.target.value)} /><input className={input} placeholder="Professional credentials / registration no." value={cred} onChange={(e) => setCred(e.target.value)} /></div>
          <label className="flex gap-2 text-xs"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />I have reviewed the whole report and take professional responsibility for it.</label>
          <label className="flex gap-2 text-xs"><input type="checkbox" checked={gaps} onChange={(e) => setGaps(e.target.checked)} />I accept any sections still marked [Not provided].</label>
          <button className={btn} disabled={!confirm || !name || !cred} onClick={() => act(async () => { await psychX.saveReport(id, sections); await psychX.approveReport(id, { name, credentials: cred, confirm, acknowledge_gaps: gaps }) }, 'Report approved')}>Approve report</button>
        </div>
      )}
      {approved && (<div className="space-y-2"><p className="rounded-xl bg-emerald-50 p-3 text-emerald-900">Approved by {r.approver_name}, {r.approver_credentials} · {fmt(r.approved_at ?? null)}</p>
        <button className={btn} onClick={() => window.print()}>Print / save as PDF</button></div>)}
    </div>
  )
}

export function ClinicianWorkspace({ state }: { state: ConsultationState }) {
  const [tab, setTab] = useState<Tab>('Dashboard')
  return (
    <section className="rounded-3xl bg-white p-5 shadow-sm print:shadow-none" aria-label="Psychologist-only workspace">
      <div className="print:hidden">
        <h2 className="font-semibold">Psychologist workspace</h2>
        <p className="text-xs text-slate-500">Private. The patient cannot see anything on these tabs.</p>
        <div role="tablist" className="mt-3 flex flex-wrap gap-2">
          {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded-lg border px-3 py-1.5 text-xs ${tab === t ? 'border-teal-700 bg-teal-50' : ''}`}>{t}</button>)}
        </div>
      </div>
      <div className="mt-4">
        {tab === 'Dashboard' && <Dash id={state.id} />}
        {tab === 'Clinical notes' && <Notes id={state.id} history={false} />}
        {tab === 'Patient history' && <Notes id={state.id} history />}
        {tab === 'Interview' && <Interview id={state.id} />}
        {tab === 'Licensed results' && <Licensed id={state.id} />}
        {tab === 'Observers & tasks' && <Extras id={state.id} />}
        {tab === 'Report' && <ReportTab id={state.id} />}
      </div>
    </section>
  )
}
