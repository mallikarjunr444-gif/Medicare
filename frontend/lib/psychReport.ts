/**
 * Psychologist-style session report for Dr. Ananya (AI mental wellness consultation).
 *
 * Built deterministically from what the client actually said, so nothing can be invented and it appears instantly
 * (no extra model call). It follows the structure a psychologist's session note uses, but it is NOT a diagnosis:
 * every finding quotes the client's own words, and anything not discussed is listed as "not explored".
 */

export interface PsychDomain {
  key: string
  label: string
  /** True when the client mentioned this area. */
  reported: boolean
  /** Up to two short quotes of the client's own words. */
  evidence: string[]
}

export type PsychRisk = 'none_stated' | 'concern_stated'

export interface PsychReport {
  presentingConcern: string
  clientWords: string[]
  onsetAndDuration: string
  domains: PsychDomain[]
  strengths: string[]
  risk: { level: PsychRisk; note: string }
  impression: string
  plan: string[]
  notExplored: string[]
  limitations: string
}

const DOMAIN_DEFS: { key: string; label: string; re: RegExp }[] = [
  { key: 'mood', label: 'Mood', re: /\b(sad|low|down|depress\w*|hopeless|empty|numb|cry\w*|worthless|unhappy|miserable|no interest|lost interest)\b/i },
  { key: 'anxiety', label: 'Anxiety and worry', re: /\b(anxi\w*|worr\w*|panic|nervous|fear\w*|scared|afraid|tense|restless|overthink\w*|on edge)\b/i },
  { key: 'stress', label: 'Stress and pressure', re: /\b(stress\w*|pressure|overwhelm\w*|deadline\w*|exam\w*|work|job|burn\w*out|workload|study|studies|college|boss|money|debt)\b/i },
  { key: 'sleep', label: 'Sleep', re: /\b(sleep\w*|insomnia|nightmare\w*|wake up|waking|can'?t sleep|tired in the morning)\b/i },
  { key: 'appetite', label: 'Appetite and eating', re: /\b(appetite|eating|not eating|overeat\w*|skip\w* meals?|lost weight|gained weight)\b/i },
  { key: 'energy', label: 'Energy and motivation', re: /\b(tired|fatigue\w*|exhaust\w*|no energy|low energy|unmotivated|motivation|lazy|drained)\b/i },
  { key: 'concentration', label: 'Concentration', re: /\b(concentrat\w*|focus\w*|distract\w*|forget\w*|can'?t think|mind goes blank|memory)\b/i },
  { key: 'relationships', label: 'Relationships and social life', re: /\b(lonel\w*|alone|isolated|relationship\w*|breakup|break up|divorce|argu\w*|fight\w*|conflict\w*|no friends|family (problems?|pressure|issues?)|parents? (are|pressure)|toxic)\b/i },
]

const STRENGTH_RE: { re: RegExp; text: string }[] = [
  { re: /\b(talk(ed|ing)? to (my )?(friend|family|mother|father|mom|dad|sister|brother|someone)|support from)\b/i, text: 'Has people to talk to' },
  { re: /\b(walk\w*|exercise|gym|yoga|run(ning)?|sports?|swim\w*)\b/i, text: 'Uses physical activity' },
  { re: /\b(music|reading|read books?|paint\w*|draw\w*|hobb(y|ies)|garden\w*|cook\w*)\b/i, text: 'Has enjoyable activities' },
  { re: /\b(meditat\w*|breathing|mindful\w*|pray\w*|journal\w*)\b/i, text: 'Uses calming practices' },
  { re: /\b(therap\w*|counsel\w*|seeking help|want to get better|want help)\b/i, text: 'Is open to seeking help' },
]

const RISK_RE = /\b(suicid\w*|kill myself|end my life|want to die|self[- ]harm|hurt myself|cut myself|no reason to live|better off dead|end it all)\b/i
const DURATION_RE = /\b(\d+\s*(day|days|week|weeks|month|months|year|years)|since [a-z0-9 ]{3,24}|for (a |the )?(few|couple of|last|past) [a-z]+|long time)\b/i

const clip = (t: string, n = 140) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t)

export function buildPsychReport(input: {
  clientStatements: string[]
  triageLevel: number
  recordedDuration?: string
}): PsychReport {
  const statements = input.clientStatements.map((s) => s.trim()).filter(Boolean)
  const all = statements.join(' \n ')

  const domains: PsychDomain[] = DOMAIN_DEFS.map((d) => {
    const hits = statements.filter((s) => d.re.test(s))
    return { key: d.key, label: d.label, reported: hits.length > 0, evidence: hits.slice(0, 2).map((s) => clip(s)) }
  })
  const reported = domains.filter((d) => d.reported)
  const notDiscussed = domains.filter((d) => !d.reported)

  const riskStated = RISK_RE.test(all) || input.triageLevel >= 4
  const risk = riskStated
    ? {
        level: 'concern_stated' as const,
        note:
          'The client expressed thoughts or words that may indicate risk to their safety. This needs follow-up by a qualified professional today. ' +
          'Emergency services: 112. KIRAN Mental Health Helpline: 1800-599-0019 (24x7, toll-free). A trusted person should stay with the client.',
      }
    : {
        level: 'none_stated' as const,
        note:
          'No thoughts of self-harm or suicide were stated in this session. This is not a formal risk assessment: the client was not screened with a structured tool, so risk cannot be ruled out.',
      }

  const duration = DURATION_RE.exec(all)?.[0]
  const onsetAndDuration = input.recordedDuration && input.recordedDuration !== 'Not mentioned'
    ? input.recordedDuration
    : duration
      ? `The client mentioned: "${duration}".`
      : 'Onset and duration were not discussed.'

  const strengths = STRENGTH_RE.filter((s) => s.re.test(all)).map((s) => s.text)

  const impression = statements.length === 0
    ? 'There was not enough conversation to form any impression.'
    : reported.length === 0
      ? 'The client shared general thoughts but did not describe specific emotional, sleep, stress or relationship difficulties. No themes of concern can be identified from this session.'
      : `The client described difficulties related to ${listJoin(reported.map((d) => d.label.toLowerCase()))}. ` +
        'These are themes drawn from the client’s own words, not a diagnosis. ' +
        (reported.length >= 3
          ? 'Several areas of daily life are affected, which makes an in-person assessment with a licensed psychologist worthwhile.'
          : 'A structured assessment would help to understand how much these affect daily life.')

  const plan: string[] = []
  if (riskStated) plan.push('Contact a qualified mental-health professional or emergency services today (112 / KIRAN 1800-599-0019), and do not stay alone.')
  if (reported.length > 0) plan.push('Book a consultation with a licensed psychologist for a structured assessment (for example the PHQ-9 and GAD-7 questionnaires in MediCare’s psychologist consultation).')
  if (domains.find((d) => d.key === 'sleep')?.reported) plan.push('Keep a regular sleep and wake time, avoid screens and caffeine late in the evening, and note sleep patterns for the next session.')
  if (domains.find((d) => d.key === 'anxiety' || d.key === 'stress')?.reported) plan.push('Try slow breathing (inhale 4 seconds, exhale 6 seconds, for 5 minutes) and write down worries with the situation, the thought and the feeling.')
  if (domains.find((d) => d.key === 'relationships')?.reported) plan.push('Talk with one trusted person about how you are feeling this week.')
  plan.push('Return to Dr. Ananya any time to continue the conversation. Seek urgent help if you feel unsafe or things get worse.')

  const notExplored = [
    ...notDiscussed.map((d) => `${d.label}: not discussed`),
    'Past mental-health history and treatment',
    'Medication, alcohol or substance use',
    'Medical conditions that can affect mood',
    'Family history',
    'Work, study or daily functioning in detail',
  ]

  return {
    presentingConcern: statements[0] ? clip(statements[0], 220) : 'No concern was recorded in this consultation.',
    clientWords: statements.slice(0, 6).map((s) => clip(s)),
    onsetAndDuration,
    domains,
    strengths,
    risk,
    impression,
    plan,
    notExplored,
    limitations:
      'Dr. Ananya is an AI mental-wellness assistant, not a licensed psychologist or psychiatrist. This report does not contain a diagnosis, a risk clearance or a treatment prescription. ' +
      'It reflects only what the client said in one conversation and has not been reviewed by a clinician. In an emergency call 112.',
  }
}

function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

export function psychReportText(r: PsychReport): string {
  const line = '-'.repeat(53)
  return [
    'PSYCHOLOGICAL CONSULTATION REPORT (AI-ASSISTED)',
    line,
    'PRESENTING CONCERN', r.presentingConcern, '',
    'CLIENT’S OWN WORDS', ...r.clientWords.map((w) => `• "${w}"`), '',
    'ONSET AND DURATION', r.onsetAndDuration, '',
    'AREAS REVIEWED',
    ...r.domains.map((d) => `• ${d.label}: ${d.reported ? 'reported' : 'not discussed'}${d.evidence.length ? ` ("${d.evidence.join('"; "')}")` : ''}`), '',
    'STRENGTHS AND COPING', ...(r.strengths.length ? r.strengths.map((s) => `• ${s}`) : ['• None mentioned']), '',
    'RISK SCREENING', r.risk.note, '',
    'IMPRESSION (NOT A DIAGNOSIS)', r.impression, '',
    'RECOMMENDATIONS', ...r.plan.map((p, i) => `${i + 1}. ${p}`), '',
    'NOT YET EXPLORED', ...r.notExplored.map((n) => `• ${n}`), '',
    'LIMITATIONS', r.limitations,
  ].join('\n')
}
