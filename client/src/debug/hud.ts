import {
  CanvasTexture,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three";

import type { InteractionState } from "../input/state-machine.js";

/**
 * The M0 acceptance instrument (plan.md §12): "pinch reliably toggles a debug
 * indicator across 50 trials on-device, both hands."
 *
 * Counters are per hand and per input path, because the failure we expect is
 * hand tracking degrading in a specific zone (§11 experiment 1) while the
 * controller path stays at 100%. A single combined counter would hide that.
 */
export type HudData = {
  state: InteractionState;
  leftTracked: boolean;
  rightTracked: boolean;
  leftIsHand: boolean;
  rightIsHand: boolean;
  leftPinches: number;
  rightPinches: number;
  leftPinchDistance: number;
  rightPinchDistance: number;
  toggle: boolean;
  fps: number;
  bufferSeconds: number;
  /** Live voice level while listening. Shown so the VAD gate is tunable. */
  micRms: number;
  /** Level the room noise floor puts the speech gate at, right now. */
  micGate: number;
  /**
   * plan.md §7 — show the transcript before the round trip. STT error is the
   * most frequent failure and the only one the user can diagnose instantly.
   */
  transcript: string;
  /** Diagnostic line: resolved measurement, backstop reason, error. */
  note: string;
};

/**
 * Where the panel lives. Head-follow is the default and what M0 was accepted
 * against; the wrist placements exist because a panel that lazy-follows the
 * head is in the way exactly when you are looking at the scene, and hiding it
 * outright then leaves no way to check state mid-session.
 */
export type HudPlacement = "head" | "left" | "right" | "hidden";

/** The hand a wrist-mounted panel rides on. `SourceState` satisfies this. */
export type HudAnchor = {
  tracked: boolean;
  isHand: boolean;
  wrist: Vector3;
  wristQuaternion: Quaternion;
};

const W = 640;
const H = 360;

/** Panel is 0.5 x 0.28m; on a wrist it wants to be about a phone. */
const HAND_SCALE = 0.32;

/**
 * Wrist space, same convention as input/hands.ts: -Z distal (toward the
 * fingertips), +Y out of the BACK of the hand. So this is 5cm clear of the
 * back of the hand and 7cm along it, which centres the panel over the
 * metacarpals rather than over the wrist bone.
 */
const HAND_OFFSET = new Vector3(0, 0.05, -0.07);

/** A controller has no back-of-hand, so its panel floats above the grip. */
const CONTROLLER_LIFT = 0.1;

/**
 * Lays the panel flat on the back of the hand: its normal (+Z) onto the
 * wrist's +Y, its up (+Y) onto the wrist's -Z, so the text reads up toward the
 * fingers the way a watch face does.
 */
const BACK_OF_HAND = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);

export class DebugHud {
  readonly mesh: Mesh;
  /** Set by the local command matcher. Read every frame; no transition state. */
  placement: HudPlacement = "head";
  private readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly desired = new Vector3();
  private lastPaint = 0;

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;

    this.texture = new CanvasTexture(this.canvas);
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;

    this.mesh = new Mesh(
      new PlaneGeometry(0.5, 0.28),
      new MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false }),
    );
    this.mesh.renderOrder = 10;
  }

  /**
   * Head pose comes from the XRFrame's viewer pose, not from the three camera:
   * three only copies the XR camera onto the app camera inside render(), which
   * runs after this, so reading the camera here would be a frame stale.
   *
   * `anchor` is the hand the panel is mounted on, or null when it isn't.
   */
  update(
    headPosition: Vector3,
    headQuaternion: Quaternion,
    anchor: HudAnchor | null,
    data: HudData,
    xrTime: number,
  ): void {
    if (this.placement === "hidden") {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;

    if (this.placement === "head") {
      this.followHead(headPosition, headQuaternion);
    } else if (anchor?.tracked) {
      this.followHand(anchor, headPosition);
    }
    // Otherwise the hand it is mounted on isn't tracked. Hold the last pose:
    // the panel is wherever that hand was, which is out of the tracking volume
    // and so almost always out of sight, and freezing beats both flickering
    // through tracking dropouts and flying back to the face and out again.

    // 10Hz is plenty for a text panel and keeps the canvas upload off the
    // critical path of a 90Hz frame.
    if (xrTime - this.lastPaint < 100) return;
    this.lastPaint = xrTime;
    this.paint(data);
  }

  private followHead(headPosition: Vector3, headQuaternion: Quaternion): void {
    // Lazy-follow with a wide deadzone. Hard head-locking makes text unreadable
    // during head motion and makes the panel impossible to look away from.
    this.desired.set(0, -0.18, -0.9).applyQuaternion(headQuaternion).add(headPosition);
    if (this.mesh.position.distanceTo(this.desired) > 0.35) {
      this.mesh.position.lerp(this.desired, 0.08);
    }
    this.mesh.quaternion.copy(headQuaternion);
    this.mesh.scale.setScalar(1);
  }

  /**
   * Rigid, not lazy: mounted means mounted, and a panel that lagged the hand
   * would swim every time you turned your wrist to read it.
   */
  private followHand(anchor: HudAnchor, headPosition: Vector3): void {
    this.mesh.scale.setScalar(HAND_SCALE);

    if (anchor.isHand) {
      this.desired.copy(HAND_OFFSET).applyQuaternion(anchor.wristQuaternion).add(anchor.wrist);
      this.mesh.position.copy(this.desired);
      this.mesh.quaternion.copy(anchor.wristQuaternion).multiply(BACK_OF_HAND);
      return;
    }

    // Controller path (§14 — it must always work). Grip space doesn't carry the
    // hand-joint convention above, so rather than guess which way the back of
    // the hand is, lift the panel straight up and turn it to face the viewer.
    this.desired.copy(anchor.wrist);
    this.desired.y += CONTROLLER_LIFT;
    this.mesh.position.copy(this.desired);
    this.mesh.lookAt(headPosition);
  }

  private paint(d: HudData): void {
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    c.fillStyle = "rgba(4,7,18,0.82)";
    c.fillRect(0, 0, W, H);

    c.font = "600 30px ui-monospace, monospace";
    c.fillStyle = STATE_COLORS[d.state];
    c.fillText(d.state, 24, 48);

    c.font = "20px ui-monospace, monospace";
    c.fillStyle = "#9fb0e0";
    c.fillText(`${d.fps.toFixed(0)} fps   buffer ${d.bufferSeconds.toFixed(1)}s`, 24, 82);

    // Voice meter — only meaningful while listening, and the fastest way to see
    // whether the VAD threshold is right for this room.
    if (d.state === "LISTENING") {
      const scale = (v: number) => Math.min(1, v / 0.1) * 240;
      c.fillStyle = "#1b2440";
      c.fillRect(376, 66, 240, 18);
      // Blue once the level clears the gate that holds off the silence
      // backstop; grey means the backstop is counting down.
      c.fillStyle = d.micRms > d.micGate ? "#5aa8ff" : "#3f4870";
      c.fillRect(376, 66, scale(d.micRms), 18);
      // The gate itself, which floats with the room's noise floor.
      c.fillStyle = "#ffb23f";
      c.fillRect(376 + scale(d.micGate), 62, 2, 26);
    }

    this.paintHand(c, 24, 120, "L", d.leftTracked, d.leftIsHand, d.leftPinches, d.leftPinchDistance);
    this.paintHand(c, 330, 120, "R", d.rightTracked, d.rightIsHand, d.rightPinches, d.rightPinchDistance);

    // The toggle itself — the thing the 50 trials are counting.
    c.fillStyle = d.toggle ? "#5aa8ff" : "#1b2440";
    c.fillRect(24, 226, 592, 44);
    c.fillStyle = d.toggle ? "#04070f" : "#5f7cc0";
    c.font = "600 22px ui-monospace, monospace";
    c.fillText(d.toggle ? "TOGGLE ON" : "TOGGLE OFF", 240, 256);

    if (d.transcript) {
      c.fillStyle = "#cfd8ff";
      c.font = "20px ui-sans-serif, system-ui, sans-serif";
      c.fillText(`“${clip(d.transcript, 44)}”`, 24, 304);
    }
    if (d.note) {
      c.fillStyle = "#7f8db8";
      c.font = "17px ui-monospace, monospace";
      c.fillText(clip(d.note, 54), 24, 334);
    }

    this.texture.needsUpdate = true;
  }

  private paintHand(
    c: CanvasRenderingContext2D,
    x: number,
    y: number,
    label: string,
    tracked: boolean,
    isHand: boolean,
    pinches: number,
    distance: number,
  ): void {
    c.font = "600 24px ui-monospace, monospace";
    c.fillStyle = tracked ? "#cfd8ff" : "#4a5170";
    c.fillText(`${label}  ${tracked ? (isHand ? "hand" : "ctrl") : "lost"}`, x, y);

    c.font = "20px ui-monospace, monospace";
    c.fillStyle = "#9fb0e0";
    c.fillText(`pinches ${pinches}`, x, y + 32);
    c.fillText(
      Number.isNaN(distance) ? "gap    —" : `gap    ${(distance * 1000).toFixed(0)}mm`,
      x,
      y + 60,
    );
  }
}

const STATE_COLORS: Record<InteractionState, string> = {
  IDLE: "#5f7cc0",
  LISTENING: "#5aa8ff",
  TRANSCRIBING: "#6fb4ff",
  THINKING: "#3f6bb0",
  APPLYING: "#7fd0ff",
  NEEDS_INPUT: "#ffb23f",
  FAILED: "#ff4d4d",
};

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
