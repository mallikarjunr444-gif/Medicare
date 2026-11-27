// Supporting information for the doctor, from the patient's camera, measured on the patient's device.
// The browser sends only a small block of numbers (never a picture). Here every number is range-checked and turned
// into a few plain lines for the doctor's prompt. Nothing is stored, and nothing here names an emotion or a condition:
// facial-expression models cannot diagnose depression, so these lines are context for gentle, open questions only.

const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const pct = (v: number | null) => (v === null ? null : `${Math.round(v * 100)}%`);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Returns prompt-ready lines, or null when the block is missing, malformed or too short to mean anything. */
export function describeObservations(raw: unknown): string | null {
  const s = obj(raw);
  if (!s) return null;
  const durationSec = num(s.durationSec, 0, 6 * 3600);
  const frames = num(s.framesAnalysed, 0, 1e6);
  if (durationSec === null || frames === null || frames < 50) return null;

  const out: string[] = [];
  const face = obj(s.face);
  const visible = num(face?.visibleFraction, 0, 1);
  if (visible !== null) out.push(`face visible in ${pct(visible)} of frames`);
  const blinks = obj(s.blinks);
  const perMin = num(blinks?.perMinute, 0, 120);
  if (perMin !== null) out.push(`about ${Math.round(perMin)} blinks per minute`);
  const gaze = obj(s.gaze);
  const toward = num(gaze?.towardScreenFraction, 0, 1);
  if (toward !== null) out.push(`gaze estimated toward the screen ${pct(toward)} of the time`);
  const head = obj(s.head);
  const yaw = num(head?.meanAbsYaw, 0, 180);
  const pitch = num(head?.meanAbsPitch, 0, 180);
  if (yaw !== null && pitch !== null) out.push(`head turned ${Math.round(yaw)}° and tilted ${Math.round(pitch)}° from facing the camera on average`);
  const move = obj(s.facialMovement);
  const smile = num(move?.smileActivationMean, 0, 1);
  const brow = num(move?.browActivationMean, 0, 1);
  if (smile !== null) out.push(`smile muscle activation ${smile < 0.08 ? "low" : smile < 0.3 ? "moderate" : "high"} (${smile.toFixed(2)} of 1)`);
  if (brow !== null) out.push(`brow activation ${brow < 0.08 ? "low" : brow < 0.3 ? "moderate" : "high"} (${brow.toFixed(2)} of 1)`);
  const early = num(move?.movementIntensityFirstMinute, 0, 5);
  const rest = num(move?.movementIntensityRest, 0, 5);
  if (early !== null && rest !== null && early > 0 && rest < early * 0.6) out.push("facial movement lower later in the session than in the first minute");
  const light = obj(s.lighting);
  if (num(light?.dimFraction, 0, 1) !== null && (light!.dimFraction as number) > 0.2) out.push("the room was dim for part of the session, so these numbers may be less accurate");
  if (!out.length) return null;
  return `Camera measurements over ${Math.round(durationSec / 60)} min (measured on the patient's device): ${out.join("; ")}.`;
}

/** Guidance that goes with the measurements in the doctor's prompt. */
export const OBSERVATION_RULES =
  "Use these only as quiet background context. They are not a diagnosis and cannot show emotion, honesty, or depression. Never tell the patient what the camera 'shows', never name an emotion or condition from them, and never mention cameras, measurements or analysis. If something here seems relevant, ask one gentle, open question about how they are feeling, and rely on what the patient actually tells you.";
