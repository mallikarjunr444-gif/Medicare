// Validated screening instruments and their published scoring rules.
//  - PHQ-9 and GAD-7: Pfizer-developed, free to use without permission (Spitzer, Williams, Kroenke).
//  - ASRS-v1.1 Part A (6 items): WHO / Kessler et al. Wording and usage rights MUST be confirmed against the official
//    form before clinical use (see `notice`). Scores are screening results, never diagnoses.
// WAIS-IV, CAARS, PAI and any DSM-5-TR interview material are proprietary and are intentionally NOT included.

export type InstrumentId = "gad7" | "phq9" | "asrs6";

export interface Instrument {
  id: InstrumentId;
  name: string;
  fullName: string;
  version: string;
  purpose: string;
  intro: string;
  options: string[]; // index = score
  items: string[];
  notice: string;
  attribution?: string; // copyright credit that the rights holder requires wherever the instrument or its results appear
}

const FREQ = ["Not at all", "Several days", "More than half the days", "Nearly every day"];
const OVER_2_WEEKS = "Over the last 2 weeks, how often have you been bothered by the following problems?";

export const INSTRUMENTS: Record<InstrumentId, Instrument> = {
  gad7: {
    id: "gad7", name: "GAD-7", fullName: "Generalized Anxiety Disorder-7", version: "GAD-7 (Spitzer et al., 2006)",
    purpose: "Anxiety symptom screening", intro: OVER_2_WEEKS, options: FREQ,
    items: [
      "Feeling nervous, anxious, or on edge",
      "Not being able to stop or control worrying",
      "Worrying too much about different things",
      "Trouble relaxing",
      "Being so restless that it is hard to sit still",
      "Becoming easily annoyed or irritable",
      "Feeling afraid, as if something awful might happen",
    ],
    notice: "Screening result only. It is not a diagnosis.",
  },
  phq9: {
    id: "phq9", name: "PHQ-9", fullName: "Patient Health Questionnaire-9", version: "PHQ-9 (Kroenke, Spitzer & Williams, 2001)",
    purpose: "Depression symptom screening", intro: OVER_2_WEEKS, options: FREQ,
    items: [
      "Little interest or pleasure in doing things",
      "Feeling down, depressed, or hopeless",
      "Trouble falling or staying asleep, or sleeping too much",
      "Feeling tired or having little energy",
      "Poor appetite or overeating",
      "Feeling bad about yourself — or that you are a failure or have let yourself or your family down",
      "Trouble concentrating on things, such as reading the newspaper or watching television",
      "Moving or speaking so slowly that other people could have noticed? Or the opposite — being so fidgety or restless that you have been moving around a lot more than usual",
      "Thoughts that you would be better off dead or of hurting yourself in some way",
    ],
    notice: "Screening result only. It is not a diagnosis and not a suicide-risk assessment.",
  },
  asrs6: {
    id: "asrs6", name: "ASRS-v1.1 (6-item screener)", fullName: "Adult ADHD Self-Report Scale v1.1, Part A", version: "ASRS-v1.1 Part A",
    purpose: "Adult ADHD symptom screening", intro: "Please answer the questions below, rating yourself on each of the criteria shown, using the scale on the right.",
    options: ["Never", "Rarely", "Sometimes", "Often", "Very often"],
    items: [
      "How often do you have trouble wrapping up the final details of a project, once the challenging parts have been done?",
      "How often do you have difficulty getting things in order when you have to do a task that requires organization?",
      "How often do you have problems remembering appointments or obligations?",
      "When you have a task that requires a lot of thought, how often do you avoid or delay getting started?",
      "How often do you fidget or squirm with your hands or feet when you have to sit down for a long time?",
      "How often do you feel overly active and compelled to do things, like you were driven by a motor?",
    ],
    notice: "Screening result only. It is not a diagnosis.",
    attribution: "The 6-question Adult Self-Report Scale-Version1.1 (ASRS-V1.1) Screener is a subset of the 18-question Adult ADHD Self-Report Scale-Version1.1 (Adult ASRSV1.1) Symptom Checklist. © New York University and the President and Fellows of Harvard College.",
  },
};

export const isInstrumentId = (v: unknown): v is InstrumentId => typeof v === "string" && v in INSTRUMENTS;

export interface ScoreResult {
  total: number | null;
  severity: string;
  label: string;
  screening?: "positive" | "negative";
  flags: { item9Positive?: boolean; shadedCount?: number };
  notice: string;
  attribution?: string; // copyright credit that the rights holder requires wherever the instrument or its results appear
}

/** Validates answers (every item present, integer within the option range). Returns an error message or null. */
export function validateAnswers(id: InstrumentId, answers: unknown): string | null {
  const ins = INSTRUMENTS[id];
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return "answers must be an object";
  const a = answers as Record<string, unknown>;
  for (let i = 0; i < ins.items.length; i++) {
    const v = a[String(i)];
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) >= ins.options.length) return `Item ${i + 1} needs a valid answer`;
  }
  if (Object.keys(a).length !== ins.items.length) return "answers contain unknown items";
  return null;
}

export function score(id: InstrumentId, answers: Record<string, number>): ScoreResult {
  const ins = INSTRUMENTS[id];
  const vals = ins.items.map((_, i) => answers[String(i)]);
  if (id === "gad7") {
    const total = vals.reduce((a, b) => a + b, 0);
    const [severity, label] = total <= 4 ? ["minimal", "Minimal anxiety"] : total <= 9 ? ["mild", "Mild anxiety"] : total <= 14 ? ["moderate", "Moderate anxiety"] : ["severe", "Severe anxiety"];
    return { total, severity, label, flags: {}, notice: ins.notice };
  }
  if (id === "phq9") {
    const total = vals.reduce((a, b) => a + b, 0);
    const [severity, label] = total <= 4 ? ["minimal", "None to minimal depression"] : total <= 9 ? ["mild", "Mild depression"] : total <= 14 ? ["moderate", "Moderate depression"] : total <= 19 ? ["moderately_severe", "Moderately severe depression"] : ["severe", "Severe depression"];
    return { total, severity, label, flags: { item9Positive: vals[8] > 0 }, notice: ins.notice };
  }
  // ASRS-v1.1 Part A: items 1-3 are shaded at "Sometimes" or higher; items 4-6 at "Often" or higher.
  // Four or more shaded responses is a positive screen. There is no summed severity score.
  const shaded = vals.filter((v, i) => (i < 3 ? v >= 2 : v >= 3)).length;
  const positive = shaded >= 4;
  return {
    total: null, severity: positive ? "positive_screen" : "negative_screen",
    label: positive ? "Positive screen: symptoms are highly consistent with ADHD in adults and warrant further assessment" : "Negative screen",
    screening: positive ? "positive" : "negative", flags: { shadedCount: shaded }, notice: ins.notice,
  };
}
