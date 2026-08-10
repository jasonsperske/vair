import { Quaternion, Vector3 } from "three";

/**
 * plan.md §6.1 — pose ring buffer.
 *
 * Every XR frame we record head and both hands into a fixed-size circular
 * buffer covering the last ~10 seconds, so that when a transcript comes back we
 * can ask "where was the hand when the word 'here' was spoken" rather than
 * "where is the hand now". By the time STT returns, the hand has moved.
 *
 * NEVER ALLOCATE IN THE HOT LOOP. Everything below is flat typed arrays and
 * preallocated scratch. No objects, no closures, no array literals in `record`.
 */

/**
 * ~22s at 90Hz, ~17s at 120Hz. Power of two for cheap masking.
 *
 * This must comfortably exceed the 15s utterance cap in §7 PLUS the STT round
 * trip, because the token we look up is the FIRST word of the utterance and we
 * look it up only after the transcript returns. At 1024 (11s at 90Hz) a deictic
 * word early in a long sentence had already fallen out of the buffer by the time
 * it was needed. 2048 slots is 256KB — irrelevant next to a single glTF.
 */
const CAPACITY = 2048;
const MASK = CAPACITY - 1;

/** How far past the newest sample a query may sit before it is out of range. */
const FUTURE_TOLERANCE_MS = 50;

// Per-sample layout, in floats.
const HEAD_POS = 0; // 3
const HEAD_QUAT = 3; // 4
const L_BASE = 7; //   valid, isHand, tip(3), quat(4)  = 9
const R_BASE = 16; //  same                             = 9
const STRIDE = 32; // padded from 25 for alignment

const OFF_VALID = 0;
const OFF_IS_HAND = 1;
const OFF_TIP = 2; // 3
const OFF_QUAT = 5; // 4

export type HandSide = "left" | "right";

/** A decoded sample. Reused — copy out anything you intend to keep. */
export type PoseSample = {
  xrTime: number;
  headPosition: Vector3;
  headQuaternion: Quaternion;
  left: HandPose;
  right: HandPose;
};

export type HandPose = {
  valid: boolean;
  /** True when the pose came from hand tracking, false when from a controller. */
  isHand: boolean;
  /** Index fingertip for hands; the controller's pointer origin otherwise. */
  tip: Vector3;
  /** Joint orientation. -Z distal, +Y out of the back of the hand (WebXR spec). */
  quaternion: Quaternion;
};

function emptyHandPose(): HandPose {
  return { valid: false, isHand: false, tip: new Vector3(), quaternion: new Quaternion() };
}

export class PoseRingBuffer {
  private readonly times = new Float64Array(CAPACITY);
  private readonly data = new Float32Array(CAPACITY * STRIDE);
  /** Monotonic count of samples ever written. Logical order, not slot order. */
  private count = 0;

  private readonly scratch: PoseSample = {
    xrTime: 0,
    headPosition: new Vector3(),
    headQuaternion: new Quaternion(),
    left: emptyHandPose(),
    right: emptyHandPose(),
  };
  private readonly qa = new Quaternion();
  private readonly qb = new Quaternion();

  get length(): number {
    return Math.min(this.count, CAPACITY);
  }

  get newestTime(): number {
    return this.count === 0 ? 0 : this.times[(this.count - 1) & MASK];
  }

  get oldestTime(): number {
    return this.count === 0 ? 0 : this.times[this.oldestIndex() & MASK];
  }

  /** Begin a sample. Returns the base float offset for the writers below. */
  record(xrTime: number, headPos: Vector3, headQuat: Quaternion): number {
    const slot = this.count & MASK;
    const base = slot * STRIDE;
    const d = this.data;

    this.times[slot] = xrTime;
    d[base + HEAD_POS] = headPos.x;
    d[base + HEAD_POS + 1] = headPos.y;
    d[base + HEAD_POS + 2] = headPos.z;
    d[base + HEAD_QUAT] = headQuat.x;
    d[base + HEAD_QUAT + 1] = headQuat.y;
    d[base + HEAD_QUAT + 2] = headQuat.z;
    d[base + HEAD_QUAT + 3] = headQuat.w;

    // Hands default to invalid; recordHand overwrites when tracked.
    d[base + L_BASE + OFF_VALID] = 0;
    d[base + R_BASE + OFF_VALID] = 0;

    this.count++;
    return base;
  }

  recordHand(
    base: number,
    side: HandSide,
    isHand: boolean,
    tip: Vector3,
    quat: Quaternion,
  ): void {
    const o = base + (side === "left" ? L_BASE : R_BASE);
    const d = this.data;
    d[o + OFF_VALID] = 1;
    d[o + OFF_IS_HAND] = isHand ? 1 : 0;
    d[o + OFF_TIP] = tip.x;
    d[o + OFF_TIP + 1] = tip.y;
    d[o + OFF_TIP + 2] = tip.z;
    d[o + OFF_QUAT] = quat.x;
    d[o + OFF_QUAT + 1] = quat.y;
    d[o + OFF_QUAT + 2] = quat.z;
    d[o + OFF_QUAT + 3] = quat.w;
  }

  /**
   * Interpolated pose at an arbitrary XR time. Interpolation matters: at 90Hz a
   * word boundary lands mid-frame and a hand moving at 1m/s travels 11mm between
   * samples — a fifth of the 5cm accuracy budget in the §6 acceptance test.
   *
   * The returned object is reused. Copy anything you keep.
   */
  sampleAt(xrTime: number): PoseSample | null {
    const n = this.length;
    if (n === 0) return null;

    // Older than anything we still hold: return null rather than clamping.
    // Clamping would hand back a confident pose from whenever the buffer starts,
    // which is a wrong answer wearing the costume of a right one — the model
    // would place the object metres away and nothing upstream would know.
    if (xrTime < this.oldestTime) return null;
    if (xrTime > this.newestTime + FUTURE_TOLERANCE_MS) return null;

    const hi = this.indexAtOrAfter(xrTime);
    if (hi === null) {
      // Within tolerance of the newest sample — clamp. A token time a few
      // milliseconds past the last recorded frame is ordinary jitter.
      return this.decode(this.count - 1, this.count - 1, 0);
    }
    if (hi === this.oldestIndex()) {
      return this.decode(hi, hi, 0);
    }
    const lo = hi - 1;
    const tLo = this.times[lo & MASK];
    const tHi = this.times[hi & MASK];
    const span = tHi - tLo;
    const alpha = span > 0 ? (xrTime - tLo) / span : 0;
    return this.decode(lo, hi, Math.min(1, Math.max(0, alpha)));
  }

  /**
   * plan.md §6 — trackingConfidence. Fraction of buffered samples within
   * ±windowMs of the token that had valid tracking for this hand. A hand that
   * flickered through the deictic moment produces a low number, and the model
   * gets to weigh it rather than the client silently trusting one frame.
   */
  confidence(xrTime: number, side: HandSide, windowMs = 100): number {
    const n = this.length;
    if (n === 0) return 0;
    const off = (side === "left" ? L_BASE : R_BASE) + OFF_VALID;
    let seen = 0;
    let valid = 0;
    for (let i = this.oldestIndex(); i < this.count; i++) {
      const slot = i & MASK;
      if (Math.abs(this.times[slot] - xrTime) > windowMs) continue;
      seen++;
      if (this.data[slot * STRIDE + off] === 1) valid++;
    }
    return seen === 0 ? 0 : valid / seen;
  }

  /** Displacement of a hand's tip over the given window, ending at xrTime. */
  motionMagnitude(xrTime: number, side: HandSide, windowMs = 400): number {
    const a = this.sampleAt(xrTime - windowMs);
    if (!a) return 0;
    const from = (side === "left" ? a.left : a.right).tip.clone();
    const b = this.sampleAt(xrTime);
    if (!b) return 0;
    const to = side === "left" ? b.left.tip : b.right.tip;
    return from.distanceTo(to);
  }

  private oldestIndex(): number {
    return Math.max(0, this.count - CAPACITY);
  }

  /** Smallest logical index whose time is >= xrTime, or null if none. */
  private indexAtOrAfter(xrTime: number): number | null {
    let lo = this.oldestIndex();
    let hi = this.count - 1;
    if (this.times[hi & MASK] < xrTime) return null;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid & MASK] < xrTime) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private decode(lo: number, hi: number, alpha: number): PoseSample {
    const d = this.data;
    const a = (lo & MASK) * STRIDE;
    const b = (hi & MASK) * STRIDE;
    const s = this.scratch;

    s.xrTime = lerp(this.times[lo & MASK], this.times[hi & MASK], alpha);

    s.headPosition.set(
      lerp(d[a + HEAD_POS], d[b + HEAD_POS], alpha),
      lerp(d[a + HEAD_POS + 1], d[b + HEAD_POS + 1], alpha),
      lerp(d[a + HEAD_POS + 2], d[b + HEAD_POS + 2], alpha),
    );
    this.slerpInto(s.headQuaternion, d, a + HEAD_QUAT, b + HEAD_QUAT, alpha);

    this.decodeHand(s.left, d, a + L_BASE, b + L_BASE, alpha);
    this.decodeHand(s.right, d, a + R_BASE, b + R_BASE, alpha);
    return s;
  }

  private decodeHand(
    out: HandPose,
    d: Float32Array,
    a: number,
    b: number,
    alpha: number,
  ): void {
    const validA = d[a + OFF_VALID] === 1;
    const validB = d[b + OFF_VALID] === 1;
    out.valid = validA || validB;
    if (!out.valid) return;

    // If only one side of the interval is tracked, snap to it rather than
    // interpolating toward a zeroed slot — that would drag the tip to the origin.
    const t = validA && validB ? alpha : validA ? 0 : 1;
    const src = t === 1 ? b : a;
    out.isHand = d[src + OFF_IS_HAND] === 1;

    if (validA && validB) {
      out.tip.set(
        lerp(d[a + OFF_TIP], d[b + OFF_TIP], t),
        lerp(d[a + OFF_TIP + 1], d[b + OFF_TIP + 1], t),
        lerp(d[a + OFF_TIP + 2], d[b + OFF_TIP + 2], t),
      );
      this.slerpInto(out.quaternion, d, a + OFF_QUAT, b + OFF_QUAT, t);
    } else {
      out.tip.set(d[src + OFF_TIP], d[src + OFF_TIP + 1], d[src + OFF_TIP + 2]);
      out.quaternion.set(
        d[src + OFF_QUAT],
        d[src + OFF_QUAT + 1],
        d[src + OFF_QUAT + 2],
        d[src + OFF_QUAT + 3],
      );
    }
  }

  private slerpInto(
    out: Quaternion,
    d: Float32Array,
    a: number,
    b: number,
    alpha: number,
  ): void {
    this.qa.set(d[a], d[a + 1], d[a + 2], d[a + 3]);
    this.qb.set(d[b], d[b + 1], d[b + 2], d[b + 3]);
    out.copy(this.qa).slerp(this.qb, alpha);
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export const poseBuffer = new PoseRingBuffer();
