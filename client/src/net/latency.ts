import type { LatencyStage } from "@vair/shared";
import { reportLatency } from "./api.js";

/**
 * Per-turn stage timing (plan.md §16).
 *
 * "Write the latency instrumentation in M1, not later. Retrofitting timestamps
 * is painful and the numbers are the whole point of several decisions
 * downstream." Those decisions are §11's on-device STT question and §17's
 * noticing-threshold question, and neither can be answered from a single
 * end-to-end number — which is why this records stages rather than a total.
 *
 * Timestamps use performance.now(), the same domain as XR frame time, so a
 * stage can be stamped from either the frame loop or an async callback.
 */
export class LatencyTurn {
  private readonly stages: Partial<Record<LatencyStage, number>> = {};
  private sent = false;
  /** Set once the scene changed, so the frame loop can stamp presentation. */
  private awaitingFrame = false;

  constructor(
    readonly turnId: string,
    /** Which path served it — the two must stay indistinguishable to the user. */
    private path: "local" | "server" = "server",
  ) {}

  mark(stage: LatencyStage, at: number = performance.now()): void {
    // First write wins: scene_mutated should be the FIRST object appearing, not
    // the last, because that is the moment the user sees the void change.
    this.stages[stage] ??= at;
    if (stage === "scene_mutated") this.awaitingFrame = true;
  }

  setPath(path: "local" | "server"): void {
    this.path = path;
  }

  /** Call from the frame loop; stamps the first frame after a scene change. */
  notePresented(at: number): void {
    if (!this.awaitingFrame) return;
    this.awaitingFrame = false;
    this.mark("frame_presented", at);
  }

  /** Fire-and-forget. Safe to call more than once; only the first sends. */
  flush(): void {
    if (this.sent) return;
    this.sent = true;
    // A turn that failed before mutating anything still carries useful stages —
    // upload and transcript timings are exactly what the STT decision needs.
    if (Object.keys(this.stages).length < 2) return;
    reportLatency({ turnId: this.turnId, path: this.path, stages: this.stages });
  }

  snapshot(): Partial<Record<LatencyStage, number>> {
    return { ...this.stages };
  }
}

let counter = 0;
export function newTurnId(): string {
  return `t${counter++}-${Math.random().toString(36).slice(2, 8)}`;
}
