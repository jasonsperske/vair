import { synthesizeTranscript, type TranscriptResponse } from "@vair/shared";

/**
 * The `STT_PROVIDER=mock` implementation.
 *
 * Returns a scripted transcript regardless of the audio uploaded, so the M1
 * upload path can be built and debugged before any provider is chosen or paid
 * for. Word timings come from shared/mock-stt.ts, the same synthesiser the
 * client's debug bridge uses — one implementation, no drift.
 *
 * This is a test double. It is not a fallback, and `capabilities().stt` being
 * true because of it must never be read as "STT works".
 */

const DEFAULT_SCRIPT = "put a cube here";

let script = DEFAULT_SCRIPT;
/** Matches the client's default utterance length so timings line up. */
let durationMs = 1800;

export function setScript(text: string, ms?: number): void {
  script = text;
  if (ms !== undefined) durationMs = ms;
}

export function getScript(): { text: string; durationMs: number } {
  return { text: script, durationMs };
}

export function transcribeMock(): TranscriptResponse {
  return synthesizeTranscript(script, { durationMs, provider: "mock" });
}
