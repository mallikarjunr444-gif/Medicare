/** Self-service wellness questionnaires. Pure logic, no DOM. Results are descriptive, never diagnostic. */

export type Scale = { value: number; label: string }
export type Questionnaire = {
  id: 'who5' | 'pss10'
  title: string
  period: string
  intro: string
  attribution: string
  scale: Scale[]
  items: string[]
  reverse: number[] // zero-based item indexes that are reverse scored
}

export const WHO5: Questionnaire = {
  id: 'who5',
  title: 'WHO-5 Well-Being Index',
  period: 'Over the last two weeks',
  intro: 'Please say how you have been feeling over the last two weeks.',
  attribution: 'WHO-5 Well-Being Index © World Health Organization, Psychiatric Research Unit, Frederiksborg General Hospital. Used here as a self-reflection tool, not a diagnosis.',
  scale: [
    { value: 5, label: 'All of the time' }, { value: 4, label: 'Most of the time' }, { value: 3, label: 'More than half of the time' },
    { value: 2, label: 'Less than half of the time' }, { value: 1, label: 'Some of the time' }, { value: 0, label: 'At no time' },
  ],
  items: [
    'I have felt cheerful and in good spirits',
    'I have felt calm and relaxed',
    'I have felt active and vigorous',
    'I woke up feeling fresh and rested',
    'My daily life has been filled with things that interest me',
  ],
  reverse: [],
}

export const PSS10: Questionnaire = {
  id: 'pss10',
  title: 'Perceived Stress Scale (PSS-10)',
  period: 'In the last month',
  intro: 'These questions ask about your feelings and thoughts during the last month. For each one, choose how often you felt or thought that way.',
  attribution: 'Perceived Stress Scale (PSS-10) by Cohen, Kamarck & Mermelstein (1983). Shown for personal reflection only. It is not a diagnosis.',
  scale: [
    { value: 0, label: 'Never' }, { value: 1, label: 'Almost never' }, { value: 2, label: 'Sometimes' },
    { value: 3, label: 'Fairly often' }, { value: 4, label: 'Very often' },
  ],
  items: [
    'how often have you been upset because of something that happened unexpectedly?',
    'how often have you felt that you were unable to control the important things in your life?',
    'how often have you felt nervous and "stressed"?',
    'how often have you felt confident about your ability to handle your personal problems?',
    'how often have you felt that things were going your way?',
    'how often have you found that you could not cope with all the things that you had to do?',
    'how often have you been able to control irritations in your life?',
    'how often have you felt that you were on top of things?',
    'how often have you been angered because of things that were outside of your control?',
    'how often have you felt difficulties were piling up so high that you could not overcome them?',
  ],
  reverse: [3, 4, 6, 7],
}

export type Answers = (number | null)[]
export type Result = { raw: number; max: number; percent: number | null; band: string; note: string }

export function isComplete(q: Questionnaire, a: Answers): boolean {
  return a.length === q.items.length && a.every((v) => v !== null && q.scale.some((s) => s.value === v))
}

/** Returns null unless every item is answered with a valid value. */
export function scoreQuestionnaire(q: Questionnaire, a: Answers): Result | null {
  if (!isComplete(q, a)) return null
  if (q.id === 'who5') {
    const raw = (a as number[]).reduce((s, v) => s + v, 0)
    const percent = raw * 4
    const low = percent < 50
    return {
      raw, max: 25, percent,
      band: low ? 'Lower than usual well-being' : 'Within the usual range',
      note: low
        ? 'A score under 50 is a common prompt to talk with a doctor or counsellor about how you have been feeling. It does not mean something is wrong with you.'
        : 'This suggests your well-being over the last two weeks has been in the usual range. It is a snapshot, not a verdict.',
    }
  }
  const raw = (a as number[]).reduce((s, v, i) => s + (q.reverse.includes(i) ? 4 - v : v), 0)
  const band = raw <= 13 ? 'Lower perceived stress' : raw <= 26 ? 'Moderate perceived stress' : 'Higher perceived stress'
  return {
    raw, max: 40, percent: null, band,
    note: raw >= 27
      ? 'You described feeling a lot of stress this month. Consider talking with someone you trust or a counsellor. These bands are rough guides, not a diagnosis.'
      : 'These bands are rough guides about how stressed you felt this month, not a diagnosis.',
  }
}

export type CheckIn = {
  mood: number | null // 1 (very low) .. 5 (very good)
  energy: number | null
  sleep: number | null // 1 (very poor) .. 5 (very good)
  stress: number | null // 1 (very low) .. 5 (very high)
  selfHarm: 'yes' | 'no' | 'skip' | null
  note: string
}
export const EMPTY_CHECKIN: CheckIn = { mood: null, energy: null, sleep: null, stress: null, selfHarm: null, note: '' }

export function checkInComplete(c: CheckIn): boolean {
  return [c.mood, c.energy, c.sleep, c.stress].every((v) => v !== null && v >= 1 && v <= 5) && c.selfHarm !== null
}

const CRISIS_WORDS = /\b(suicide|suicidal|kill myself|end my life|want to die|don'?t want to live|hurt myself|harm myself|self[- ]?harm)\b/i
/** True if the person said yes to the direct question or their note contains clear crisis wording. */
export function needsSafetySupport(c: CheckIn): boolean {
  return c.selfHarm === 'yes' || CRISIS_WORDS.test(c.note)
}

export const CRISIS_RESOURCES = [
  { name: 'Emergency services (India)', contact: '112' },
  { name: 'Tele-MANAS (government mental health helpline, 24/7)', contact: '14416' },
]
