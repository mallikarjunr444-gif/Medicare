// Content definitions for stages 7-15: observer form, supplementary cognitive tasks, clinical interview, report.

export const OBSERVER_FORM = {
  title: "Observer questionnaire",
  notice: "This is an informal observer form. It is NOT a validated rating scale and produces no score. It only records what you have personally observed.",
  options: ["Never", "Sometimes", "Often", "Very often"],
  items: [
    "Has trouble keeping attention on tasks or conversations",
    "Loses or misplaces things needed for daily activities",
    "Has trouble organising tasks or managing time",
    "Appears restless or finds it hard to sit still",
    "Seems anxious or worried",
    "Seems low in mood or withdrawn",
    "Has difficulty with sleep or tiredness during the day",
    "Daily responsibilities (work, study, home) are affected",
  ],
};

export const TASKS = {
  reaction: { id: "reaction", name: "Simple reaction time", trials: 10, purpose: "Supplementary attention/response-speed task. Not an IQ or diagnostic measure." },
  stroop: { id: "stroop", name: "Colour-word (Stroop) task", trials: 24, purpose: "Supplementary attention/inhibition task. Not a diagnostic measure." },
  nback: { id: "nback", name: "1-back memory task", trials: 30, purpose: "Supplementary working-memory task. Not a diagnostic or IQ measure." },
  digitspan: { id: "digitspan", name: "Digit span (forward)", maxLen: 9, purpose: "Supplementary short-term memory task. Not a WAIS-IV subtest and not an IQ measure." },
} as const;
export type TaskId = keyof typeof TASKS;
export const isTaskId = (x: unknown): x is TaskId => typeof x === "string" && x in TASKS;

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

/** Recomputes every summary figure from raw trials server-side; the client's own numbers are never trusted. */
export function summariseTask(task: TaskId, raw: unknown): Record<string, unknown> | string {
  const r = raw as { trials?: unknown };
  if (!r || !Array.isArray(r.trials)) return "trials must be an array";
  if (task === "reaction") {
    if (r.trials.length !== TASKS.reaction.trials) return `expected ${TASKS.reaction.trials} trials`;
    const rts: number[] = []; let anticipations = 0, lapses = 0;
    for (const t of r.trials as any[]) {
      const ms = Number(t?.rt_ms);
      if (!Number.isFinite(ms) || ms < 0 || ms > 60000) return "invalid reaction time";
      if (ms < 100) anticipations++; else { rts.push(ms); if (ms > 500 * 2) lapses++; }
    }
    if (!rts.length) return "no valid trials";
    return { valid_trials: rts.length, median_rt_ms: median(rts), mean_rt_ms: Math.round(rts.reduce((a, b) => a + b, 0) / rts.length), anticipations, lapses_over_1s: lapses };
  }
  if (task === "stroop") {
    if (r.trials.length !== TASKS.stroop.trials) return `expected ${TASKS.stroop.trials} trials`;
    const COLORS = ["red", "green", "blue", "yellow"];
    const con: number[] = [], inc: number[] = []; let errors = 0;
    for (const t of r.trials as any[]) {
      const ms = Number(t?.rt_ms), word = String(t?.word), color = String(t?.color), key = String(t?.key ?? "").toLowerCase();
      if (!COLORS.includes(word) || !COLORS.includes(color) || key.length > 1 || !Number.isFinite(ms) || ms < 0 || ms > 60000) return "invalid Stroop trial";
      if (key !== color[0]) { errors++; continue; } // correctness is decided here: the key must be the first letter of the INK colour
      (word === color ? con : inc).push(ms);
    }
    if (!con.length || !inc.length) return "not enough correct trials";
    return { trials: 24, errors, accuracy_pct: Math.round(((24 - errors) / 24) * 100), congruent_median_ms: median(con), incongruent_median_ms: median(inc), interference_ms: median(inc) - median(con) };
  }
  if (task === "nback") {
    if (r.trials.length !== TASKS.nback.trials) return `expected ${TASKS.nback.trials} trials`;
    let hits = 0, misses = 0, falseAlarms = 0, correctRejections = 0; let prev = "";
    for (const t of r.trials as any[]) {
      const letter = String(t?.letter ?? "");
      if (!/^[A-Z]$/.test(letter) || typeof t?.pressed !== "boolean") return "invalid n-back trial";
      const target = letter === prev; // target status comes from the sequence itself, not from the client
      if (target && t.pressed) hits++; else if (target) misses++; else if (t.pressed) falseAlarms++; else correctRejections++;
      prev = letter;
    }
    const targets = hits + misses;
    return { trials: 30, targets, hits, misses, false_alarms: falseAlarms, correct_rejections: correctRejections, hit_rate_pct: targets ? Math.round((hits / targets) * 100) : null };
  }
  if (r.trials.length < 1 || r.trials.length > 20) return "invalid number of trials";
  let longest = 0; let correct = 0;
  for (const t of r.trials as any[]) {
    const digits = String(t?.digits ?? ""), response = String(t?.response ?? "").replace(/\s+/g, "");
    if (!/^\d{2,9}$/.test(digits) || response.length > 20) return "invalid digit-span trial";
    if (response === digits) { correct++; longest = Math.max(longest, digits.length); } // correctness is decided here, not by the client
  }
  return { trials: r.trials.length, correct_trials: correct, longest_span: longest };
}

export const INTERVIEW_SECTIONS = [
  { id: "presenting", title: "Presenting symptoms", prompt: "Main concerns in the patient's words and as observed" },
  { id: "history", title: "Relevant history", prompt: "Personal, developmental, medical, psychiatric and family history" },
  { id: "functioning", title: "Functional impairment", prompt: "Work/study, relationships, self-care, daily living" },
  { id: "risk", title: "Risk and safety", prompt: "Self-harm, harm to others, protective factors" },
  { id: "criteria", title: "Diagnostic criteria review", prompt: "Criteria considered, supporting and contradicting evidence" },
  { id: "formulation", title: "Clinical formulation", prompt: "Predisposing, precipitating, perpetuating, protective factors" },
] as const;
export const INTERVIEW_FIELDS = ["findings", "supporting_evidence", "contradicting_evidence", "duration", "frequency", "severity", "functional_impact"] as const;

export const NOTE_KINDS = ["observation", "session_summary", "comment", "formulation", "followup"] as const;
export const HISTORY_KINDS = ["reason_for_referral", "referral_source", "presenting_concerns", "developmental_history", "medical_history", "psychological_history", "previous_treatment", "medication"] as const;
export const EXTERNAL_INSTRUMENTS = { wais4: "WAIS-IV", caars: "CAARS", pai: "PAI" } as const;
export type ExternalId = keyof typeof EXTERNAL_INSTRUMENTS;
export const isExternalId = (x: unknown): x is ExternalId => typeof x === "string" && x in EXTERNAL_INSTRUMENTS;

export const REPORT_SECTIONS = [
  ["identification", "1. Patient identification and demographics"],
  ["referral_source", "2. Referral source"],
  ["reason_for_referral", "3. Reason for referral"],
  ["presenting_concerns", "4. Presenting concerns"],
  ["personal_history", "5. Relevant personal and developmental history"],
  ["previous_treatment", "6. Previous diagnoses and treatment"],
  ["assessments_administered", "7. Assessments administered"],
  ["behavioural_observations", "8. Behavioural observations (psychologist)"],
  ["results", "9. Assessment results and scores"],
  ["interview_findings", "10. Structured clinical interview findings"],
  ["formulation", "11. Clinical formulation"],
  ["diagnostic_impressions", "12. Diagnostic impressions (entered by the psychologist)"],
  ["recommendations", "13. Recommendations"],
  ["limitations", "14. Limitations and qualifications"],
  ["psychologist", "15. Psychologist name and credentials"],
  ["approval", "16. Report date and approval"],
] as const;
