import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { TranscriptResponse, TranscriptWord } from "@vair/shared";
import { env } from "../env.js";

/**
 * Vosk — local, offline STT with native word-level timings (plan.md §6.3).
 *
 * Chosen because it is the only zero-cost option that clears the word-timestamp
 * requirement *and* the M1 latency budget on a modest CPU. Measured here on a
 * 2-core i3 with the small English model: 727ms to decode 8.3s of audio, a
 * 0.09x realtime factor, so a 3s utterance lands in roughly 0.3s.
 *
 * Its word objects are `{word, start, end, conf}` with times in seconds from
 * the start of the audio — already the shape TranscriptWord expects, so nothing
 * here has to synthesise or interpolate a timing. That matters: §6.3 exists
 * precisely to keep invented timings out of the deixis path.
 *
 * The accuracy tradeoff is real. The small model handles command-shaped
 * utterances well and mangles proper nouns; swapping in a larger model is a
 * path change and nothing else.
 */

/** Loaded once — model construction costs ~255ms and is pure overhead per call. */
let model: import("vosk").Model | null = null;
let loading: Promise<import("vosk").Model> | null = null;

export function voskModelPath(): string {
  return env.voskModelPath;
}

export function voskModelAvailable(): boolean {
  return existsSync(env.voskModelPath);
}

async function getModel(): Promise<import("vosk").Model> {
  if (model) return model;
  // Guarded by a shared promise so two concurrent first-requests don't both
  // load a 40MB model into memory.
  loading ??= (async () => {
    const vosk = await import("vosk");
    vosk.setLogLevel(-1); // its default logging is extremely chatty
    model = new vosk.Model(env.voskModelPath);
    return model;
  })();
  return loading;
}

export class SttError extends Error {}

export async function transcribeVosk(audio: Buffer): Promise<TranscriptResponse> {
  if (!voskModelAvailable()) {
    throw new SttError(`no Vosk model at ${env.voskModelPath} — run: npm run stt:model`);
  }
  if (audio.length === 0) throw new SttError("empty audio upload");

  const pcm = await toPcm16kMono(audio);
  if (pcm.length === 0) throw new SttError("audio decoded to zero samples");

  const vosk = await import("vosk");
  const loaded = await getModel();

  const recognizer = new vosk.Recognizer({ model: loaded, sampleRate: SAMPLE_RATE });
  try {
    // Without this the result carries text only — no per-word timings, which
    // would make the whole transcript useless for deixis.
    recognizer.setWords(true);
    recognizer.acceptWaveform(pcm);
    const result = recognizer.finalResult() as {
      text?: string;
      result?: { word: string; start: number; end: number; conf: number }[];
    };

    const words: TranscriptWord[] = (result.result ?? []).map((w) => ({
      word: w.word,
      start: w.start,
      end: w.end,
      confidence: w.conf,
    }));

    return {
      text: result.text ?? "",
      words,
      provider: "vosk",
      durationMs: (pcm.length / 2 / SAMPLE_RATE) * 1000,
    };
  } finally {
    recognizer.free();
  }
}

const SAMPLE_RATE = 16000;

/**
 * Browsers hand us WebM/Opus; Vosk wants raw 16kHz mono PCM. ffmpeg bridges the
 * two over pipes, so nothing touches the disk.
 */
function toPcm16kMono(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      "1",
      "-f",
      "s16le",
      "pipe:1",
    ]);

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    ff.stdout.on("data", (d: Buffer) => out.push(d));
    ff.stderr.on("data", (d: Buffer) => err.push(d));

    ff.on("error", (e) =>
      reject(new SttError(`ffmpeg failed to start (is it installed?): ${e.message}`)),
    );
    ff.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new SttError(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().trim()}`));
    });

    // ffmpeg can exit before consuming all input on malformed audio; without
    // this the EPIPE takes down the process instead of surfacing as an error.
    ff.stdin.on("error", () => {});
    ff.stdin.end(input);
  });
}
