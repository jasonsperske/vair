import { Euler, Object3D, Plane, Quaternion, Raycaster, Vector3 } from "three";
import type { MeasurementBundle, TranscriptWord } from "@vair/shared";
import { DEICTIC_TOKENS } from "@vair/shared";
import type { HandSide, PoseRingBuffer, PoseSample } from "../core/pose-buffer.js";

/**
 * plan.md §6.4 — deixis resolution.
 *
 * For each deictic token, look up the buffered pose at that token's timestamp
 * and produce a measurement bundle containing EVERY candidate measurement.
 * Claude picks which one the linguistic form implies.
 *
 * Do not add heuristics here that decide "this must mean height" — that is
 * interpretation, the client only does physics. The one judgement call we do
 * make is which hand was doing the pointing, documented below.
 */

/** Words that extend a bare demonstrative into a measurement phrase. */
const EXTENDERS = new Set([
  "high",
  "tall",
  "big",
  "small",
  "wide",
  "long",
  "far",
  "way",
  "much",
  "one",
  "here",
  "there",
  "size",
]);

export type DeicticToken = {
  token: string;
  /** Seconds from utterance start, straight from the STT word timings. */
  start: number;
};

/**
 * Extract deictic tokens with their word-level start times. Multi-word forms
 * ("this high", "like this") are folded into one token so the model sees the
 * phrase it needs, and the time used is the START of the demonstrative — the
 * deictic moment is when the user said "this", not when they finished the noun.
 */
export function findDeicticTokens(words: readonly TranscriptWord[]): DeicticToken[] {
  const out: DeicticToken[] = [];
  const base = new Set<string>(DEICTIC_TOKENS);

  for (let i = 0; i < words.length; i++) {
    const w = normalise(words[i].word);
    if (!base.has(w)) continue;

    let token = w;
    const next = words[i + 1] ? normalise(words[i + 1].word) : "";
    if (next && EXTENDERS.has(next)) {
      token = `${w} ${next}`;
      i++;
    }
    if (i > 0 && normalise(words[i - 1].word) === "like") token = `like ${token}`;

    out.push({ token, start: words[i].start });
  }
  return out;
}

function normalise(word: string): string {
  return word.toLowerCase().replace(/[^a-z]/g, "");
}

export type ResolveOptions = {
  buffer: PoseRingBuffer;
  /** Meshes eligible for a point hit. Ground is handled separately. */
  targets: Object3D[];
  /** Map from a hit Object3D back to a scene object id. */
  objectIdOf(o: Object3D): string | null;
  /** The hand that latched the utterance — the tie-breaker, not the decider. */
  preferredSide: HandSide;
};

const raycaster = new Raycaster();
const groundPlane = new Plane(new Vector3(0, 1, 0), 0);
const scratchDir = new Vector3();
const scratchOrigin = new Vector3();
const scratchHit = new Vector3();
const scratchEuler = new Euler();

/**
 * The fingertip is usually ON the surface at the deictic moment, so a ray cast
 * forward from the tip has already passed through it. Back the origin up along
 * the finger and cast a short way past the tip instead.
 */
const RAY_BACKOFF_M = 0.15;
const RAY_LENGTH_M = 0.45;

export function resolveMeasurement(
  token: string,
  tokenXrTime: number,
  opts: ResolveOptions,
): MeasurementBundle | null {
  const sample = opts.buffer.sampleAt(tokenXrTime);
  if (!sample) return null;

  const side = chooseHand(sample, tokenXrTime, opts);
  const hand = side === "left" ? sample.left : side === "right" ? sample.right : null;

  const pointHit = hand ? castFromFinger(hand.tip, hand.quaternion, opts) : null;

  const gazeDir = new Vector3(0, 0, -1).applyQuaternion(sample.headQuaternion);
  scratchEuler.setFromQuaternion(sample.headQuaternion, "YXZ");

  return {
    tokenTime: tokenXrTime,
    token,
    hand: side,
    pointHit,
    // local-floor reference space puts y=0 at the physical floor, so the tip's
    // y IS the height above the floor. No offset, no calibration step.
    handHeightAboveFloor: hand ? hand.tip.y : 0,
    twoHandSpan:
      sample.left.valid && sample.right.valid
        ? sample.left.tip.distanceTo(sample.right.tip)
        : null,
    gazeRay: {
      origin: toTuple(sample.headPosition),
      direction: toTuple(gazeDir),
    },
    palmNormal: hand
      ? toTuple(new Vector3(0, -1, 0).applyQuaternion(hand.quaternion))
      : [0, -1, 0],
    // plan.md §9 — "further back" resolves against the user's facing direction
    // at the moment of utterance, from the ring buffer. Not object-forward, not
    // world space.
    headYaw: scratchEuler.y,
    headPosition: toTuple(sample.headPosition),
    trackingConfidence: side === "none" ? 0 : opts.buffer.confidence(tokenXrTime, side),
  };
}

/**
 * Which hand was doing the deixis. A hand that is touching something wins,
 * because that is what "here" means; otherwise the hand that moved most in the
 * half second before the word, because the other one is resting; otherwise the
 * hand that latched the utterance.
 */
function chooseHand(
  sample: PoseSample,
  tokenXrTime: number,
  opts: ResolveOptions,
): HandSide | "none" {
  const l = sample.left.valid;
  const r = sample.right.valid;
  if (!l && !r) return "none";
  if (l !== r) return l ? "left" : "right";

  const lHit = castFromFinger(sample.left.tip, sample.left.quaternion, opts);
  const rHit = castFromFinger(sample.right.tip, sample.right.quaternion, opts);
  if (!!lHit !== !!rHit) return lHit ? "left" : "right";

  const lm = opts.buffer.motionMagnitude(tokenXrTime, "left");
  const rm = opts.buffer.motionMagnitude(tokenXrTime, "right");
  if (Math.abs(lm - rm) > 0.05) return lm > rm ? "left" : "right";

  return opts.preferredSide;
}

function castFromFinger(
  tip: Vector3,
  quat: Quaternion,
  opts: ResolveOptions,
): MeasurementBundle["pointHit"] {
  scratchDir.set(0, 0, -1).applyQuaternion(quat).normalize();
  scratchOrigin.copy(tip).addScaledVector(scratchDir, -RAY_BACKOFF_M);

  raycaster.set(scratchOrigin, scratchDir);
  raycaster.far = RAY_LENGTH_M + RAY_BACKOFF_M;
  const hits = raycaster.intersectObjects(opts.targets, true);
  const hit = hits[0];
  if (hit) {
    const normal = hit.face
      ? hit.face.normal.clone().applyQuaternion(hit.object.getWorldQuaternion(new Quaternion()))
      : new Vector3(0, 1, 0);
    return {
      position: toTuple(hit.point),
      normal: toTuple(normal),
      objectId: opts.objectIdOf(hit.object),
    };
  }

  // Nothing placed yet? The floor is still a surface you can point at, and in an
  // empty void it is the only one. objectId stays null.
  const rayHitGround = raycaster.ray.intersectPlane(groundPlane, scratchHit);
  if (rayHitGround && scratchOrigin.distanceTo(scratchHit) <= raycaster.far) {
    return { position: toTuple(scratchHit), normal: [0, 1, 0], objectId: null };
  }
  return null;
}

function toTuple(v: Vector3): [number, number, number] {
  return [v.x, v.y, v.z];
}
