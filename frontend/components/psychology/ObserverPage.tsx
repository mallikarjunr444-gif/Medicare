'use client'

import { useEffect, useState } from 'react'
import { errorMessage, observerApi, type ObserverForm } from '@/lib/psychApi'

/** Public page for an invited observer. It shows nothing about the patient. */
export function ObserverPage({ token }: { token: string }) {
  const [form, setForm] = useState<ObserverForm | null>(null)
  const [answers, setAnswers] = useState<Record<string, number>>({})
  const [comment, setComment] = useState('')
  const [state, setState] = useState<'loading' | 'ready' | 'done' | 'invalid'>('loading')
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    observerApi.form(token).then((f) => { setForm(f); setState('ready') }).catch(() => setState('invalid'))
  }, [token])

  const complete = form ? form.items.every((_, i) => answers[String(i)] !== undefined) : false
  const submit = async () => {
    try { await observerApi.submit(token, answers, comment); setState('done') } catch (e) { setErr(errorMessage(e)) }
  }

  if (state === 'loading') return <main className="p-8 text-sm text-slate-500">Loading…</main>
  if (state === 'invalid') return <main className="mx-auto max-w-xl p-8"><h1 className="text-xl font-semibold">This link is not valid</h1><p className="mt-2 text-sm text-slate-600">It may have expired, been used already, or been withdrawn.</p></main>
  if (state === 'done') return <main className="mx-auto max-w-xl p-8"><h1 className="text-xl font-semibold">Thank you</h1><p className="mt-2 text-sm text-slate-600">Your responses were sent to the psychologist. You can close this page.</p></main>
  return (
    <main className="mx-auto max-w-xl p-4">
      <h1 className="text-xl font-semibold">{form!.title}</h1>
      <p className="mt-1 text-sm text-slate-600">Hello {form!.observer_label}. Please answer based only on what you have personally observed.</p>
      <p className="mt-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">{form!.notice}</p>
      {form!.items.map((q, i) => (
        <fieldset key={i} className="mt-4"><legend className="text-sm">{i + 1}. {q}</legend>
          <div className="mt-2 grid grid-cols-2 gap-2">{form!.options.map((o, v) => <label key={o} className={`cursor-pointer rounded-lg border p-2 text-xs ${answers[String(i)] === v ? 'border-teal-700 bg-teal-50' : ''}`}><input type="radio" className="mr-1" name={`q${i}`} checked={answers[String(i)] === v} onChange={() => setAnswers({ ...answers, [String(i)]: v })} />{o}</label>)}</div>
        </fieldset>
      ))}
      <label className="mt-4 block text-sm">Anything else you have observed (optional)<textarea className="mt-1 w-full rounded-xl border p-2 text-sm" rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} /></label>
      {err && <p role="alert" className="mt-2 text-sm text-rose-700">{err}</p>}
      <button disabled={!complete} onClick={submit} className="mt-4 w-full rounded-xl bg-teal-700 p-3 text-sm text-white disabled:opacity-40">Send responses</button>
      <p className="mt-3 text-[11px] text-slate-500">Your answers are shared only with the treating psychologist. If someone is in immediate danger, call 112.</p>
    </main>
  )
}
