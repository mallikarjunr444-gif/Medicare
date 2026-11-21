'use client'

import { useEffect, useRef, useState } from 'react'
import { initJsPsych } from 'jspsych'
import 'jspsych/css/jspsych.css'
import HtmlKeyboardResponse from '@jspsych/plugin-html-keyboard-response'
import SurveyText from '@jspsych/plugin-survey-text'

type Trial = Record<string, unknown>

/**
 * Supplementary cognitive tasks built on jsPsych (MIT). They are NOT IQ tests and NOT WAIS-IV subtests.
 * Raw trials go to the server, which recomputes every summary figure itself.
 */
export function CognitiveTask({ task, onDone }: { task: 'reaction' | 'digitspan' | 'stroop' | 'nback'; onDone: (trials: Trial[]) => Promise<void> | void }) {
  const host = useRef<HTMLDivElement>(null)
  const doneRef = useRef(onDone)
  useEffect(() => { doneRef.current = onDone }, [onDone])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!host.current) return
    const el = host.current
    let closed = false
    const out: Trial[] = []
    const jsPsych = initJsPsych({
      display_element: el,
      on_finish: () => { if (closed) return; Promise.resolve(doneRef.current(out)).catch(() => setError('Could not save your results. Please tell your psychologist.')) },
    })
    const timeline: unknown[] = []

    if (task === 'reaction') {
      timeline.push({ type: HtmlKeyboardResponse, stimulus: '<p>Reaction task: a green circle will appear after a short wait. Press the <b>space bar</b> as fast as you can when you see it.</p><p>Press space to begin.</p>', choices: [' '] })
      for (let i = 0; i < 10; i++) {
        timeline.push({ type: HtmlKeyboardResponse, stimulus: '<div style="font-size:48px">+</div>', choices: 'NO_KEYS', trial_duration: () => 1200 + Math.floor(Math.random() * 2300) })
        timeline.push({
          type: HtmlKeyboardResponse,
          stimulus: '<div style="width:90px;height:90px;border-radius:50%;background:#16a34a;margin:auto"></div>',
          choices: [' '], trial_duration: 5000,
          on_finish: (d: { rt: number | null }) => { out.push({ rt_ms: d.rt ?? 5000 }) },
        })
      }
    } else if (task === 'stroop') {
      const COLORS = ['red', 'green', 'blue', 'yellow']
      const css: Record<string, string> = { red: '#dc2626', green: '#16a34a', blue: '#2563eb', yellow: '#ca8a04' }
      timeline.push({ type: HtmlKeyboardResponse, stimulus: '<p>Colour task: words appear in coloured ink. Press the key for the <b>ink colour</b>, not the word.</p><p><b>R</b> = red, <b>G</b> = green, <b>B</b> = blue, <b>Y</b> = yellow.</p><p>Press space to begin.</p>', choices: [' '] })
      const order = Array.from({ length: 24 }, (_, i) => i < 12).sort(() => Math.random() - 0.5) // 12 matching + 12 mismatching
      for (const same of order) {
        const color = COLORS[Math.floor(Math.random() * 4)]
        const word = same ? color : COLORS.filter((c) => c !== color)[Math.floor(Math.random() * 3)]
        timeline.push({ type: HtmlKeyboardResponse, stimulus: '<div style="font-size:48px">+</div>', choices: 'NO_KEYS', trial_duration: 500 })
        timeline.push({
          type: HtmlKeyboardResponse, stimulus: `<div style="font-size:56px;font-weight:700;color:${css[color]}">${word.toUpperCase()}</div>`,
          choices: ['r', 'g', 'b', 'y'], trial_duration: 4000,
          on_finish: (d: { rt: number | null; response: string | null }) => { out.push({ word, color, key: d.response ?? '', rt_ms: d.rt ?? 4000 }) },
        })
      }
    } else if (task === 'nback') {
      timeline.push({ type: HtmlKeyboardResponse, stimulus: '<p>Memory task: letters appear one at a time. Press the <b>space bar</b> whenever the letter is the <b>same as the one just before it</b>. Otherwise press nothing.</p><p>Press space to begin.</p>', choices: [' '] })
      let prev = ''
      for (let i = 0; i < 30; i++) {
        const letters = 'BCDFGHJKLM'
        const letter = i > 0 && Math.random() < 0.3 ? prev : letters[Math.floor(Math.random() * letters.length)]
        prev = letter
        timeline.push({
          type: HtmlKeyboardResponse, stimulus: `<div style="font-size:64px">${letter}</div>`, choices: [' '], response_ends_trial: false, trial_duration: 1500, post_trial_gap: 500,
          on_finish: (d: { response: string | null }) => { out.push({ letter, pressed: d.response !== null }) },
        })
      }
    } else {
      timeline.push({ type: HtmlKeyboardResponse, stimulus: '<p>Memory task: digits appear one at a time. After they disappear, type them in the same order.</p><p>Press space to begin.</p>', choices: [' '] })
      let fails = 0
      for (let len = 3; len <= 9; len++) {
        for (let rep = 0; rep < 2; rep++) {
          const digits = Array.from({ length: len }, () => String(Math.floor(Math.random() * 10))).join('')
          const state = { digits }
          for (const d of digits) timeline.push({ type: HtmlKeyboardResponse, stimulus: `<div style="font-size:64px">${d}</div>`, choices: 'NO_KEYS', trial_duration: 900, post_trial_gap: 250 })
          timeline.push({
            type: SurveyText, questions: [{ prompt: 'Type the digits you saw', required: true, columns: 20 }],
            on_finish: (d: { response: { Q0: string } }) => { const ok = d.response.Q0.replace(/\s+/g, '') === state.digits; out.push({ digits: state.digits, response: d.response.Q0 }); fails = ok ? 0 : fails + 1; if (fails >= 2) jsPsych.abortExperiment('Task finished. Thank you.') },
          })
        }
      }
    }
    timeline.push({ type: HtmlKeyboardResponse, stimulus: '<p>Finished. Thank you.</p>', choices: 'NO_KEYS', trial_duration: 1200 })
    // jsPsych's timeline typing is stricter than this builder; the node shapes above are valid plugin parameters.
    jsPsych.run(timeline as Parameters<typeof jsPsych.run>[0]).catch(() => setError('The task could not start.'))
    return () => { closed = true; try { jsPsych.abortExperiment('closed') } catch { /* already finished */ } }
  }, [task])

  return (
    <div className="rounded-2xl border p-4">
      <div ref={host} className="min-h-64 text-center" aria-live="polite" />
      {error && <p role="alert" className="mt-2 text-sm text-rose-700">{error}</p>}
      <p className="mt-2 text-[11px] text-slate-500">Supplementary task for your psychologist. It is not an IQ test and does not diagnose anything.</p>
    </div>
  )
}
