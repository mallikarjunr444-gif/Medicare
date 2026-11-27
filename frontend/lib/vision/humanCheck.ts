/**
 * Pure decision logic for "is a real person in front of the camera?" (no DOM, no network, easy to test).
 * The detectors (MediaPipe face detector + COCO object detector) run in useHumanCheck.ts; this file only turns their
 * per-frame output into a stable state so one noisy frame never flips the screen.
 *
 * This is a presence check, not anti-spoofing: a photo or a screen showing a face can still pass it.
 */

export interface Detection { label: string; score: number }
export type FrameVerdict = 'human' | 'animal' | 'nobody'
export type HumanState = 'checking' | 'human' | 'animal' | 'nobody'

/** COCO classes that are animals. These are what people hold up to test the software. */
export const ANIMAL_LABELS = new Set(['bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe'])

const PERSON_MIN = 0.45
const ANIMAL_MIN = 0.5
const FACE_MIN = 0.6

/** One frame. An animal that is clearly seen, with no person detected by the object detector, wins even if the face detector fires on it (animal faces do trigger it). */
export function classifyFrame(input: { faces: number[]; objects: Detection[] }): { verdict: FrameVerdict; animal?: string } {
  const person = Math.max(0, ...input.objects.filter((o) => o.label === 'person').map((o) => o.score))
  const faceScore = Math.max(0, ...input.faces)
  let animal: Detection | undefined
  for (const o of input.objects) if (ANIMAL_LABELS.has(o.label) && o.score >= ANIMAL_MIN && (!animal || o.score > animal.score)) animal = o
  if (animal && person < PERSON_MIN) return { verdict: 'animal', animal: animal.label }
  if (person >= PERSON_MIN || faceScore >= FACE_MIN) {
    return { verdict: 'human' }
  }
  return { verdict: 'nobody' }
}

/**
 * Smooths frame verdicts. Becomes `human` after a few consecutive human frames; leaves `human` only after
 * several seconds without one (blinks, looking down, a brief dropout). Animals need a longer streak before they are named.
 */
export class HumanGate {
  state: HumanState = 'checking'
  animal: string | undefined
  private humanRun = 0
  private animalRun = 0
  private lastHumanAt = 0
  private nobodyRun = 0
  private readonly opts: { enterFrames: number; animalFrames: number; graceMs: number; nobodyFrames: number }
  constructor(opts?: Partial<{ enterFrames: number; animalFrames: number; graceMs: number; nobodyFrames: number }>) {
    this.opts = { enterFrames: 4, animalFrames: 6, graceMs: 3000, nobodyFrames: 12, ...opts }
  }

  push(verdict: FrameVerdict, animal: string | undefined, now: number): HumanState {
    if (verdict === 'human') {
      this.humanRun++; this.animalRun = 0; this.nobodyRun = 0; this.lastHumanAt = now
      if (this.state !== 'human' && this.humanRun >= this.opts.enterFrames) { this.state = 'human'; this.animal = undefined }
    } else if (verdict === 'animal') {
      this.humanRun = 0; this.nobodyRun = 0; this.animalRun++
      if (this.animalRun >= this.opts.animalFrames && (this.state !== 'human' || now - this.lastHumanAt > this.opts.graceMs)) { this.state = 'animal'; this.animal = animal }
    } else {
      this.humanRun = 0; this.animalRun = 0; this.nobodyRun++
      if (this.state === 'human') { if (now - this.lastHumanAt > this.opts.graceMs) this.state = 'nobody' }
      else if (this.state === 'animal') this.state = 'nobody'
      else if (this.nobodyRun >= this.opts.nobodyFrames) this.state = 'nobody' // 'checking' lasts a few seconds, not forever
    }
    return this.state
  }
  reset(): void { this.state = 'checking'; this.animal = undefined; this.humanRun = 0; this.animalRun = 0; this.nobodyRun = 0; this.lastHumanAt = 0 }
}

export function humanMessage(state: HumanState, animal?: string): string {
  if (state === 'animal') return `That looks like ${animal ? `a ${animal}` : 'an animal'}, not a person. Please sit in front of the camera yourself so the doctor can see you.`
  if (state === 'nobody') return 'We can’t see a person. Please move into view of the camera and face it.'
  return 'Checking that you are in front of the camera…'
}
