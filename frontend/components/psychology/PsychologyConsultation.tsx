'use client'

import { useState } from 'react'
import { Check, ClipboardList, ShieldCheck, UserRound } from 'lucide-react'

const catalog = [
  ['GAD-7', 'Anxiety symptom screening', 'gad7'],
  ['PHQ-9', 'Depression symptom screening', 'phq9'],
  ['ASRS-v1.1 Screener', 'Adult ADHD screening · 6 items', 'asrs6'],
  ['WAIS-IV', 'Authorized administration and results only', 'restricted'],
  ['CAARS', 'Authorized form and scoring required', 'restricted'],
  ['PAI', 'Authorized results entry only', 'restricted'],
  ['Structured clinical interview', 'Psychologist-led clinical documentation', 'restricted'],
] as const
const questions: Record<string, string[]> = {
  gad7: ['Feeling nervous, anxious, or on edge', 'Not being able to stop or control worrying', 'Worrying too much about different things', 'Trouble relaxing', 'Being so restless that it is hard to sit still', 'Becoming easily annoyed or irritable', 'Feeling afraid as if something awful might happen'],
  phq9: ['Little interest or pleasure in doing things', 'Feeling down, depressed, or hopeless', 'Trouble falling or staying asleep, or sleeping too much', 'Feeling tired or having little energy', 'Poor appetite or overeating', 'Feeling bad about yourself', 'Trouble concentrating on things', 'Moving or speaking slowly, or being unusually restless', 'Thoughts that you would be better off dead, or of hurting yourself'],
  asrs6: ['Trouble wrapping up the final details of a project', 'Difficulty getting things in order', 'Problems remembering appointments or obligations', 'Avoiding or delaying tasks requiring thought', 'Fidgeting when sitting for a long time', 'Feeling overly active or compelled to do things'],
}
const options = ['Not at all', 'Several days', 'More than half the days', 'Nearly every day']

export function PsychologyConsultation({ onExit }: { onExit: () => void }) {
  const [assigned, setAssigned] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<number, number>>({})
  const [saved, setSaved] = useState<Record<string, number[]>>({})
  const [consents, setConsents] = useState({ online: false, assessment: false, data: false })
  const [dob, setDob] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const age = dob ? Math.max(0, new Date().getFullYear() - new Date(dob).getFullYear() - (new Date() < new Date(new Date(dob).setFullYear(new Date().getFullYear()) ) ? 1 : 0)) : ''
  const total = active ? Object.values(answers).reduce((a, b) => a + b, 0) : 0
  const complete = active ? answers[0] !== undefined && Object.keys(answers).length === questions[active]?.length : false
  const submit = () => {
    if (!active || !complete) return
    setSaved({ ...saved, [active]: Object.values(answers) })
    setSubmitted(true)
    setActive(null)
    setAnswers({})
  }
  return <div className="min-h-screen bg-[#f4f7f6] text-slate-800">
    <header className="flex h-16 items-center justify-between border-b bg-white px-5"><div><p className="text-xs font-semibold uppercase tracking-widest text-teal-700">MediCare · Dr. Annya</p><h1 className="text-lg font-semibold">Psychology consultation</h1></div><button onClick={onExit} className="rounded-xl border px-4 py-2 text-sm">Exit session</button></header>
    <main className="grid min-h-[calc(100vh-4rem)] gap-4 p-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(360px,0.8fr)]">
      <section className="flex min-h-[520px] flex-col overflow-hidden rounded-3xl bg-[#123e39] p-4 text-white shadow-sm"><div className="flex items-center justify-between"><div><h2 className="font-semibold">Video consultation</h2><p className="text-xs text-emerald-100">Secure room · Waiting for connection</p></div><span className="rounded-full bg-white/10 px-3 py-1 text-xs">● Not connected</span></div><div className="relative my-4 flex flex-1 items-center justify-center rounded-2xl bg-gradient-to-br from-[#245b52] to-[#102e2b]"><div className="text-center"><div className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-white/10"><UserRound size={36}/></div><p className="mt-3 font-medium">Psychologist video</p><p className="text-sm text-emerald-100">Video service is not configured</p></div><div className="absolute bottom-4 right-4 rounded-xl border border-white/10 bg-black/20 p-4 text-center"><div className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-white/10"><UserRound size={20}/></div><p className="mt-2 text-xs">Patient</p></div></div><div className="flex items-center justify-center gap-3"><button className="rounded-full bg-white/10 px-4 py-3 text-sm">Mic</button><button className="rounded-full bg-white/10 px-4 py-3 text-sm">Camera</button><button className="rounded-full bg-rose-600 px-5 py-3 text-sm" onClick={onExit}>End call</button></div><p className="mt-3 text-center text-xs text-emerald-100">Recording is off. Video/audio requires configured LiveKit service.</p></section>
      <section className="max-h-[calc(100vh-6rem)] space-y-4 overflow-y-auto rounded-3xl bg-white p-5 shadow-sm">
        <div><div className="flex items-center gap-2"><UserRound size={18} className="text-teal-700"/><h2 className="font-semibold">Patient information</h2></div><p className="mt-1 text-xs text-slate-500">Only information needed for this consultation.</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs">Full legal name<input className="mt-1 w-full rounded-xl border p-3 text-sm" placeholder="Name"/></label><label className="text-xs">Preferred name<input className="mt-1 w-full rounded-xl border p-3 text-sm" placeholder="Optional"/></label><label className="text-xs">Date of birth<input type="date" value={dob} onChange={e=>setDob(e.target.value)} className="mt-1 w-full rounded-xl border p-3 text-sm"/></label><label className="text-xs">Age (calculated)<input readOnly value={age} className="mt-1 w-full rounded-xl border bg-slate-50 p-3 text-sm"/></label><label className="text-xs">Contact information<input className="mt-1 w-full rounded-xl border p-3 text-sm" placeholder="Optional"/></label><label className="text-xs">Preferred language<input className="mt-1 w-full rounded-xl border p-3 text-sm" placeholder="Language"/></label><label className="text-xs sm:col-span-2">Occupation or education<input className="mt-1 w-full rounded-xl border p-3 text-sm" placeholder="Optional"/></label></div></div>
        <div className="rounded-2xl bg-teal-50 p-4"><div className="flex items-center gap-2"><ShieldCheck size={18} className="text-teal-700"/><h3 className="font-semibold">Consent</h3></div>{[['online','Online psychological consultation'],['assessment','Psychological assessment'],['data','Processing and storage of assessment information']].map(([key,label])=><label key={key} className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={consents[key as keyof typeof consents]} onChange={e=>setConsents({...consents,[key]:e.target.checked})}/>{label}</label>)}<p className="mt-2 text-xs text-slate-500">Recording is disabled. Optional recording requires separate consent.</p></div>
        <div><div className="flex items-center gap-2"><ClipboardList size={18} className="text-teal-700"/><h2 className="font-semibold">Assigned assessments</h2></div><p className="mt-1 text-xs text-slate-500">Only assigned assessments are available to the patient.</p><div className="mt-3 space-y-2">{assigned.map(id=>{const [name,detail]=catalog.find(a=>a[2]===id)!;return <div key={id} className="flex items-center justify-between rounded-xl border p-3"><div><p className="text-sm font-medium">{name}</p><p className="text-xs text-slate-500">{detail} · {saved[id]?.length?'Completed':'Assigned'}</p></div>{questions[id]&&<button onClick={()=>{setActive(id);setAnswers({});setSubmitted(false)}} className="rounded-lg bg-teal-700 px-3 py-2 text-xs text-white">{saved[id]?.length?'Review':'Start'}</button>}</div>})}{!assigned.length&&<p className="rounded-xl border border-dashed p-4 text-sm text-slate-500">No assessments assigned yet.</p>}</div></div>
        {active&&questions[active]&&<div className="rounded-2xl border p-4"><h3 className="font-semibold">{catalog.find(a=>a[2]===active)?.[0]}</h3><p className="text-xs text-slate-500">Over the last 2 weeks, how often have you been bothered by the following?</p>{questions[active].map((q,i)=><fieldset key={q} className="mt-4"><legend className="text-sm">{i+1}. {q}</legend><div className="mt-2 grid grid-cols-2 gap-2">{options.map((option,value)=><label key={option} className={`rounded-lg border p-2 text-xs ${answers[i]===value?'border-teal-700 bg-teal-50':''}`}><input type="radio" className="mr-1" name={`q${i}`} checked={answers[i]===value} onChange={()=>setAnswers({...answers,[i]:value})}/>{option}</label>)}</div></fieldset>)}{active==='phq9'&&answers[8]>0&&<div role="alert" className="mt-4 rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800">Please tell your psychologist now so they can follow up directly. This questionnaire is not a suicide-risk assessment.</div>}<button disabled={!complete} onClick={submit} className="mt-4 w-full rounded-xl bg-teal-700 p-3 text-sm font-medium text-white disabled:opacity-40">Submit responses</button></div>}
        {submitted&&<p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800"><Check size={16} className="mr-2 inline"/>Response recorded for this session.</p>}
        <details className="rounded-2xl border p-4"><summary className="cursor-pointer text-sm font-semibold">Psychologist · assign assessment</summary><p className="mt-2 text-xs text-slate-500">Professional authorization and a secure clinical backend are required before clinical use.</p>{catalog.map(([name,detail,id])=><label key={id} className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={assigned.includes(id)} onChange={e=>setAssigned(e.target.checked?[...assigned,id]:assigned.filter(x=>x!==id))}/><span>{name}<span className="block text-xs text-slate-500">{detail}</span></span></label>)}</details>
        <p className="text-xs leading-relaxed text-slate-500">Screening results are not diagnoses. WAIS-IV, CAARS, and PAI content/scoring are not included; use only authorized materials. This prototype does not persist to a secure server or enforce clinical roles.</p>
      </section>
    </main>
  </div>
}
