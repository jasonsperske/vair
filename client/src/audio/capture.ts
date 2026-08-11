import { clock } from "../core/clock.js";

/**
 * Gesture-gated microphone capture (plan.md M1).
 *
 * Verified on Quest 2 in-session before this was written: getUserMedia,
 * MediaRecorder and an AudioContext all work inside an active immersive
 * session, so nothing here has to be deferred to the flat page.
 *
 * Two things this owns that nothing else can:
 *
 *  1. **The clock anchor.** §6.2 requires the utterance's start to be known in
 *     the XR frame clock, because STT reports word times as seconds from the
 *     start of the audio and the ring buffer is indexed by XR time. We align
 *     the two clocks at the moment recording begins.
 *  2. **Voice activity**, so the state machine's 1.5s silence backstop (§7) has
 *     something to measure. Without it a missed commit gesture strands the user
 *     in LISTENING until the 15s cap.
 */

const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
] as const;

/**
 * Voice detection, tuned by what actually broke.
 *
 * A fixed absolute threshold does not survive contact with a real room: at
 * 0.012 the measured ambient noise here peaked at 0.0153 often enough to keep
 * resetting the silence timer, so the §7 backstop never fired and LISTENING ran
 * to the 15s cap — precisely the "stranded in LISTENING" failure §7 forbids.
 *
 * So the gate is relative to the room instead of absolute, and a level has to
 * hold above it for several frames. A single click or keyboard tap no longer
 * counts as speech, and a quiet room and a noisy one both work.
 */

/**
 * Below this it is never speech, however quiet the room.
 *
 * Set from measurement, not taste: the in-headset probe recorded a peak of 0.31
 * while speaking, whereas ambient room noise here peaks around 0.015. 0.03 sits
 * in that gap with margin on both sides. At 0.01 the backstop never fired at
 * all and every utterance ran to the 15s cap.
 */
const VOICE_MIN_RMS = 0.03;
/** How far above measured room noise the level must rise. */
const VOICE_OVER_FLOOR = 3;
/** Consecutive frames above the gate before it counts — ~44ms at 90Hz. */
const VOICE_SUSTAIN_FRAMES = 4;

export type CaptureResult = {
  audio: Blob;
  /** XR frame time of the first audio sample, for word-time conversion. */
  utteranceStartXrTime: number;
};

export class AudioCapture {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  // Explicitly backed by ArrayBuffer: getFloatTimeDomainData rejects a
  // SharedArrayBuffer-backed view, which the bare Float32Array type allows.
  private scratch: Float32Array<ArrayBuffer> | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startXrTime = 0;
  private lastRms = 0;
  private noiseFloor = VOICE_MIN_RMS / VOICE_OVER_FLOOR;
  private voiceFrames = 0;

  /** Whether this browser can capture at all. Checked before offering to. */
  static supported(): boolean {
    return (
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function" &&
      typeof MediaRecorder !== "undefined" &&
      PREFERRED_MIME_TYPES.some((m) => MediaRecorder.isTypeSupported?.(m))
    );
  }

  get ready(): boolean {
    return this.stream !== null;
  }

  get recording(): boolean {
    return this.recorder?.state === "recording";
  }

  /** Latest voice level, 0..1. Read per frame to drive the silence backstop. */
  get rms(): number {
    return this.lastRms;
  }

  /**
   * Acquire the microphone. Idempotent, and deliberately lazy: the mic stays
   * closed — and the headset's recording indicator stays off — until the user
   * first tries to speak. The cost is a one-off device-open on the first
   * utterance; every later one starts instantly because the stream is held.
   */
  async prepare(): Promise<void> {
    if (this.stream) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        // OFF, deliberately. AGC rides the gain up during quiet passages, so a
        // silent room measured 0.003–0.152 RMS here — overlapping speech — and
        // no threshold, absolute or relative, could separate the two. The
        // silence backstop simply never fired. With AGC off the level tracks
        // real acoustic energy again.
        //
        // The cost is less headroom for a quiet talker, which matters little
        // with a headset mic sitting close to the mouth. If distant speech ever
        // transcribes badly, the fix is a second analysis-only stream rather
        // than turning this back on.
        autoGainControl: false,
      },
    });

    const ctx = new AudioContext({ latencyHint: "interactive" });
    // An AudioContext created before a user gesture can start suspended; the
    // pinch that triggered this counts, but resume() is cheap insurance.
    if (ctx.state === "suspended") await ctx.resume();

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);

    this.stream = stream;
    this.ctx = ctx;
    this.analyser = analyser;
    this.scratch = new Float32Array(analyser.fftSize);
  }

  /**
   * Begin recording. Returns the XR frame time of the first audio sample.
   *
   * The anchor comes from the audio clock rather than from `performance.now()`:
   * the two drift, and §6.2 exists because that drift lands directly on the
   * deictic word. There is still an unmeasured lag between this call and the
   * encoder's first sample — small, but it biases every word time by a constant,
   * so it is the first thing to measure if placement is consistently off.
   */
  start(fallbackXrTime: number): number {
    if (!this.stream || !this.ctx) throw new Error("capture not prepared");
    if (this.recording) this.abort();

    clock.align(this.ctx);
    this.startXrTime = clock.audioToXr(this.ctx.currentTime) || fallbackXrTime;

    // Re-measure the room each utterance; conditions change between them.
    this.noiseFloor = VOICE_MIN_RMS / VOICE_OVER_FLOOR;
    this.voiceFrames = 0;

    const mimeType = PREFERRED_MIME_TYPES.find((m) => MediaRecorder.isTypeSupported?.(m));
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();

    return this.startXrTime;
  }

  /** Stop and return the utterance. Resolves once the encoder has flushed. */
  async stop(): Promise<CaptureResult | null> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === "inactive") return null;

    const flushed = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    await flushed;
    this.recorder = null;

    if (this.chunks.length === 0) return null;
    const audio = new Blob(this.chunks, { type: this.chunks[0]!.type || "audio/webm" });
    this.chunks = [];
    return { audio, utteranceStartXrTime: this.startXrTime };
  }

  /** Throw away an in-flight recording — §7's cancel, which must not upload. */
  abort(): void {
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.recorder = null;
    this.chunks = [];
  }

  /**
   * Sample the voice level. Call every frame while LISTENING.
   *
   * `voice` is what drives the silence backstop; `rms` and `gate` are for the
   * HUD meter, which is how the gate gets sanity-checked in a real room.
   */
  sample(): { rms: number; gate: number; voice: boolean } {
    if (!this.analyser || !this.scratch) return { rms: 0, gate: VOICE_MIN_RMS, voice: false };

    this.analyser.getFloatTimeDomainData(this.scratch);
    let sum = 0;
    for (const s of this.scratch) sum += s * s;
    const rms = Math.sqrt(sum / this.scratch.length);
    this.lastRms = rms;

    // Falls quickly toward quiet, rises slowly, so a burst of speech cannot
    // drag the floor up behind it and deafen the detector mid-sentence.
    this.noiseFloor += (rms - this.noiseFloor) * (rms < this.noiseFloor ? 0.25 : 0.002);

    const gate = Math.max(VOICE_MIN_RMS, this.noiseFloor * VOICE_OVER_FLOOR);
    this.voiceFrames = rms > gate ? this.voiceFrames + 1 : 0;
    return { rms, gate, voice: this.voiceFrames >= VOICE_SUSTAIN_FRAMES };
  }

  /** Release the device. The recording indicator goes out with it. */
  release(): void {
    this.abort();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.ctx?.close();
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.scratch = null;
    this.lastRms = 0;
  }
}
