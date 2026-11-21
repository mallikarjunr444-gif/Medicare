/**
 * Pure measurement logic for the on-device camera tracking (no DOM, no network).
 * Everything here turns raw MediaPipe output into plain measurements. Nothing is inferred about mental state.
 */

export interface Pt { x: number; y: number; z?: number }

export const FACE = {
  // Standard 6-point EAR sets from the MediaPipe 478-point face mesh: [outer, upper1, upper2, inner, lower2, lower1]
  rightEye: [33, 160, 158, 133, 153, 144],
  leftEye: [263, 387, 385, 362, 380, 373],
  rightIris: 468, leftIris: 473,
  rightLid: { top: 159, bottom: 145 }, leftLid: { top: 386, bottom: 374 },
} as const

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0)
export const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

/** Eye Aspect Ratio for one eye from the 6-point set (Soukupova & Cech, 2016). */
export function eyeAspectRatio(lm: Pt[], idx: readonly number[]): number {
  const [p1, p2, p3, p4, p5, p6] = idx.map((i) => lm[i])
  const horizontal = dist(p1, p4)
  return horizontal > 0 ? (dist(p2, p6) + dist(p3, p5)) / (2 * horizontal) : 0
}
export const earOf = (lm: Pt[]) => (eyeAspectRatio(lm, FACE.rightEye) + eyeAspectRatio(lm, FACE.leftEye)) / 2

/**
 * Iris position inside the eye opening: h 0..1 across the eye (0.5 = centred), v 0..1 top to bottom.
 * This is the eye's rotation relative to the head only; it is combined with head pose before any "toward screen" estimate.
 */
export function irisPosition(lm: Pt[]): { h: number; v: number } | null {
  if (lm.length < 478) return null
  const one = (iris: number, a: number, b: number, lid: { top: number; bottom: number }) => {
    const left = Math.min(lm[a].x, lm[b].x), right = Math.max(lm[a].x, lm[b].x)
    const top = lm[lid.top].y, bottom = lm[lid.bottom].y
    if (right - left <= 0 || bottom - top <= 0.0005) return null
    return { h: (lm[iris].x - left) / (right - left), v: (lm[iris].y - top) / (bottom - top) }
  }
  const r = one(FACE.rightIris, 33, 133, FACE.rightLid), l = one(FACE.leftIris, 362, 263, FACE.leftLid)
  if (!r || !l) return null
  return { h: (r.h + l.h) / 2, v: (r.v + l.v) / 2 }
}

/** Head pose in degrees from the 4x4 column-major facial transformation matrix. Magnitudes are reliable; signs are a convention of the model. */
export function headPoseFromMatrix(m: ArrayLike<number> | undefined): { pitch: number; yaw: number; roll: number } | null {
  if (!m || m.length < 16) return null
  const R = (row: number, col: number) => m[col * 4 + row]
  const sy = Math.hypot(R(0, 0), R(1, 0))
  const deg = (r: number) => (r * 180) / Math.PI
  if (!Number.isFinite(sy)) return null
  return { pitch: deg(Math.atan2(R(2, 1), R(2, 2))), yaw: deg(Math.atan2(-R(2, 0), sy)), roll: deg(Math.atan2(R(1, 0), R(0, 0))) }
}

export type GazeEstimate = 'toward_screen' | 'away_from_screen' | 'unknown'
/** A coarse estimate: head roughly facing the screen AND irises near the centre of the eyes. It is an estimate, not true eye tracking. */
export function estimateGaze(iris: { h: number; v: number } | null, pose: { pitch: number; yaw: number } | null): GazeEstimate {
  if (!iris || !pose) return 'unknown'
  const headFacing = Math.abs(pose.yaw) < 25 && Math.abs(pose.pitch) < 25
  const eyesCentred = iris.h > 0.32 && iris.h < 0.68
  return headFacing && eyesCentred ? 'toward_screen' : 'away_from_screen'
}

export function faceBox(lm: Pt[]) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0
  for (const p of lm) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  const inFrame = minX > 0.01 && minY > 0.01 && maxX < 0.99 && maxY < 0.99
  return { cx, cy, width: maxX - minX, height: maxY - minY, inFrame }
}

/** Blink detector with an adaptive threshold (75% of the person's own open-eye median), timed in milliseconds. */
export class BlinkTracker {
  private openSamples: number[] = []
  private closedSince: number | null = null
  private lastBlinkAt: number | null = null
  count = 0
  intervalsMs: number[] = []
  closureMs: number[] = []
  longClosures = 0 // closures over 600 ms: counted separately, not as blinks
  private threshold = 0.2

  update(t: number, ear: number): boolean {
    if (!Number.isFinite(ear) || ear < 0) return false
    if (this.closedSince === null) {
      this.openSamples.push(ear)
      if (this.openSamples.length > 300) this.openSamples.shift()
      if (this.openSamples.length >= 30) this.threshold = clamp(median(this.openSamples) * 0.75, 0.12, 0.25)
    }
    const closed = ear < this.threshold
    if (closed && this.closedSince === null) { this.closedSince = t; return false }
    if (!closed && this.closedSince !== null) {
      const dur = t - this.closedSince
      this.closedSince = null
      if (dur >= 40 && dur <= 600) {
        this.count++; this.closureMs.push(dur)
        if (this.lastBlinkAt !== null) this.intervalsMs.push(t - this.lastBlinkAt)
        this.lastBlinkAt = t
        return true
      }
      if (dur > 600) this.longClosures++
    }
    return false
  }
  /** Call when the face is lost so a gap is never counted as an eye closure. */
  reset() { this.closedSince = null }
}

export interface PoseLm { x: number; y: number; visibility?: number }
/** Upper-body measurements from pose landmarks (11/12 shoulders, 0 nose). Needs both shoulders clearly visible. */
export function upperBody(p: PoseLm[] | undefined) {
  if (!p || p.length < 13) return null
  const l = p[11], r = p[12]
  if ((l.visibility ?? 0) < 0.5 || (r.visibility ?? 0) < 0.5) return null
  const width = Math.hypot(l.x - r.x, l.y - r.y)
  if (width < 0.05) return null
  const tilt = (Math.atan2(r.y - l.y, r.x - l.x) * 180) / Math.PI
  return { width, tilt: Math.abs(tilt) > 90 ? tilt - Math.sign(tilt) * 180 : tilt, cx: (l.x + r.x) / 2, cy: (l.y + r.y) / 2 }
}

export interface FrameInput {
  t: number // ms timestamp
  faces: number
  landmarks?: Pt[]
  blendshapes?: Record<string, number>
  matrix?: ArrayLike<number>
  pose?: PoseLm[]
  poseRan?: boolean
  luma?: number // 0..255 mean brightness of a tiny sample, when measured
}

export interface LiveReadout {
  faceVisible: boolean
  multipleFaces: boolean
  inFrame: boolean
  gaze: GazeEstimate
  head: { pitch: number; yaw: number; roll: number } | null
  blinks: number
  blinksPerMin: number
  quality: 'good' | 'fair' | 'poor' | 'none'
  lighting: 'ok' | 'dim' | 'bright' | 'unknown'
  posture: { tilt: number; closer: 'closer' | 'further' | 'similar' } | null
}

const MOVE_KEYS = ['mouthSmileLeft', 'mouthSmileRight', 'browDownLeft', 'browDownRight', 'browInnerUp', 'jawOpen', 'mouthPucker', 'eyeSquintLeft', 'eyeSquintRight']

export class SessionAggregator {
  readonly blink = new BlinkTracker()
  private startT: number | null = null
  private lastT: number | null = null
  frames = 0; facesFrames = 0; multiFaceFrames = 0; inFrameFrames = 0; lostSegments = 0
  private lostSince: number | null = null
  private poseFrames = 0
  private gazeCounts: Record<GazeEstimate, number> = { toward_screen: 0, away_from_screen: 0, unknown: 0 }
  private headSamples: { pitch: number; yaw: number; roll: number; t: number }[] = []
  private lumas: number[] = []
  private recent: boolean[] = []
  private smile: number[] = []; private brow: number[] = []; private mouthOpen: number[] = []
  private moveEarly: number[] = []; private moveLate: number[] = []
  private prevShapes: Record<string, number> | null = null
  private baseWidth: number[] = []; private baseWidthMed: number | null = null
  private tilts: number[] = []; private widthRatios: number[] = []; private bodyMove: number[] = []
  private prevBody: { cx: number; cy: number } | null = null
  live: LiveReadout = { faceVisible: false, multipleFaces: false, inFrame: false, gaze: 'unknown', head: null, blinks: 0, blinksPerMin: 0, quality: 'none', lighting: 'unknown', posture: null }

  update(f: FrameInput): LiveReadout {
    if (this.startT === null) this.startT = f.t
    this.lastT = f.t
    this.frames++
    if (typeof f.luma === 'number') this.lumas.push(f.luma)
    const visible = f.faces > 0 && !!f.landmarks && f.landmarks.length >= 468
    this.recent.push(visible); if (this.recent.length > 45) this.recent.shift()

    let gaze: GazeEstimate = 'unknown', head: LiveReadout['head'] = null, inFrame = false
    if (visible) {
      this.facesFrames++
      if (f.faces > 1) this.multiFaceFrames++
      if (this.lostSince !== null) { this.lostSince = null }
      const lm = f.landmarks!
      const box = faceBox(lm); inFrame = box.inFrame; if (inFrame) this.inFrameFrames++
      this.blink.update(f.t, earOf(lm))
      head = headPoseFromMatrix(f.matrix)
      if (head) this.headSamples.push({ ...head, t: f.t })
      gaze = estimateGaze(irisPosition(lm), head)
      this.gazeCounts[gaze]++
      if (f.blendshapes) this.blendshapeFrame(f.t, f.blendshapes)
    } else {
      if (this.lostSince === null) { this.lostSince = f.t; this.lostSegments++ }
      this.blink.reset(); this.prevShapes = null
    }

    let posture: LiveReadout['posture'] = null
    if (f.poseRan !== false) {
      const body = upperBody(f.pose)
      if (body) {
        this.poseFrames++
        if (this.baseWidthMed === null) { this.baseWidth.push(body.width); if (this.baseWidth.length >= 30) this.baseWidthMed = median(this.baseWidth) }
        const ratio = this.baseWidthMed ? body.width / this.baseWidthMed : 1
        if (this.baseWidthMed) this.widthRatios.push(ratio)
        this.tilts.push(body.tilt)
        if (this.prevBody) this.bodyMove.push(Math.hypot(body.cx - this.prevBody.cx, body.cy - this.prevBody.cy))
        this.prevBody = { cx: body.cx, cy: body.cy }
        posture = { tilt: body.tilt, closer: ratio > 1.12 ? 'closer' : ratio < 0.88 ? 'further' : 'similar' }
      }
    } else posture = this.live.posture

    const minutes = Math.max((f.t - this.startT) / 60000, 1 / 60)
    const recentRatio = this.recent.filter(Boolean).length / this.recent.length
    const lastLuma = this.lumas.length ? this.lumas[this.lumas.length - 1] : null
    this.live = {
      faceVisible: visible, multipleFaces: f.faces > 1, inFrame, gaze, head, blinks: this.blink.count, blinksPerMin: this.blink.count / minutes,
      quality: !this.recent.length ? 'none' : recentRatio > 0.9 && inFrame ? 'good' : recentRatio > 0.6 ? 'fair' : 'poor',
      lighting: lastLuma === null ? 'unknown' : lastLuma < 45 ? 'dim' : lastLuma > 215 ? 'bright' : 'ok', posture,
    }
    return this.live
  }

  private blendshapeFrame(t: number, s: Record<string, number>) {
    const g = (k: string) => s[k] ?? 0
    this.smile.push((g('mouthSmileLeft') + g('mouthSmileRight')) / 2)
    this.brow.push((g('browInnerUp') + g('browDownLeft') + g('browDownRight')) / 3)
    this.mouthOpen.push(g('jawOpen'))
    if (this.prevShapes) {
      const move = mean(MOVE_KEYS.map((k) => Math.abs(g(k) - (this.prevShapes![k] ?? 0))))
      ;((t - (this.startT ?? t)) < 60000 ? this.moveEarly : this.moveLate).push(move)
    }
    this.prevShapes = s
  }

  /** The only data that ever leaves this class: numbers that were actually measured. */
  summary() {
    const durationMs = this.startT !== null && this.lastT !== null ? this.lastT - this.startT : 0
    const frac = (n: number, d: number) => (d > 0 ? n / d : null)
    const head = this.headSamples
    const gazeTotal = this.gazeCounts.toward_screen + this.gazeCounts.away_from_screen
    const minutes = durationMs / 60000
    return {
      durationSec: Math.round(durationMs / 1000),
      framesAnalysed: this.frames,
      face: {
        visibleFraction: frac(this.facesFrames, this.frames), inFrameFraction: frac(this.inFrameFrames, this.facesFrames),
        multipleFacesFraction: frac(this.multiFaceFrames, this.frames), trackingInterruptions: this.lostSegments,
      },
      blinks: {
        count: this.blink.count, perMinute: minutes > 0.25 ? this.blink.count / minutes : null,
        medianIntervalSec: this.blink.intervalsMs.length ? median(this.blink.intervalsMs) / 1000 : null,
        medianClosureMs: this.blink.closureMs.length ? Math.round(median(this.blink.closureMs)) : null, longClosures: this.blink.longClosures,
      },
      head: head.length ? {
        samples: head.length, meanAbsPitch: mean(head.map((h) => Math.abs(h.pitch))), meanAbsYaw: mean(head.map((h) => Math.abs(h.yaw))), meanAbsRoll: mean(head.map((h) => Math.abs(h.roll))),
        maxAbsYaw: Math.max(...head.map((h) => Math.abs(h.yaw))), maxAbsPitch: Math.max(...head.map((h) => Math.abs(h.pitch))),
      } : null,
      gaze: gazeTotal ? { towardScreenFraction: this.gazeCounts.toward_screen / gazeTotal, awayFraction: this.gazeCounts.away_from_screen / gazeTotal } : null,
      facialMovement: this.smile.length ? {
        smileActivationMean: mean(this.smile), browActivationMean: mean(this.brow), mouthOpenMean: mean(this.mouthOpen),
        movementIntensityFirstMinute: this.moveEarly.length ? mean(this.moveEarly) : null, movementIntensityRest: this.moveLate.length ? mean(this.moveLate) : null,
      } : null,
      posture: this.poseFrames ? {
        framesWithUpperBody: this.poseFrames, meanShoulderTiltDeg: mean(this.tilts.map(Math.abs)),
        closerToCameraFraction: this.widthRatios.length ? this.widthRatios.filter((r) => r > 1.12).length / this.widthRatios.length : null,
        furtherFromCameraFraction: this.widthRatios.length ? this.widthRatios.filter((r) => r < 0.88).length / this.widthRatios.length : null,
        bodyMovementMean: this.bodyMove.length ? mean(this.bodyMove) : null,
      } : null,
      lighting: this.lumas.length ? { meanBrightness: Math.round(mean(this.lumas)), dimFraction: this.lumas.filter((l) => l < 45).length / this.lumas.length } : null,
    }
  }
}

export type VisionSummary = ReturnType<SessionAggregator['summary']>
const pct = (v: number | null | undefined) => (v === null || v === undefined ? null : `${Math.round(v * 100)}%`)

/** Plain-language lines written only from measured numbers. Deliberately contains no interpretation of mental state. */
export function describeSummary(s: VisionSummary): string[] {
  const out: string[] = []
  if (!s.framesAnalysed) return ['No camera frames were analysed.']
  out.push(`Camera analysed for ${Math.floor(s.durationSec / 60)} min ${s.durationSec % 60} s.`)
  if (s.face.visibleFraction !== null) out.push(`A face was visible in ${pct(s.face.visibleFraction)} of analysed frames.`)
  if (s.face.trackingInterruptions > 0) out.push(`Tracking was interrupted ${s.face.trackingInterruptions} time(s).`)
  if (s.face.multipleFacesFraction && s.face.multipleFacesFraction > 0.02) out.push(`More than one face was visible in ${pct(s.face.multipleFacesFraction)} of frames.`)
  out.push(`${s.blinks.count} blink(s) were detected${s.blinks.perMinute !== null ? ` (about ${s.blinks.perMinute.toFixed(0)} per minute)` : ''}.`)
  if (s.head) out.push(`Head orientation varied by an average of ${s.head.meanAbsYaw.toFixed(0)}° (turn) and ${s.head.meanAbsPitch.toFixed(0)}° (tilt up/down) from facing the camera.`)
  if (s.gaze) out.push(`Gaze was estimated toward the screen in ${pct(s.gaze.towardScreenFraction)} of frames with an estimate.`)
  if (s.posture) out.push(`Upper body was visible in ${s.posture.framesWithUpperBody} analysed frames; mean shoulder-line tilt ${s.posture.meanShoulderTiltDeg.toFixed(1)}°.`)
  if (s.lighting && s.lighting.dimFraction > 0.2) out.push(`Lighting was dim for ${pct(s.lighting.dimFraction)} of the session, which can reduce tracking accuracy.`)
  out.push('These are camera measurements only. They are not a diagnosis and do not show emotion, honesty or mental state.')
  return out
}
