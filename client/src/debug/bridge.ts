import type { SceneDocument, SceneEvent } from "@vair/shared";
import type { HandSide, PoseRingBuffer } from "../core/pose-buffer.js";
import { resolveMeasurement, type ResolveOptions } from "../input/deixis.js";
import type { InteractionMachine } from "../input/state-machine.js";
import type { ResolvedUtterance } from "../input/utterance.js";
import type { HudData, HudPlacement } from "./hud.js";

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
  /** Live voice-gate reading, for tuning the VAD in a real room. */
  voice?(): { rms: number; gate: number; voice: boolean };
  setHandsVisible?(visible: boolean): void;
  handsVisible?(): boolean;
  setHudPlacement?(placement: HudPlacement): void;
  hudPlacement?(): HudPlacement;
};

type SayOptions = { durationMs?: number; hand?: HandSide };

const DEFAULT_UTTERANCE_MS = 1800;

/**
 * A promise that cannot hang. Used on every await in probeMic, because an
 * unresolved promise is indistinguishable from "the tool did nothing" and is
 * exactly the failure the probe exists to catch.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export function installDebugBridge(deps: BridgeDeps): void {
  const api = {
    help(): string[] {
      return [
        'vair.say("put a cube here")      — full mock utterance, returns resolved measurements',
        'vair.say(text, { durationMs, hand }) — durationMs back-dates the utterance over real motion',
        'vair.arm("…") then pull a trigger — same thing, but you drive the gesture yourself',
        "await vair.probeMic()             — M1 gate: does the mic work IN-SESSION? speak while it runs",
        "vair.press('left'|'right')        — simulate a pinch/trigger latch",
        "vair.hud('left'|'right'|'head'|'hidden') — move or hide the info box",
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

    /** Show or hide the rendered hand joints. */
    hands(visible?: boolean) {
      if (visible !== undefined) deps.setHandsVisible?.(visible);
      return { visible: deps.handsVisible?.() ?? null };
    },

    /**
     * Move the info box, or hide it. Same four placements the voice command
     * reaches; this is the way to check the mount from a desk, where saying
     * "put the info box on my left hand" needs a mock utterance first.
     */
    hud(placement?: HudPlacement) {
      if (placement !== undefined) deps.setHudPlacement?.(placement);
      return { placement: deps.hudPlacement?.() ?? null };
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
      // Every stage logs, so a hang still shows how far it got in the console
      // even though the promise never resolves to a value.
      const stage = (name: string, extra?: unknown) => {
        report.stage = name;
        console.log(`[vair] probeMic: ${name}`, extra ?? "");
      };

      if (!deps.presenting()) {
        report.warning = "not in an XR session — this result says nothing about in-session behaviour";
      }

      // Read the permission WITHOUT prompting, so a blocked or prompt-pending
      // state is visible even if the request below never returns.
      stage("permissions.query");
      try {
        const status = await navigator.permissions?.query({
          name: "microphone" as PermissionName,
        });
        report.permission = status?.state ?? "unknown";
      } catch {
        report.permission = "unqueryable";
      }

      let stream: MediaStream;
      try {
        stage("getUserMedia");
        // Bounded on purpose. A permission prompt that cannot be drawn inside
        // an immersive session leaves this promise pending forever, which looks
        // exactly like "nothing happened" — a timeout turns that silence into a
        // diagnosis.
        stream = await withTimeout(
          navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
          }),
          8000,
          "getUserMedia",
        );
      } catch (err) {
        report.ok = false;
        report.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        if (String(report.error).includes("timed out")) {
          report.diagnosis =
            report.permission === "prompt"
              ? "permission was never granted and the prompt likely cannot render inside an immersive session — exit XR, run probeMic() on the flat page to grant it, then re-enter and probe again"
              : "getUserMedia hung despite permission — the session may be holding audio focus";
        }
        console.warn("[vair] probeMic failed:", report);
        return report;
      }

      try {
        stage("inspect track");
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

        stage("recording", `${ms}ms as ${mimeType}`);
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
        // Also bounded: a recorder that never fires onstop would hang here.
        await withTimeout(stopped, 5000, "MediaRecorder.onstop").catch(() => {
          report.warning = "recorder did not fire onstop within 5s";
        });

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
        stage("done");
        console.log("[vair] probeMic result:", report);
        return report;
      } finally {
        for (const t of stream.getTracks()) t.stop();
      }
    },

    /**
     * Watch the voice gate live, for tuning in a real room.
     *
     * An energy VAD is only ever as good as its threshold, and the threshold is
     * a property of the room and the headset's mic — not something that can be
     * chosen from a desk. Run this, speak normally, then stay quiet: `speaking`
     * should be true only while you talk. If it is true when you are silent the
     * silence backstop will never fire and every utterance runs to the 15s cap.
     */
    async watchVoice(seconds = 6) {
      if (!deps.voice) return { error: "voice metering unavailable" };
      const samples: { t: number; rms: number; gate: number; voice: boolean }[] = [];
      const t0 = performance.now();
      while (performance.now() - t0 < seconds * 1000) {
        const v = deps.voice();
        samples.push({ t: Math.round(performance.now() - t0), ...v });
        await new Promise((r) => setTimeout(r, 100));
      }
      const speaking = samples.filter((s) => s.voice).length;
      return {
        note: "voice should be true only while you are talking",
        samples: samples.length,
        framesFlaggedAsSpeech: speaking,
        rmsMin: Math.min(...samples.map((s) => s.rms)).toFixed(4),
        rmsMax: Math.max(...samples.map((s) => s.rms)).toFixed(4),
        gate: samples.at(-1)?.gate.toFixed(4),
        timeline: samples
          .filter((_, i) => i % 3 === 0)
          .map((s) => `${s.t}ms ${s.rms.toFixed(3)}${s.voice ? " *" : ""}`),
      };
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
