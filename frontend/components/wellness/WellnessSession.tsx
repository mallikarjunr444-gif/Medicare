'use client'

import { useState } from 'react'
import { ArrowLeft, HeartHandshake, Phone } from 'lucide-react'
import { VisionDashboard } from './VisionDashboard'
import {
  CRISIS_RESOURCES, EMPTY_CHECKIN, PSS10, WHO5, checkInComplete, needsSafetySupport, scoreQuestionnaire,
  type Answers, type CheckIn, type Questionnaire,
} from '@/lib/wellness/instruments'
import type { VisionSummary } from '@/lib/vision/metrics'

type Step = 'consent' | 'checkin' | 'who5' | 'pss10' | 'summary'
const STEPS: Step[] = ['consent', 'checkin', 'who5', 'pss10', 'summary']
const LABEL: Record<Step, string> = { consent: 'Welcome', checkin: 'Check-in', who5: 'Well-being', pss10: 'Stress', summary: 'Summary' }

function SafetyPanel() {
  return (
    <div role="alert" className="rounded-2xl border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900">
      <div className="flex items-center gap-2 font-semibold"><HeartHandshake size={18} />You do not have to face this alone</div>
      <p className="mt-2">Thank you for telling us. If you are thinking about harming yourself or ending your life, please reach out to someone right now. A person can help you through this moment.</p>
      <ul className="mt-2 space-y-1">{CRISIS_RESOURCES.map((r) => <li key={r.contact} className="flex items-center gap-2"><Phone size={14} /><span>{r.name}:</span><a className="font-semibold underline" href={`tel:${r.contact}`}>{r.contact}</a></li>)}</ul>
      <p className="mt-2">If you can, tell a family member, friend or someone nearby how you feel. Dr. Ananya is an AI companion and cannot replace a person or emergency help.</p>
    </div>
  )
}

function Rating({ label, low, high, value, onChange }: { label: string; low: string; high: string; value: number | null; onChange: (n: number) => void }) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex items-center gap-2 text-xs text-slate-500"><span className="w-20">{low}</span>
        <div className="flex gap-2">{[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" aria-pressed={value === n} aria-label={`${label}: ${n} of 5`} onClick={() => onChange(n)} className={`h-9 w-9 rounded-full border text-sm ${value === n ? 'bg-teal-700 text-white' : 'bg-white'}`}>{n}</button>))}</div>
        <span className="w-20 text-right">{high}</span></div>
    </fieldset>
  )
}

function QuestionnaireStep({ q, answers, setAnswers, onNext }: { q: Questionnaire; answers: Answers; setAnswers: (a: Answers) => void; onNext: () => void }) {
  const done = answers.every((v) => v !== null)
  return (
    <div className="space-y-4">
      <div><h2 className="text-lg font-semibold">{q.title}</h2><p className="mt-1 text-sm text-slate-600">{q.intro}</p></div>
      {q.items.map((item, i) => (
        <fieldset key={i} className="rounded-2xl border p-3">
          <legend className="px-1 text-sm font-medium">{i + 1}. {q.period}, {item}</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {q.scale.map((s) => (
              <label key={s.value} className={`cursor-pointer rounded-full border px-3 py-1.5 text-xs ${answers[i] === s.value ? 'bg-teal-700 text-white' : 'bg-white'}`}>
                <input type="radio" className="sr-only" name={`${q.id}-${i}`} checked={answers[i] === s.value} onChange={() => setAnswers(answers.map((a, j) => (j === i ? s.value : a)))} />{s.label}</label>))}
          </div>
        </fieldset>))}
      <p className="text-xs text-slate-500">{q.attribution}</p>
      <button disabled={!done} onClick={onNext} className="rounded-xl bg-teal-700 px-4 py-2 text-sm text-white disabled:opacity-40">Continue</button>
      {!done && <p className="text-xs text-slate-500">Please answer every question to continue.</p>}
    </div>
  )
}

export function WellnessSession({ onExit }: { onExit: () => void }) {
  const [step, setStep] = useState<Step>('consent')
  const [agree, setAgree] = useState(false)
  const [checkIn, setCheckIn] = useState<CheckIn>(EMPTY_CHECKIN)
  const [who5, setWho5] = useState<Answers>(Array(WHO5.items.length).fill(null))
  const [pss10, setPss10] = useState<Answers>(Array(PSS10.items.length).fill(null))
  const [camera, setCamera] = useState<VisionSummary | null>(null)
  const safety = needsSafetySupport(checkIn)
  const next = (s: Step) => { setStep(s); if (typeof window !== 'undefined') window.scrollTo({ top: 0 }) }
  const restart = () => { setCheckIn(EMPTY_CHECKIN); setWho5(Array(WHO5.items.length).fill(null)); setPss10(Array(PSS10.items.length).fill(null)); setCamera(null); setAgree(false); next('consent') }
  const r5 = scoreQuestionnaire(WHO5, who5)
  const r10 = scoreQuestionnaire(PSS10, pss10)

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-4">
      <button onClick={onExit} className="inline-flex items-center gap-1 text-sm"><ArrowLeft size={16} />Back</button>
      <div>
        <h1 className="text-2xl font-semibold">Dr. Ananya — wellness session</h1>
        <p className="mt-1 text-sm text-slate-600">Dr. Ananya is an AI wellness companion, not a licensed psychologist, and cannot diagnose. The camera is optional and runs quietly in the background. It only records simple measurements, such as whether your face was in view, and never shows or infers emotion, honesty or mental health.</p>
      </div>
      <ol className="flex flex-wrap gap-2 text-xs" aria-label="Progress">{STEPS.map((s) => <li key={s} aria-current={s === step ? 'step' : undefined} className={`rounded-full px-3 py-1 ${s === step ? 'bg-teal-700 text-white' : 'bg-slate-100 text-slate-600'}`}>{LABEL[s]}</li>)}</ol>

      {safety && step !== 'consent' && <SafetyPanel />}

      <section className="rounded-3xl bg-white p-5 shadow-sm">
        {step === 'consent' && (
          <div className="space-y-3">
            <h2 className="text-lg font-semibold">Before we begin</h2>
            <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
              <li>This is a short, private self-reflection: a quick check-in and two well-known questionnaires (about 5 minutes).</li>
              <li>It is not a diagnosis, medical advice or a replacement for a psychologist or doctor.</li>
              <li>Your answers stay on this device and are not saved or sent anywhere. Closing or restarting the session clears them.</li>
              <li>You can skip the camera entirely, and you can leave at any time.</li>
              <li>If you are in danger or thinking of harming yourself, call 112 (India) or Tele-MANAS 14416 now.</li>
            </ul>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={agree} onChange={(e) => setAgree(e.target.checked)} />I understand and agree to take part.</label>
            <button disabled={!agree} onClick={() => next('checkin')} className="rounded-xl bg-teal-700 px-4 py-2 text-sm text-white disabled:opacity-40">Start</button>
          </div>)}

        {step === 'checkin' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">How are you today?</h2>
            <Rating label="Mood" low="Very low" high="Very good" value={checkIn.mood} onChange={(n) => setCheckIn({ ...checkIn, mood: n })} />
            <Rating label="Energy" low="Very low" high="High" value={checkIn.energy} onChange={(n) => setCheckIn({ ...checkIn, energy: n })} />
            <Rating label="Sleep last night" low="Very poor" high="Very good" value={checkIn.sleep} onChange={(n) => setCheckIn({ ...checkIn, sleep: n })} />
            <Rating label="Stress right now" low="Very low" high="Very high" value={checkIn.stress} onChange={(n) => setCheckIn({ ...checkIn, stress: n })} />
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Have you had thoughts of harming yourself or of not wanting to live?</legend>
              <div className="flex gap-2">{([['no', 'No'], ['yes', 'Yes'], ['skip', 'Prefer not to say']] as const).map(([v, t]) => (
                <button key={v} type="button" aria-pressed={checkIn.selfHarm === v} onClick={() => setCheckIn({ ...checkIn, selfHarm: v })} className={`rounded-full border px-3 py-1.5 text-xs ${checkIn.selfHarm === v ? 'bg-teal-700 text-white' : 'bg-white'}`}>{t}</button>))}</div>
            </fieldset>
            <label className="block text-sm">Anything you would like to add? (optional)
              <textarea value={checkIn.note} maxLength={500} onChange={(e) => setCheckIn({ ...checkIn, note: e.target.value })} className="mt-1 w-full rounded-xl border p-2 text-sm" rows={3} /></label>
            <button disabled={!checkInComplete(checkIn)} onClick={() => next('who5')} className="rounded-xl bg-teal-700 px-4 py-2 text-sm text-white disabled:opacity-40">Continue</button>
          </div>)}

        {step === 'who5' && <QuestionnaireStep q={WHO5} answers={who5} setAnswers={setWho5} onNext={() => next('pss10')} />}
        {step === 'pss10' && <QuestionnaireStep q={PSS10} answers={pss10} setAnswers={setPss10} onNext={() => next('summary')} />}

        {step === 'summary' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Your summary</h2>
            <p className="text-sm text-slate-600">This is a snapshot of how you described yourself today. It is not a diagnosis.</p>
            <div className="rounded-2xl border p-3 text-sm"><h3 className="font-semibold">Check-in</h3>
              <p className="mt-1 text-slate-700">Mood {checkIn.mood}/5 · Energy {checkIn.energy}/5 · Sleep {checkIn.sleep}/5 · Stress {checkIn.stress}/5</p></div>
            {r5 && <div className="rounded-2xl border p-3 text-sm"><h3 className="font-semibold">{WHO5.title}</h3>
              <p className="mt-1">Score {r5.percent}/100 — {r5.band}</p><p className="mt-1 text-slate-600">{r5.note}</p></div>}
            {r10 && <div className="rounded-2xl border p-3 text-sm"><h3 className="font-semibold">{PSS10.title}</h3>
              <p className="mt-1">Score {r10.raw}/{r10.max} — {r10.band}</p><p className="mt-1 text-slate-600">{r10.note}</p></div>}
            {camera && <p className="text-xs text-slate-500">Camera observations were collected on this device and are not shown or saved.</p>}
            <p className="text-sm text-slate-700">If these results worry you, or you have felt this way for a while, please consider talking with a doctor, counsellor or someone you trust.</p>
            <div className="flex gap-2">
              <button onClick={() => window.print()} className="rounded-xl border px-4 py-2 text-sm">Print or save as PDF</button>
              <button onClick={restart} className="rounded-xl border px-4 py-2 text-sm">Clear and start over</button>
            </div>
          </div>)}
      </section>

      {step !== 'consent' && <VisionDashboard onResult={(d) => setCamera(d)} />}
      <p className="text-xs text-slate-500">If you are in immediate danger or thinking about harming yourself, call 112 (India) or Tele-MANAS 14416 now.</p>
    </main>
  )
}
