import type { SceneDocument, SceneEvent } from "@vair/shared";
import type { HandSide, PoseRingBuffer } from "../core/pose-buffer.js";
import { resolveMeasurement, type ResolveOptions } from "../input/deixis.js";
import type { InteractionMachine } from "../input/state-machine.js";
import type { ResolvedUtterance } from "../input/utterance.js";
import type { HudData } from "./hud.js";

/**
 * Dev-only bridge exposing the running experience on `window.vair`, so an agent
 * driving Chrome (or a human in DevTools) can exercise the voice loop without a
 * microphone, an STT key, or a headset.
 *
 * This is loaded behind `import.meta.env.DEV` in main.ts and is tree-shaken out
 * of production builds.
 *
 * The point is NOT to fake the pipeline. `say()` drives the real interaction
 * state machine, the real deixis resolver and the real pose ring buffer — only
 * the microphone and the STT provider are substituted. If a bug exists in
 * temporal binding, this will reproduce it.
 */

export type BridgeDeps = {
  /** Latest XR frame time. */
  now(): number;
  machine: InteractionMachine;
  buffer: PoseRingBuffer;
  resolveOptions(): ResolveOptions;
  snapshot(): HudData;
  scene(): SceneDocument;
  events(): readonly SceneEvent[];
  arm(text: string, durationMs: number): void;
  disarm(): void;
  lastUtterance(): ResolvedUtterance | null;
  /** What the model last said aloud, for inspection while TTS is unbuilt. */
  lastSpeech(): string;
  presenting(): boolean;
};

type SayOptions = { durationMs?: number; hand?: HandSide };

const DEFAULT_UTTERANCE_MS = 1800;

export function installDebugBridge(deps: BridgeDeps): void {
  const api = {
    help(): string[] {
      return [
        'vair.say("put a cube here")      — full mock utterance, returns resolved measurements',
        'vair.say(text, { durationMs, hand }) — durationMs back-dates the utterance over real motion',
        'vair.arm("…") then pull a trigger — same thing, but you drive the gesture yourself',
        "vair.press('left'|'right')        — simulate a pinch/trigger latch",
        "vair.state()                      — interaction state, tracking, counters, fps",
        'vair.measure("here", msAgo)       — resolve one measurement bundle directly',
        "vair.poseAt(msAgo)                — raw pose from the ring buffer",
        "vair.scene() / vair.events()      — folded scene document and event log",
        "vair.lastUtterance()              — most recent resolved utterance",
      ];
    },

    state() {
      return { ...deps.snapshot(), presenting: deps.presenting() };
    },

    press(side: HandSide = "right") {
      deps.machine.press(side, deps.now());
      return deps.machine.state;
    },

    arm(text: string, opts: SayOptions = {}) {
      deps.arm(text, opts.durationMs ?? DEFAULT_UTTERANCE_MS);
      return `armed: "${text}" — now pinch or pull a trigger to commit it`;
    },

    disarm() {
      deps.disarm();
      return "disarmed";
    },

    /**
     * Speak an utterance. Latches, commits, transcribes and resolves, all in
     * one synchronous call.
     *
     * `durationMs` matters: the utterance is back-dated by that much, so word
     * timestamps index poses the buffer genuinely recorded over the preceding
     * seconds. Move the hand, then call say() — the deictic word binds to where
     * the hand WAS, which is the whole mechanism under test.
     */
    say(text: string, opts: SayOptions = {}) {
      if (!deps.presenting()) {
        return { error: "not in an XR session — enter it first, the pose buffer is empty" };
      }
      const state = deps.machine.state;
      if (state !== "IDLE" && state !== "FAILED" && state !== "NEEDS_INPUT") {
        return { error: `busy in ${state} — wait for IDLE (a press here would cancel, not speak)` };
      }

      const durationMs = opts.durationMs ?? DEFAULT_UTTERANCE_MS;
      const hand = opts.hand ?? "right";
      deps.arm(text, durationMs);

      const now = deps.now();
      deps.machine.press(hand, now); // -> LISTENING
      deps.machine.press(hand, now); // -> commit, transcribe, resolve

      return deps.lastUtterance() ?? { error: "utterance produced no result" };
    },

    measure(token = "here", msAgo = 0) {
      return resolveMeasurement(token, deps.now() - msAgo, deps.resolveOptions());
    },

    poseAt(msAgo = 0) {
      const s = deps.buffer.sampleAt(deps.now() - msAgo);
      if (!s) return { error: "no sample at that time — outside the buffer window" };
      // Flattened to plain numbers so it survives structured cloning out of the
      // page context into a debugger or an automation tool.
      return {
        xrTime: s.xrTime,
        head: s.headPosition.toArray(),
        headQuat: s.headQuaternion.toArray(),
        left: { valid: s.left.valid, isHand: s.left.isHand, tip: s.left.tip.toArray() },
        right: { valid: s.right.valid, isHand: s.right.isHand, tip: s.right.tip.toArray() },
        bufferWindowMs: deps.buffer.newestTime - deps.buffer.oldestTime,
      };
    },

    scene: () => deps.scene(),
    events: () => [...deps.events()],
    lastUtterance: () => deps.lastUtterance(),
    lastSpeech: () => deps.lastSpeech(),
  };

  (window as Window & { vair?: typeof api }).vair = api;
  console.log("[vair] debug bridge ready — window.vair.help()");
}
