/**
 * Talking-portrait engine: animates a still photograph on a plain 2D canvas, on the CPU.
 *
 * How it works
 *  - The face is split into small triangles (a regular grid) only around the eyes, brows and
 *    mouth. Each frame the grid vertices are displaced by smooth, local fields and the photo's
 *    own pixels are re-drawn through those triangles (affine texture mapping).
 *  - Blink: the upper-lid region is compressed down onto the lower lid.
 *  - Speech: the jaw and lower lip drop, the upper lip lifts a little and the mouth widens or
 *    narrows. The gap between the lips is filled with a mouth interior (cavity, teeth, tongue).
 *  - The mouth drive (`open`, `wide`) is meant to come from the real audio signal
 *    (see audioEnergy.ts), so lip movement follows the voice that is actually playing.
 *
 * Honest limits: this is a 2D puppet of one photograph. It cannot turn the head, show real
 * teeth or reproduce exact phonemes; it gives convincing blinking and jaw/lip movement locked
 * to loudness and brightness of the voice, with no GPU and no cloud service.
 */
import type { DoctorFaceData } from './doctorFaceData'

export interface PortraitPose {
  /** 0..1 eyelid closure. */
  blink: number
  /** 0..1 mouth opening (from audio loudness). */
  open: number
  /** ~0.9 (rounded "oo") .. ~1.1 (spread "ee"); 1 is neutral. */
  wide: number
  /** 0..1 eyebrow lift. */
  brow: number
  /** -0.5 (corners down, concerned) .. 1 (broad smile); 0 is neutral. */
  smile?: number
  /** -1 (looking left) .. 1 (right): the iris drifts inside the eye opening. 0 is straight ahead. */
  gazeX?: number
  /** -1 (up) .. 1 (down). */
  gazeY?: number
}

/**
 * Where a doctor's hair hangs, in source-image pixels, so it can sway gently. Only the strands
 * beside the face and neck move; the face, neck and clothing never do. Tuned per photograph.
 */
export interface HairSwayRegion {
  /** Rows above `top` stay still; the sway builds up to full strength at `full`. */
  top: number
  full: number
  /** Sway fades back to nothing between `fadeFrom` and `bottom` (where hair meets the coat). */
  fadeFrom: number
  bottom: number
  /** Outer edges of the moving areas, in the plain wall behind the hair. */
  leftOuter: number
  rightOuter: number
  /** Where the neck starts on each side, so the sway never touches it. */
  neckL: number
  neckR: number
  /** Largest sideways movement of the hair tips, in source px. */
  amplitude: number
}

interface Cell {
  /** Source rectangle in image px. */
  x0: number
  y0: number
  x1: number
  y1: number
  zone: 'eyeL' | 'eyeR' | 'mouth' | 'browL' | 'browR'
  /** Eye cells that cover the eyeball itself (the only ones the gaze drift moves). */
  ball?: boolean
  /** True for mouth cells that straddle the lip line (they open up when speaking). */
  seam: boolean
}

interface Anchors {
  eye: { cx: number; cy: number; w: number; lid: number; low: number; outer: number[]; inner: number[] }[]
  brow: { cx: number; cy: number; w: number }[]
  mouth: {
    cx: number
    cy: number
    cos: number
    sin: number
    /** Lip-contact curve in the mouth frame: v = a + b*u + c*u^2. */
    a: number
    b: number
    c: number
    w: number
    innerHalf: number
    top: number
    bottom: number
  }
}

const CELL = 3.5
const HAIR_BAND = 8
const HAIR_COLUMNS = 5

interface HairColumn { x: number; w: number; k: number; side: 0 | 1 }
interface HairBand { y: number; h: number; k: number; cols: HairColumn[] }

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1])
const mean = (vals: number[]) => vals.reduce((s, v) => s + v, 0) / vals.length
const smooth = (t: number) => {
  const c = Math.max(0, Math.min(1, t))
  return c * c * (3 - 2 * c)
}

function buildAnchors(face: DoctorFaceData): Anchors {
  const p = face.points
  const eyeFrom = (a: number, b: number) => {
    const ring = p.slice(a, b)
    const w = dist(p[a], p[a + 3])
    return {
      cx: mean(ring.map((q) => q[0])),
      cy: mean(ring.map((q) => q[1])),
      w,
      lid: mean([p[a + 1][1], p[a + 2][1]]),
      low: mean([p[a + 4][1], p[a + 5][1]]),
      outer: p[a],
      inner: p[a + 3],
    }
  }
  const browFrom = (a: number, b: number) => {
    const ring = p.slice(a, b)
    return { cx: mean(ring.map((q) => q[0])), cy: mean(ring.map((q) => q[1])), w: dist(p[a], p[b - 1]) }
  }
  const left = p[60]
  const right = p[64]
  const cx = (left[0] + right[0]) / 2
  const cy = (left[1] + right[1]) / 2
  const theta = Math.atan2(right[1] - left[1], right[0] - left[0])
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const avg = (i: number, j: number) => [(p[i][0] + p[j][0]) / 2, (p[i][1] + p[j][1]) / 2]
  const lineSamples = [left, avg(61, 67), avg(62, 66), avg(63, 65), right].map((q) => {
    const dx = q[0] - cx
    const dy = q[1] - cy
    return { u: dx * cos + dy * sin, v: -dx * sin + dy * cos }
  })
  const [qa, qb, qc] = fitQuadratic(lineSamples)
  const outerY = p.slice(48, 60).map((q) => q[1])
  return {
    eye: [eyeFrom(36, 42), eyeFrom(42, 48)],
    brow: [browFrom(17, 22), browFrom(22, 27)],
    mouth: {
      cx,
      cy,
      cos,
      sin,
      a: qa,
      b: qb,
      c: qc,
      w: dist(p[48], p[54]),
      innerHalf: dist(left, right) / 2,
      top: Math.min(...outerY),
      bottom: Math.max(...outerY),
    },
  }
}

/** Pre-computes the hair bands: which strips of the photo move, and how strongly. */
function buildHair(face: DoctorFaceData, r: HairSwayRegion): { bands: HairBand[]; amplitude: number } {
  const p = face.points
  // The face edge at row y, from the jaw landmarks (0..8 left, 16..8 right); the neck limits it lower down.
  const edge = (y: number, from: number, to: number): number => {
    const idx: number[] = []
    for (let i = from; from < to ? i <= to : i >= to; i += from < to ? 1 : -1) idx.push(i)
    if (y <= p[idx[0]][1]) return p[idx[0]][0]
    for (let i = 1; i < idx.length; i++) {
      const a = p[idx[i - 1]]
      const b = p[idx[i]]
      if (y <= b[1]) return a[0] + ((b[0] - a[0]) * (y - a[1])) / Math.max(1e-6, b[1] - a[1])
    }
    return p[idx[idx.length - 1]][0]
  }
  const bands: HairBand[] = []
  for (let y = r.top; y < r.bottom; y += HAIR_BAND) {
    const yc = y + HAIR_BAND / 2
    const k = smooth((yc - r.top) / (r.full - r.top)) * (1 - smooth((yc - r.fadeFrom) / (r.bottom - r.fadeFrom)))
    if (k < 0.02) continue
    const innerL = Math.min(edge(yc, 0, 8), r.neckL)
    const innerR = Math.max(edge(yc, 16, 8), r.neckR)
    const cols: HairColumn[] = []
    const addSide = (x0: number, x1: number, side: 0 | 1) => {
      const cw = (x1 - x0) / HAIR_COLUMNS
      for (let i = 0; i < HAIR_COLUMNS; i++) {
        const x = x0 + i * cw
        const xc = x + cw / 2
        const fromFace = side === 0 ? innerL - xc : xc - innerR
        const fromOuter = side === 0 ? xc - r.leftOuter : r.rightOuter - xc
        const kc = smooth(fromFace / 22) * smooth(fromOuter / 14)
        if (kc > 0.02) cols.push({ x, w: cw, k: kc, side })
      }
    }
    addSide(r.leftOuter, innerL, 0)
    addSide(innerR, r.rightOuter, 1)
    bands.push({ y, h: HAIR_BAND, k, cols })
  }
  return { bands, amplitude: r.amplitude }
}

/** Least-squares fit of v = a + b*u + c*u^2. */
function fitQuadratic(samples: { u: number; v: number }[]): [number, number, number] {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0
  for (const { u, v } of samples) {
    s0 += 1; s1 += u; s2 += u * u; s3 += u * u * u; s4 += u * u * u * u
    t0 += v; t1 += u * v; t2 += u * u * v
  }
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  const A = [[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]]
  const D = det(A)
  if (Math.abs(D) < 1e-9) return [t0 / s0, 0, 0]
  const rep = (col: number) => A.map((row, i) => row.map((val, j) => (j === col ? [t0, t1, t2][i] : val)))
  return [det(rep(0)) / D, det(rep(1)) / D, det(rep(2)) / D]
}

function buildCells(a: Anchors): Cell[] {
  const cells: Cell[] = []
  const add = (zone: Cell['zone'], x0: number, y0: number, x1: number, y1: number, seamY?: number, seamHalf?: number, cx?: number) => {
    for (let y = y0; y < y1; y += CELL) {
      for (let x = x0; x < x1; x += CELL) {
        const seam =
          seamY !== undefined && seamHalf !== undefined && cx !== undefined
            ? y < seamY + CELL * 0.6 && y + CELL > seamY - CELL * 0.6 && Math.abs(x + CELL / 2 - cx) < seamHalf
            : false
        cells.push({ x0: x, y0: y, x1: x + CELL, y1: y + CELL, zone, seam })
      }
    }
  }
  a.eye.forEach((e, i) => {
    const rx = e.w * 0.95
    add(i === 0 ? 'eyeL' : 'eyeR', e.cx - rx, e.lid - e.w * 0.85, e.cx + rx, e.low + e.w * 0.45)
  })
  a.eye.forEach((e, i) => {
    const zone = i === 0 ? 'eyeL' : 'eyeR'
    const h = Math.max(1, e.low - e.lid)
    for (const c of cells) {
      if (c.zone !== zone) continue
      const mx = (c.x0 + c.x1) / 2
      const my = (c.y0 + c.y1) / 2
      c.ball = Math.abs(mx - e.cx) < e.w * 0.55 + CELL && my > e.lid - h * 0.4 - CELL && my < e.low + h * 0.4 + CELL
    }
  })
  a.brow.forEach((b, i) => add(i === 0 ? 'browL' : 'browR', b.cx - b.w * 0.7, b.cy - b.w * 0.32, b.cx + b.w * 0.7, b.cy + b.w * 0.34))
  const m = a.mouth
  add('mouth', m.cx - m.w * 0.95, m.top - m.w * 0.45, m.cx + m.w * 0.95, m.bottom + m.w * 0.85)
  return cells
}

export class PortraitWarp {
  private readonly a: Anchors
  private readonly cells: Cell[]
  /** Pixel size the mouth interior grows to at full opening. */
  readonly maxOpenPx: number

  private readonly hair: { bands: HairBand[]; amplitude: number } | null

  constructor(private readonly face: DoctorFaceData, hair?: HairSwayRegion) {
    this.a = buildAnchors(face)
    this.cells = buildCells(this.a)
    this.maxOpenPx = this.a.mouth.w * 0.27
    this.hair = hair ? buildHair(face, hair) : null
  }

  /** Displace one source point. Returns new [x, y]. */
  private displace(x: number, y: number, zone: Cell['zone'], pose: PortraitPose, openPx: number): [number, number] {
    const a = this.a
    if (zone === 'eyeL' || zone === 'eyeR') {
      const e = a.eye[zone === 'eyeL' ? 0 : 1]
      const gx = smooth(1 - Math.abs(x - e.cx) / (e.w * 0.95))
      let nx = x
      let ny: number
      if (y <= e.low) {
        // Upper lid and the skin just above it slide down onto the lower lid; the effect fades
        // out well before the brow so the brow never smears.
        const u = e.low - y
        const k = pose.blink * gx * (1 - smooth(u / (e.w * 0.6)))
        ny = e.low - u * (1 - k * 0.96)
      } else {
        const gy = smooth(1 - (y - e.low) / (e.w * 0.4))
        ny = y - pose.blink * gx * gy * e.w * 0.06
      }
      // Gaze: the iris and the white of the eye slide together inside the opening. The push fades
      // to nothing at the corners and lids, so the eye shape itself never changes.
      const gazeX = pose.gazeX ?? 0
      const gazeY = pose.gazeY ?? 0
      if (gazeX !== 0 || gazeY !== 0) {
        const mid = (e.lid + e.low) / 2
        const half = Math.max(1, (e.low - e.lid) / 2)
        const wgt = smooth(1 - Math.abs(x - e.cx) / (e.w * 0.52)) * smooth(1 - Math.abs(y - mid) / (half * 1.35))
        nx += gazeX * e.w * 0.12 * wgt
        ny += gazeY * e.w * 0.045 * wgt
      }
      return [nx, ny]
    }
    if (zone === 'browL' || zone === 'browR') {
      const b = a.brow[zone === 'browL' ? 0 : 1]
      const g = smooth(1 - Math.abs(x - b.cx) / (b.w * 0.7)) * smooth(1 - Math.abs(y - b.cy) / (b.w * 0.34))
      return [x, y - pose.brow * g * b.w * 0.07]
    }
    const m = a.mouth
    // Work in the mouth's own frame (u along the lip line, v across it) so a head tilt opens the
    // mouth perpendicular to the lips instead of straight down the screen.
    const dx = x - m.cx
    const dy = y - m.cy
    const u = dx * m.cos + dy * m.sin
    const v0 = -dx * m.sin + dy * m.cos
    const v = v0 - (m.a + m.b * u + m.c * u * u)
    // Jaw drop is strongest at the centre and fades toward the corners, which stay anchored.
    const wu = smooth(1 - Math.abs(u) / (m.innerHalf * 1.3))
    let dv = 0
    if (v >= 0) dv = openPx * wu * smooth(1 - (v / (m.w * 0.95)) * 0.8)
    else dv = -openPx * 0.16 * wu * smooth(1 - -v / (m.w * 0.42))
    const wideU = smooth(1 - Math.abs(u) / (m.w * 0.82))
    const gv = smooth(1 - Math.abs(v) / (m.w * 0.9))
    const smile = pose.smile ?? 0
    // Smile: lip corners rise and the mouth spreads a little; fades out at the centre of the lips.
    const corner = smooth(Math.min(1, Math.abs(u) / (m.w * 0.85))) * gv
    dv -= smile * m.w * 0.16 * corner
    const nu = u + u * ((pose.wide - 1) * wideU * gv + smile * 0.05 * corner)
    const nv0 = v0 + dv
    return [m.cx + nu * m.cos - nv0 * m.sin, m.cy + nu * m.sin + nv0 * m.cos]
  }

  /**
   * Draw the animated face regions on top of an already-drawn base photo.
   * `ctx` must be set up so that image px (0..width, 0..height) map to the photo's placement.
   */
  draw(ctx: CanvasRenderingContext2D, img: CanvasImageSource, pose: PortraitPose) {
    const a = this.a
    const m = a.mouth
    const openPx = Math.max(0, pose.open) * this.maxOpenPx
    const mouthOpen = openPx > 0.35

    const gazing = Math.abs(pose.gazeX ?? 0) > 0.02 || Math.abs(pose.gazeY ?? 0) > 0.02
    for (const c of this.cells) {
      // With no blink only the eyeball cells matter, and only while the eyes are looking aside.
      if (c.zone.startsWith('eye') && pose.blink < 0.01 && !(gazing && c.ball)) continue
      if (c.zone.startsWith('brow') && pose.brow < 0.01) continue
      if (c.zone === 'mouth' && !mouthOpen && Math.abs(pose.wide - 1) < 0.01 && Math.abs(pose.smile ?? 0) < 0.02) continue
      const p00 = this.displace(c.x0, c.y0, c.zone, pose, openPx)
      const p10 = this.displace(c.x1, c.y0, c.zone, pose, openPx)
      const p01 = this.displace(c.x0, c.y1, c.zone, pose, openPx)
      const p11 = this.displace(c.x1, c.y1, c.zone, pose, openPx)
      this.tri(ctx, img, [c.x0, c.y0], [c.x1, c.y0], [c.x0, c.y1], p00, p10, p01)
      this.tri(ctx, img, [c.x1, c.y0], [c.x1, c.y1], [c.x0, c.y1], p10, p11, p01)
    }
    ctx.globalAlpha = 1

    // Painted over the stretched lips: the interior sits exactly in the gap between the displaced
    // inner-lip landmarks.
    if (mouthOpen) this.drawMouthInterior(ctx, pose, openPx)

    if (pose.blink > 0.5) {
      // A soft lash line where the closed lid meets the cheek.
      for (const e of a.eye) {
        ctx.save()
        ctx.globalAlpha = Math.min(0.75, (pose.blink - 0.5) * 1.6)
        ctx.strokeStyle = '#2a1a17'
        ctx.lineWidth = Math.max(0.8, e.w * 0.055)
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(e.outer[0], e.outer[1] + e.w * 0.02)
        ctx.quadraticCurveTo(e.cx, e.low + e.w * 0.1, e.inner[0], e.inner[1] + e.w * 0.02)
        ctx.stroke()
        ctx.restore()
      }
    }
    void m
  }

  /**
   * Sway the hair beside the face. Call after the base photo is drawn and before `draw`.
   * Each horizontal band of hair is re-drawn from a slightly shifted part of the photo, so the
   * strands slide sideways while everything else stays put. The shift is zero at the face and
   * grows outward and downward, like hair swinging from the head. `t` is seconds.
   */
  drawHair(ctx: CanvasRenderingContext2D, img: CanvasImageSource, t: number) {
    const hair = this.hair
    if (!hair) return
    const sway = 0.72 + 0.28 * Math.sin(t * 0.43)
    for (const band of hair.bands) {
      for (const c of band.cols) {
        const wave =
          0.62 * Math.sin(t * 1.1 + band.y * 0.018 + c.side * 2.1) +
          0.38 * Math.sin(t * 2.3 + band.y * 0.031 + c.side * 0.7 + 1.3)
        const shift = hair.amplitude * sway * band.k * c.k * wave
        ctx.drawImage(img, c.x - shift, band.y, c.w, band.h, c.x, band.y, c.w, band.h)
      }
    }
  }

  /**
   * Draw only the two eyes (base photo + blink warp), clipped to the eye boxes, for compositing
   * over a live video of the SAME photo. The generated lip-sync video never blinks (only the jaw
   * is regenerated), so this overlay supplies the eyelids. Outside the clip the canvas stays
   * transparent and the video shows through; at the clip edge the warp displacement is ~0, so
   * the overlay's pixels equal the video's and the seam is invisible.
   * `ctx` must map image px to the photo's placement, as for `draw`.
   */
  drawEyesOnly(ctx: CanvasRenderingContext2D, img: CanvasImageSource, blink: number) {
    if (blink < 0.01) return
    ctx.save()
    ctx.beginPath()
    for (const e of this.a.eye) {
      const rx = e.w * 0.95 + CELL
      const top = e.lid - e.w * 0.85 - CELL
      const bottom = e.low + e.w * 0.45 + CELL
      ctx.rect(e.cx - rx, top, rx * 2, bottom - top)
    }
    ctx.clip()
    ctx.drawImage(img, 0, 0)
    // mouth and brow cells are skipped by draw() at open=0, wide=1, brow=0.
    this.draw(ctx, img, { blink, open: 0, wide: 1, brow: 0 })
    ctx.restore()
  }

  /**
   * Fill the gap between the displaced inner-lip landmarks with an anatomical mouth interior: dark cavity, tongue
   * (median groove, soft texture), upper and lower teeth shaped like real incisors, canines and premolars with
   * gum lines, translucent edges, highlights and the dark side corridors seen in real photos.
   */
  private drawMouthInterior(ctx: CanvasRenderingContext2D, pose: PortraitPose, openPx: number) {
    const pts = this.face.points
    const at = (i: number): [number, number] => this.displace(pts[i][0], pts[i][1], 'mouth', pose, openPx)
    // Inner-lip loop: left corner, upper edge L->R, right corner, lower edge R->L.
    const loop = [60, 61, 62, 63, 64, 65, 66, 67].map(at)
    const cx = loop.reduce((sum, q) => sum + q[0], 0) / loop.length
    const cy = loop.reduce((sum, q) => sum + q[1], 0) / loop.length
    // Pull the outline slightly inside the lips so interior colour never spills onto them.
    const ring = loop.map((q): [number, number] => [cx + (q[0] - cx) * 0.94, cy + (q[1] - cy) * 0.86])
    const top = Math.min(...ring.map((q) => q[1]))
    const bottom = Math.max(...ring.map((q) => q[1]))
    const left = Math.min(...ring.map((q) => q[0]))
    const right = Math.max(...ring.map((q) => q[0]))
    const h = Math.max(0.5, bottom - top)
    const w = Math.max(1, right - left)
    const open = Math.min(1, openPx / Math.max(1, this.maxOpenPx))
    const n = ring.length

    const lens = (pts2: [number, number][]) => {
      const p = new Path2D()
      const mid = (i: number): [number, number] => { const q = pts2[i % n], r = pts2[(i + 1) % n]; return [(q[0] + r[0]) / 2, (q[1] + r[1]) / 2] }
      const s = mid(n - 1)
      p.moveTo(s[0], s[1])
      for (let i = 0; i < n; i++) { const c = pts2[i], e = mid(i); p.quadraticCurveTo(c[0], c[1], e[0], e[1]) }
      p.closePath()
      return p
    }
    const path = lens(ring)

    // Soft-edged cavity so the opening melts into the lips: nearly black at the back, warm red toward the lips.
    ctx.save()
    ctx.filter = `blur(${Math.max(0.35, h * 0.05).toFixed(2)}px)`
    const base = ctx.createRadialGradient(cx, cy + h * 0.05, 0, cx, cy + h * 0.05, Math.max(w, h) * 0.62)
    base.addColorStop(0, '#120506')
    base.addColorStop(0.55, '#2c0e11')
    base.addColorStop(1, '#5b2327')
    ctx.fillStyle = base
    ctx.fill(path)
    ctx.restore()

    ctx.save()
    ctx.clip(lens(ring.map((q): [number, number] => [cx + (q[0] - cx) * 0.96, cy + (q[1] - cy) * 0.93])))
    ctx.filter = `blur(${Math.max(0.25, h * 0.03).toFixed(2)}px)`

    const half = w / 2
    // Where the tooth line sits at horizontal position x: it follows the lens (corners curve toward the middle of the opening).
    const upperAt = (x: number) => { const u = Math.min(1, Math.abs(x - cx) / half); return top + h * 0.34 * u * u }
    const lowerAt = (x: number) => { const u = Math.min(1, Math.abs(x - cx) / half); return bottom - h * 0.34 * u * u }

    // Tongue: sits low in the mouth, rises with opening. Rounded body, median groove, soft papillae texture.
    if (open > 0.12) {
      const tcx = cx, tcy = bottom - h * 0.02
      const rx = w * 0.36, ry = h * (0.42 + 0.25 * open)
      const tg = ctx.createRadialGradient(tcx, tcy - ry * 0.35, ry * 0.1, tcx, tcy, Math.max(rx, ry))
      tg.addColorStop(0, '#d98f93')
      tg.addColorStop(0.55, '#b9686e')
      tg.addColorStop(1, '#6e2c31')
      ctx.fillStyle = tg
      ctx.beginPath(); ctx.ellipse(tcx, tcy, rx, ry, 0, 0, Math.PI * 2); ctx.fill()
      // median groove
      ctx.strokeStyle = 'rgba(92,34,40,0.55)'
      ctx.lineWidth = Math.max(0.5, w * 0.006)
      ctx.beginPath(); ctx.moveTo(tcx, tcy - ry * 0.85); ctx.quadraticCurveTo(tcx + w * 0.004, tcy - ry * 0.3, tcx, tcy + ry * 0.2); ctx.stroke()
      // papillae: a fixed pseudo-random pattern, so the texture never shimmers between frames
      let seed = 1337
      const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
      ctx.fillStyle = 'rgba(236,178,180,0.28)'
      const dots = Math.round(18 + 40 * open)
      for (let i = 0; i < dots; i++) {
        const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 0.85
        const dx = tcx + Math.cos(a) * rx * r, dy = tcy + Math.sin(a) * ry * r
        ctx.beginPath(); ctx.arc(dx, dy, Math.max(0.35, w * 0.0035), 0, Math.PI * 2); ctx.fill()
      }
    }

    // One tooth. `dir` is +1 for upper teeth (root at the top, biting edge down) and -1 for lower teeth.
    const tooth = (x0: number, x1: number, rootY: number, edgeY: number, dir: 1 | -1, shade: number) => {
      const r = Math.min((x1 - x0) * 0.32, Math.abs(edgeY - rootY) * 0.45)
      const p = new Path2D()
      p.moveTo(x0, rootY)
      p.lineTo(x1, rootY)
      p.lineTo(x1, edgeY - dir * r)
      p.quadraticCurveTo(x1, edgeY, x1 - r * dir, edgeY)
      p.lineTo(x0 + r * dir, edgeY)
      p.quadraticCurveTo(x0, edgeY, x0, edgeY - dir * r)
      p.closePath()
      const g = ctx.createLinearGradient(0, rootY, 0, edgeY)
      g.addColorStop(0, `rgba(${196 - shade},${178 - shade},${150 - shade},1)`) // warm, darker near the gum
      g.addColorStop(0.35, `rgba(${246 - shade},${240 - shade},${228 - shade},1)`)
      g.addColorStop(0.85, `rgba(${240 - shade},${234 - shade},${222 - shade},1)`)
      g.addColorStop(1, `rgba(${214 - shade},${214 - shade},${210 - shade},0.92)`) // thin translucent biting edge
      ctx.fillStyle = g
      ctx.fill(p)
      // rounded body: darker toward each side so every tooth reads as a convex form
      const sg = ctx.createLinearGradient(x0, 0, x1, 0)
      sg.addColorStop(0, 'rgba(88,58,48,0.22)')
      sg.addColorStop(0.28, 'rgba(88,58,48,0)')
      sg.addColorStop(0.72, 'rgba(88,58,48,0)')
      sg.addColorStop(1, 'rgba(88,58,48,0.22)')
      ctx.fillStyle = sg
      ctx.fill(p)
      // soft highlight streak
      const hw = (x1 - x0) * 0.18
      ctx.fillStyle = 'rgba(255,255,255,0.32)'
      ctx.beginPath(); ctx.ellipse(x0 + (x1 - x0) * 0.36, rootY + (edgeY - rootY) * 0.42, hw, Math.abs(edgeY - rootY) * 0.22, 0, 0, Math.PI * 2); ctx.fill()
      // dark seam between neighbouring teeth
      ctx.strokeStyle = 'rgba(80,38,34,0.24)'
      ctx.lineWidth = Math.max(0.3, w * 0.003)
      ctx.stroke(p)
    }

    // A row of teeth across the front of the arch: central incisors widest, then lateral, canine, premolars.
    const row = (dir: 1 | -1, spanFactor: number, widths: number[], lengths: number[], maxLen: number, shade: number) => {
      const sum = widths.reduce((s, v) => s + v, 0) * 2
      const span = w * spanFactor
      const unit = span / sum
      const lineAt = dir === 1 ? upperAt : lowerAt
      for (const side of [-1, 1]) {
        let x = cx
        for (let i = 0; i < widths.length; i++) {
          const tw = widths[i] * unit
          const xa = side === 1 ? x : x - tw
          const xb = side === 1 ? x + tw : x
          const mx = (xa + xb) / 2
          const root = lineAt(mx)
          const edge = root + dir * maxLen * lengths[i]
          tooth(xa - 0.1, xb + 0.1, root, edge, dir, shade + i * 5)
          x += side * tw
        }
      }
    }

    // Gum above the upper teeth and below the lower teeth, then the teeth on top of it.
    const gumG = (y0: number, y1: number) => { const g = ctx.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, '#9c4a50'); g.addColorStop(1, '#d28a8c'); return g }
    const widths = [1.0, 0.8, 0.82, 0.62, 0.52]
    if (open > 0.08) {
      const upLen = Math.min(h * 0.55, Math.max(1.2, openPx * 0.95))
      ctx.fillStyle = gumG(top - 1, top + upLen * 0.45)
      ctx.fillRect(left, top - 1, w, upLen * 0.38 + 1)
      row(1, 0.8, widths, [1, 0.88, 0.97, 0.72, 0.66], upLen, 0)
    }
    if (open > 0.5) {
      const loLen = Math.min(h * 0.34, (open - 0.45) * h * 0.7)
      ctx.fillStyle = gumG(bottom + 1, bottom - loLen * 0.45)
      ctx.fillRect(left, bottom - loLen * 0.34, w, loLen * 0.4 + 1)
      row(-1, 0.66, [0.7, 0.62, 0.72, 0.58, 0.5], [1, 0.95, 1, 0.8, 0.72], loLen, 6)
    }

    // Dark corridors at both corners: teeth recede into shadow, as in real photographs.
    const sd = ctx.createLinearGradient(left, 0, right, 0)
    sd.addColorStop(0, 'rgba(26,8,10,0.88)')
    sd.addColorStop(0.2, 'rgba(26,8,10,0)')
    sd.addColorStop(0.8, 'rgba(26,8,10,0)')
    sd.addColorStop(1, 'rgba(26,8,10,0.88)')
    ctx.fillStyle = sd
    ctx.fillRect(left - 2, top - 2, w + 4, h + 4)
    // The upper lip casts a shadow into the mouth; the lower edge falls off to dark as well.
    const shade = ctx.createLinearGradient(0, top, 0, top + h * 0.5)
    shade.addColorStop(0, 'rgba(10,2,3,0.5)')
    shade.addColorStop(1, 'rgba(10,2,3,0)')
    ctx.fillStyle = shade
    ctx.fillRect(left - 2, top - 2, w + 4, h * 0.5 + 2)
    const shadeLow = ctx.createLinearGradient(0, bottom - h * 0.3, 0, bottom)
    shadeLow.addColorStop(0, 'rgba(10,2,3,0)')
    shadeLow.addColorStop(1, 'rgba(10,2,3,0.4)')
    ctx.fillStyle = shadeLow
    ctx.fillRect(left - 2, bottom - h * 0.3, w + 4, h * 0.3 + 2)
    ctx.restore()
  }

  /** Draw the source triangle (s0,s1,s2) of `img` onto the destination triangle (d0,d1,d2). */
  private tri(
    ctx: CanvasRenderingContext2D,
    img: CanvasImageSource,
    s0: number[], s1: number[], s2: number[],
    d0: number[], d1: number[], d2: number[],
  ) {
    // Inflate the destination triangle a hair so neighbouring triangles overlap (no seams).
    const cx = (d0[0] + d1[0] + d2[0]) / 3
    const cy = (d0[1] + d1[1] + d2[1]) / 3
    const grow = (d: number[]) => {
      const vx = d[0] - cx
      const vy = d[1] - cy
      const l = Math.hypot(vx, vy) || 1
      return [d[0] + (vx / l) * 0.45, d[1] + (vy / l) * 0.45]
    }
    const g0 = grow(d0), g1 = grow(d1), g2 = grow(d2)
    const den = s0[0] * (s1[1] - s2[1]) + s1[0] * (s2[1] - s0[1]) + s2[0] * (s0[1] - s1[1])
    if (Math.abs(den) < 1e-9) return
    const a = (d0[0] * (s1[1] - s2[1]) + d1[0] * (s2[1] - s0[1]) + d2[0] * (s0[1] - s1[1])) / den
    const b = (d0[1] * (s1[1] - s2[1]) + d1[1] * (s2[1] - s0[1]) + d2[1] * (s0[1] - s1[1])) / den
    const c = (d0[0] * (s2[0] - s1[0]) + d1[0] * (s0[0] - s2[0]) + d2[0] * (s1[0] - s0[0])) / den
    const d = (d0[1] * (s2[0] - s1[0]) + d1[1] * (s0[0] - s2[0]) + d2[1] * (s1[0] - s0[0])) / den
    const e = (d0[0] * (s1[0] * s2[1] - s2[0] * s1[1]) + d1[0] * (s2[0] * s0[1] - s0[0] * s2[1]) + d2[0] * (s0[0] * s1[1] - s1[0] * s0[1])) / den
    const f = (d0[1] * (s1[0] * s2[1] - s2[0] * s1[1]) + d1[1] * (s2[0] * s0[1] - s0[0] * s2[1]) + d2[1] * (s0[0] * s1[1] - s1[0] * s0[1])) / den
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(g0[0], g0[1])
    ctx.lineTo(g1[0], g1[1])
    ctx.lineTo(g2[0], g2[1])
    ctx.closePath()
    ctx.clip()
    ctx.transform(a, b, c, d, e, f)
    ctx.drawImage(img, 0, 0)
    ctx.restore()
  }
}
