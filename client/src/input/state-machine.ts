import type { HandSide } from "../core/pose-buffer.js";

/**
 * plan.md §7 — interaction state machine.
 *
 * Latch, not hold. The pinch starts listening and releases immediately; holding
 * the pose through the utterance would occupy the hand needed for pointing at
 * the thing being talked about.
 */
export type InteractionState =
  | "IDLE"
  | "LISTENING"
  | "TRANSCRIBING"
  | "THINKING"
  | "APPLYING"
  | "NEEDS_INPUT"
  | "FAILED";

/** plan.md §7 — a missed commit gesture must never strand the user in LISTENING. */
const SILENCE_COMMIT_MS = 1500;
const MAX_UTTERANCE_MS = 15_000;
const FAILED_LINGER_MS = 1200;

export type MachineEvents = {
  /** Begin audio capture. The hand that latched is passed for haptics. */
  onListenStart(side: HandSide, xrTime: number): void;
  /** Stop capture and upload. `reason` distinguishes the backstops for tools/. */
  onListenStop(reason: "commit" | "silence" | "timeout", xrTime: number): void;
  /** plan.md §7 — a new pinch during THINKING aborts rather than queues. */
  onCancel(): void;
  onStateChange(next: InteractionState, prev: InteractionState): void;
};

export class InteractionMachine {
  private _state: InteractionState = "IDLE";
  private listenStartedAt = 0;
  private lastVoiceAt = 0;
  private failedAt = 0;
  private activeSide: HandSide = "right";

  constructor(private readonly events: MachineEvents) {}

  get state(): InteractionState {
    return this._state;
  }

  /** The hand that started the current utterance — the deixis default. */
  get side(): HandSide {
    return this.activeSide;
  }

  /**
   * A latched pinch or trigger press. Same entry point for both paths on
   * purpose: the user must never be able to tell which one they used.
   */
  press(side: HandSide, xrTime: number): void {
    switch (this._state) {
      case "IDLE":
      case "NEEDS_INPUT":
      case "FAILED":
        this.activeSide = side;
        this.listenStartedAt = xrTime;
        this.lastVoiceAt = xrTime;
        this.to("LISTENING");
        this.events.onListenStart(side, xrTime);
        break;

      case "LISTENING":
        this.to("TRANSCRIBING");
        this.events.onListenStop("commit", xrTime);
        break;

      case "TRANSCRIBING":
      case "THINKING":
      case "APPLYING":
        // Cancel, don't queue. Queued turns arrive after the user has changed
        // their mind and act on a scene they were no longer looking at.
        this.events.onCancel();
        this.to("IDLE");
        break;
    }
  }

  /** Called by the VAD while voice energy is present (M1). */
  noteVoice(xrTime: number): void {
    if (this._state === "LISTENING") this.lastVoiceAt = xrTime;
  }

  /** Drive the backstop timers. Call every frame. */
  tick(xrTime: number): void {
    if (this._state === "LISTENING") {
      if (xrTime - this.listenStartedAt > MAX_UTTERANCE_MS) {
        this.to("TRANSCRIBING");
        this.events.onListenStop("timeout", xrTime);
      } else if (xrTime - this.lastVoiceAt > SILENCE_COMMIT_MS) {
        this.to("TRANSCRIBING");
        this.events.onListenStop("silence", xrTime);
      }
      return;
    }

    if (this._state === "FAILED" && xrTime - this.failedAt > FAILED_LINGER_MS) {
      this.to("IDLE");
    }
  }

  transcriptReady(): void {
    if (this._state === "TRANSCRIBING") this.to("THINKING");
  }

  applying(): void {
    if (this._state === "THINKING") this.to("APPLYING");
  }

  done(): void {
    this.to("IDLE");
  }

  needsInput(): void {
    this.to("NEEDS_INPUT");
  }

  failed(xrTime: number): void {
    this.failedAt = xrTime;
    this.to("FAILED");
  }

  private to(next: InteractionState): void {
    if (next === this._state) return;
    const prev = this._state;
    this._state = next;
    this.events.onStateChange(next, prev);
  }
}
