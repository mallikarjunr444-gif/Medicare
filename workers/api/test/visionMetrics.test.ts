import { describe, expect, it } from "vitest";
import {
  BlinkTracker, SessionAggregator, describeSummary, earOf, estimateGaze, eyeAspectRatio, headPoseFromMatrix, irisPosition, upperBody, FACE, type Pt,
} from "../../../frontend/lib/vision/metrics";

/** A synthetic 478-point face whose eye openness and iris position we control. */
function face(open = 0.3, irisH = 0.5): Pt[] {
  const lm: Pt[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const eye = (idx: readonly number[], cx: number, half: number) => {
    const [outer, u1, u2, inner, l2, l1] = idx;
    lm[outer] = { x: cx - half, y: 0.4 }; lm[inner] = { x: cx + half, y: 0.4 };
    const h = half * open;
    lm[u1] = { x: cx - half / 3, y: 0.4 - h }; lm[u2] = { x: cx + half / 3, y: 0.4 - h };
    lm[l1] = { x: cx - half / 3, y: 0.4 + h }; lm[l2] = { x: cx + half / 3, y: 0.4 + h };
  };
  eye(FACE.rightEye, 0.35, 0.05); eye(FACE.leftEye, 0.65, 0.05);
  const place = (iris: number, a: number, b: number, top: number, bottom: number) => {
    const left = Math.min(lm[a].x, lm[b].x), right = Math.max(lm[a].x, lm[b].x);
    lm[iris] = { x: left + (right - left) * irisH, y: 0.4 }; lm[top] = { x: lm[iris].x, y: 0.4 - 0.02 }; lm[bottom] = { x: lm[iris].x, y: 0.4 + 0.02 };
  };
  place(FACE.rightIris, 33, 133, FACE.rightLid.top, FACE.rightLid.bottom); place(FACE.leftIris, 362, 263, FACE.leftLid.top, FACE.leftLid.bottom);
  lm[10] = { x: 0.5, y: 0.2 }; lm[152] = { x: 0.5, y: 0.8 }; lm[234] = { x: 0.3, y: 0.5 }; lm[454] = { x: 0.7, y: 0.5 };
  return lm;
}
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe("eye aspect ratio", () => {
  it("falls when the eye closes", () => {
    expect(eyeAspectRatio(face(0.5), FACE.rightEye)).toBeGreaterThan(eyeAspectRatio(face(0.1), FACE.rightEye));
    expect(earOf(face(0.5))).toBeCloseTo(0.5, 1);
    expect(earOf(face(0.0))).toBeCloseTo(0, 2);
  });
});

describe("blink tracking", () => {
  const run = (frames: number[], dtMs = 33) => { const b = new BlinkTracker(); let t = 0; for (const e of frames) { b.update(t, e); t += dtMs; } return b; };
  const open = (n: number) => Array(n).fill(0.3);
  it("counts a normal blink and ignores noise", () => {
    expect(run([...open(60), 0.05, 0.05, 0.05, ...open(30)]).count).toBe(1);
    expect(run([...open(60), 0.05, ...open(30)]).count).toBe(0); // one frame (33 ms) is too short to be a blink
    expect(run(open(100)).count).toBe(0);
  });
  it("does not count long closures as blinks", () => {
    const b = run([...open(60), ...Array(30).fill(0.05), ...open(30)]); // ~1 s closed
    expect(b.count).toBe(0); expect(b.longClosures).toBe(1);
  });
  it("tracks intervals and adapts to a person's own open-eye level", () => {
    const b = run([...open(40), 0.05, 0.05, 0.05, ...open(40), 0.05, 0.05, 0.05, ...open(10)]);
    expect(b.count).toBe(2); expect(b.intervalsMs).toHaveLength(1);
    const small = run([...Array(60).fill(0.22), 0.1, 0.1, 0.1, ...Array(20).fill(0.22)]); // smaller eyes still register
    expect(small.count).toBe(1);
  });
  it("a face-lost gap is never a blink", () => {
    const b = new BlinkTracker(); for (let i = 0; i < 60; i++) b.update(i * 33, 0.3);
    b.update(2000, 0.05); b.reset(); b.update(5000, 0.3);
    expect(b.count).toBe(0);
  });
});

describe("gaze and head pose", () => {
  it("reads iris position across the eye", () => {
    expect(irisPosition(face(0.3, 0.5))!.h).toBeCloseTo(0.5, 2);
    expect(irisPosition(face(0.3, 0.1))!.h).toBeCloseTo(0.1, 2);
    expect(irisPosition(face(0.3, 0.9))!.h).toBeCloseTo(0.9, 2);
    expect(irisPosition([])).toBeNull();
  });
  it("identity matrix is facing the camera; a yawed matrix is reported as a turn", () => {
    expect(headPoseFromMatrix(identity())).toEqual({ pitch: 0, yaw: -0, roll: 0 });
    const a = (30 * Math.PI) / 180; // rotation about Y, column-major
    const yawed = [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1];
    expect(Math.abs(headPoseFromMatrix(yawed)!.yaw)).toBeCloseTo(30, 3);
    expect(headPoseFromMatrix(undefined)).toBeNull(); expect(headPoseFromMatrix([1, 2])).toBeNull();
  });
  it("toward screen needs both a forward head and centred eyes; unknown without data", () => {
    expect(estimateGaze({ h: 0.5, v: 0.5 }, { pitch: 3, yaw: 4 })).toBe("toward_screen");
    expect(estimateGaze({ h: 0.1, v: 0.5 }, { pitch: 3, yaw: 4 })).toBe("away_from_screen");
    expect(estimateGaze({ h: 0.5, v: 0.5 }, { pitch: 3, yaw: 50 })).toBe("away_from_screen");
    expect(estimateGaze(null, { pitch: 0, yaw: 0 })).toBe("unknown");
  });
});

describe("upper body", () => {
  const p = (v = 0.9) => { const a = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 })); a[11] = { x: 0.6, y: 0.6, visibility: v }; a[12] = { x: 0.4, y: 0.6, visibility: v }; return a; };
  it("needs both shoulders clearly visible", () => {
    expect(upperBody(p())!.width).toBeCloseTo(0.2, 3);
    expect(upperBody(p(0.2))).toBeNull(); expect(upperBody(undefined)).toBeNull();
  });
});

describe("session aggregation", () => {
  it("summarises only what was measured, flags interruptions and multiple faces", () => {
    const s = new SessionAggregator(); let t = 0;
    const frame = (faces: number, lm?: Pt[]) => s.update({ t: (t += 100), faces, landmarks: lm, matrix: identity(), luma: 120 });
    for (let i = 0; i < 50; i++) frame(1, face(0.3));
    frame(1, face(0.0)); frame(1, face(0.0)); frame(1, face(0.0)); // a blink
    for (let i = 0; i < 20; i++) frame(1, face(0.3));
    for (let i = 0; i < 10; i++) frame(0); // face lost
    for (let i = 0; i < 10; i++) frame(2, face(0.3)); // two faces
    const sum = s.summary();
    expect(sum.framesAnalysed).toBe(93);
    expect(sum.face.visibleFraction).toBeCloseTo(83 / 93, 3);
    expect(sum.face.trackingInterruptions).toBe(1);
    expect(sum.face.multipleFacesFraction).toBeCloseTo(10 / 93, 3);
    expect(sum.blinks.count).toBe(1);
    expect(sum.posture).toBeNull(); expect(sum.facialMovement).toBeNull(); // not measured -> not reported
    expect(sum.gaze!.towardScreenFraction).toBe(1);
  });
  it("reports 'poor' quality and no readings when no face is present", () => {
    const s = new SessionAggregator(); let live = s.live; for (let i = 0; i < 40; i++) live = s.update({ t: i * 100, faces: 0 });
    expect(live.faceVisible).toBe(false); expect(live.quality).toBe("poor"); expect(live.gaze).toBe("unknown");
  });
  it("detects dim lighting and an out-of-frame face", () => {
    const s = new SessionAggregator(); const lm = face(0.3).map((q) => ({ ...q, x: q.x + 0.4 }));
    const live = s.update({ t: 100, faces: 1, landmarks: lm, luma: 20 });
    expect(live.lighting).toBe("dim"); expect(live.inFrame).toBe(false);
  });
  it("descriptions never interpret mental state", () => {
    const s = new SessionAggregator(); for (let i = 0; i < 80; i++) s.update({ t: i * 100, faces: 1, landmarks: face(0.3), matrix: identity(), luma: 20 });
    const text = describeSummary(s.summary()).join(" ");
    expect(text).toMatch(/not a diagnosis/);
    expect(text).not.toMatch(/depress|anxi|lying|dishonest|suicid|unstable|sad\b|emotion detected|trauma/i);
    expect(describeSummary(new SessionAggregator().summary())).toEqual(["No camera frames were analysed."]);
  });
});
