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
        "await vair.probeMic()             — M1 gate: does the mic work IN-SESSION? speak while it runs",
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

    /**
     * Does the microphone actually work inside an immersive session?
     *
     * M1 depends on this and nothing else does, so it is worth answering before
     * building capture. Run it from chrome://inspect WHILE WEARING THE HEADSET
     * with the session running — the answer on a desktop tab tells you nothing
     * about the Quest browser's behaviour in-session.
     *
     * Permission alone is not the test. The failure mode that would actually
     * bite is a granted mic that yields silence or zero bytes once the session
     * takes audio focus, so this records a real sample and reports the byte
     * count and peak amplitude.
     */
    async probeMic(ms = 1500) {
      const report: Record<string, unknown> = { presenting: deps.presenting() };
      if (!deps.presenting()) {
        report.warning = "not in an XR session — this result says nothing about in-session behaviour";
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
      } catch (err) {
        report.ok = false;
        report.stage = "getUserMedia";
        report.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        return report;
      }

      try {
        const track = stream.getAudioTracks()[0];
        report.trackLabel = track?.label ?? "(none)";
        report.trackState = track?.readyState ?? "(none)";
        report.trackSettings = track?.getSettings?.() ?? {};

        const candidates = [
          "audio/webm;codecs=opus",
          "audio/webm",
          "audio/ogg;codecs=opus",
          "audio/mp4",
        ];
        report.supportedMimeTypes = candidates.filter((m) =>
          typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m),
        );

        const mimeType = (report.supportedMimeTypes as string[])[0];
        if (!mimeType) {
          report.ok = false;
          report.stage = "MediaRecorder";
          report.error = "no supported audio mime type";
          return report;
        }

        // Peak amplitude via the Web Audio graph, so "recorded bytes but pure
        // silence" is distinguishable from "recorded actual audio".
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        let peak = 0;

        const recorder = new MediaRecorder(stream, { mimeType });
        const chunks: Blob[] = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };

        const stopped = new Promise<void>((resolve) => {
          recorder.onstop = () => resolve();
        });
        recorder.start();

        const started = performance.now();
        while (performance.now() - started < ms) {
          analyser.getFloatTimeDomainData(samples);
          for (const s of samples) peak = Math.max(peak, Math.abs(s));
          await new Promise((r) => setTimeout(r, 50));
        }
        recorder.stop();
        await stopped;

        const bytes = chunks.reduce((n, c) => n + c.size, 0);
        report.audioContextState = ctx.state;
        report.mimeType = mimeType;
        report.recordedBytes = bytes;
        report.peakAmplitude = Number(peak.toFixed(4));
        report.ok = bytes > 0 && peak > 0.001;
        if (bytes > 0 && peak <= 0.001) {
          report.warning = "recorded bytes but the signal was silent — say something while probing";
        }
        void ctx.close();
        return report;
      } finally {
        for (const t of stream.getTracks()) t.stop();
      }
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
