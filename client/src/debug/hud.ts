import {
  CanvasTexture,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
  type Quaternion,
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
  /**
   * plan.md §7 — show the transcript before the round trip. STT error is the
   * most frequent failure and the only one the user can diagnose instantly.
   */
  transcript: string;
  /** Diagnostic line: resolved measurement, backstop reason, error. */
  note: string;
};

const W = 640;
const H = 360;

export class DebugHud {
  readonly mesh: Mesh;
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
   */
  update(headPosition: Vector3, headQuaternion: Quaternion, data: HudData, xrTime: number): void {
    // Lazy-follow with a wide deadzone. Hard head-locking makes text unreadable
    // during head motion and makes the panel impossible to look away from.
    this.desired.set(0, -0.18, -0.9).applyQuaternion(headQuaternion).add(headPosition);
    if (this.mesh.position.distanceTo(this.desired) > 0.35) {
      this.mesh.position.lerp(this.desired, 0.08);
    }
    this.mesh.quaternion.copy(headQuaternion);

    // 10Hz is plenty for a text panel and keeps the canvas upload off the
    // critical path of a 90Hz frame.
    if (xrTime - this.lastPaint < 100) return;
    this.lastPaint = xrTime;
    this.paint(data);
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
