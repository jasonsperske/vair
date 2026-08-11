import { Quaternion, Vector3, type Group, type WebGLRenderer } from "three";
import type { HandSide } from "../core/pose-buffer.js";

/**
 * plan.md §7 — thumb-to-middle-finger touch.
 *
 * We detect the POSE (fingertip distance under a threshold, with hysteresis and
 * a short dwell), not the snap motion. Snap detection fires on incidental
 * gestures and misses slow deliberate ones.
 *
 * The controller trigger is an always-available equivalent and must never be
 * removed (plan.md §14). Hand tracking will fail; a user who cannot get the
 * app's attention is a user who quits.
 */

const PINCH_ENTER_M = 0.02;
const PINCH_EXIT_M = 0.032; // hysteresis band; without it the pose chatters at the boundary
const PINCH_DWELL_MS = 40;

/**
 * plan.md §7 — never teach a gesture performed with the palm toward the face.
 * Palm-pinch is reserved by the system and left palm-pinch exits the session,
 * so we suppress our own detection there rather than fighting the OS for it.
 */
const PALM_TO_FACE_DOT = 0.6;

export type SourceState = {
  side: HandSide;
  tracked: boolean;
  isHand: boolean;
  /** Index fingertip for hands; the pointer ray origin for controllers. */
  tip: Vector3;
  tipQuaternion: Quaternion;
  /** Outward from the palm. Meaningless when isHand is false. */
  palmNormal: Vector3;
  /** Debounced pinch pose (hands) or trigger (controllers). */
  active: boolean;
  /** True on the single frame the pose latched. */
  justPressed: boolean;
  /** True on the single frame it was let go. Drives hold-to-talk. */
  justReleased: boolean;
  suppressedByPalmFacing: boolean;
  pinchDistance: number;
};

type Slot = {
  index: number;
  side: HandSide | null;
  hand: Group;
  controller: Group;
  grip: Group;
  inputSource: XRInputSource | null;
  triggerDown: boolean;
  belowSince: number | null;
  pinched: boolean;
};

export class HandInput {
  private readonly slots: Slot[] = [];
  readonly left: SourceState = blankState("left");
  readonly right: SourceState = blankState("right");

  private readonly v = new Vector3();
  private readonly toHead = new Vector3();

  constructor(private readonly renderer: WebGLRenderer) {
    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      const slot: Slot = {
        index: i,
        side: null,
        hand: renderer.xr.getHand(i) as unknown as Group,
        controller,
        grip: renderer.xr.getControllerGrip(i),
        inputSource: null,
        triggerDown: false,
        belowSince: null,
        pinched: false,
      };

      // Index 0/1 is not a stable left/right mapping — handedness only arrives
      // with the input source.
      controller.addEventListener("connected", (e: { data?: XRInputSource }) => {
        slot.inputSource = e.data ?? null;
        const h = e.data?.handedness;
        slot.side = h === "left" || h === "right" ? h : null;
      });
      controller.addEventListener("disconnected", () => {
        slot.inputSource = null;
        slot.side = null;
        slot.triggerDown = false;
        slot.pinched = false;
      });
      controller.addEventListener("selectstart", () => {
        slot.triggerDown = true;
      });
      controller.addEventListener("selectend", () => {
        slot.triggerDown = false;
      });

      this.slots.push(slot);
    }
  }

  /** Call once per frame, before anything reads `left` / `right`. */
  update(xrTime: number, headPosition: Vector3): void {
    this.left.justPressed = false;
    this.right.justPressed = false;
    this.left.justReleased = false;
    this.right.justReleased = false;
    this.left.tracked = false;
    this.right.tracked = false;

    for (const slot of this.slots) {
      if (!slot.side) continue;
      const out = slot.side === "left" ? this.left : this.right;
      const wasActive = out.active;

      if (this.updateFromHand(slot, out, xrTime, headPosition)) {
        // hand tracking won this frame
      } else if (this.updateFromController(slot, out)) {
        // controller fallback
      } else {
        // Losing tracking mid-hold reads as a release rather than a stuck
        // button, so an utterance still commits if the controller vanishes.
        out.justReleased = wasActive;
        out.active = false;
        continue;
      }

      out.justPressed = out.active && !wasActive;
      out.justReleased = !out.active && wasActive;
    }
  }

  /** plan.md §7 — a tick on listen-start and listen-stop. Audio and haptics lead. */
  pulse(side: HandSide, intensity = 0.4, durationMs = 25): void {
    for (const slot of this.slots) {
      if (slot.side !== side) continue;
      const actuators = slot.inputSource?.gamepad?.hapticActuators;
      const actuator = actuators?.[0] as { pulse?: (i: number, d: number) => void } | undefined;
      actuator?.pulse?.(intensity, durationMs);
    }
  }

  anyTracked(): boolean {
    return this.left.tracked || this.right.tracked;
  }

  private updateFromHand(
    slot: Slot,
    out: SourceState,
    xrTime: number,
    headPosition: Vector3,
  ): boolean {
    const joints = (slot.hand as unknown as { joints?: Record<string, Group | undefined> })
      .joints;
    const thumb = joints?.["thumb-tip"];
    const middle = joints?.["middle-finger-tip"];
    const index = joints?.["index-finger-tip"];
    const wrist = joints?.["wrist"];
    if (!thumb?.visible || !middle?.visible || !index?.visible || !wrist) return false;

    out.tracked = true;
    out.isHand = true;
    index.getWorldPosition(out.tip);
    index.getWorldQuaternion(out.tipQuaternion);

    // WebXR hand joint convention: -Z points distally (toward the fingertip)
    // and +Y out of the BACK of the hand, so the palm faces -Y.
    out.palmNormal.set(0, -1, 0).applyQuaternion(wrist.getWorldQuaternion(new Quaternion()));

    this.toHead.copy(headPosition).sub(out.tip).normalize();
    out.suppressedByPalmFacing = out.palmNormal.dot(this.toHead) > PALM_TO_FACE_DOT;

    const d = thumb.getWorldPosition(this.v).distanceTo(middle.getWorldPosition(new Vector3()));
    out.pinchDistance = d;

    // Hysteresis: enter tight, leave loose. Plus a dwell so we latch on a held
    // pose rather than on the transient of a fast hand passing through.
    if (slot.pinched) {
      if (d > PINCH_EXIT_M) {
        slot.pinched = false;
        slot.belowSince = null;
      }
    } else if (d < PINCH_ENTER_M && !out.suppressedByPalmFacing) {
      slot.belowSince ??= xrTime;
      if (xrTime - slot.belowSince >= PINCH_DWELL_MS) slot.pinched = true;
    } else {
      slot.belowSince = null;
    }

    out.active = slot.pinched;
    return true;
  }

  private updateFromController(slot: Slot, out: SourceState): boolean {
    if (!slot.inputSource || slot.inputSource.hand) return false;
    if (!slot.controller.visible && !slot.grip.visible) return false;

    out.tracked = true;
    out.isHand = false;
    slot.controller.getWorldPosition(out.tip);
    slot.controller.getWorldQuaternion(out.tipQuaternion);
    out.palmNormal.set(0, -1, 0).applyQuaternion(out.tipQuaternion);
    out.suppressedByPalmFacing = false;
    out.pinchDistance = Number.NaN;
    out.active = slot.triggerDown;
    return true;
  }
}

function blankState(side: HandSide): SourceState {
  return {
    side,
    tracked: false,
    isHand: false,
    tip: new Vector3(),
    tipQuaternion: new Quaternion(),
    palmNormal: new Vector3(0, -1, 0),
    active: false,
    justPressed: false,
    justReleased: false,
    suppressedByPalmFacing: false,
    pinchDistance: Number.NaN,
  };
}
