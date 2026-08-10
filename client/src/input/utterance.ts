import type { MeasurementBundle, TranscriptResponse, TranscriptWord } from "@vair/shared";
import { clock } from "../core/clock.js";
import { findDeicticTokens, resolveMeasurement, type ResolveOptions } from "./deixis.js";

/**
 * The seam where a transcript becomes measurements (plan.md §6.4).
 *
 * Everything upstream of this — real STT, the mock provider — produces a
 * TranscriptResponse and nothing else. Everything downstream consumes
 * measurement bundles. Keeping that boundary sharp is what lets the mock
 * exercise the real temporal binding path rather than a parallel one.
 */
export type ResolvedUtterance = {
  text: string;
  words: TranscriptWord[];
  /** XR frame time of word 0. Every word time is an offset from this. */
  utteranceStartXrTime: number;
  measurements: MeasurementBundle[];
  /**
   * Deictic tokens whose pose had already fallen out of the ring buffer, or
   * that landed while tracking was lost. Surfaced rather than swallowed: a
   * silently dropped "here" is the difference between a lamp on the table and
   * a lamp at the world origin.
   */
  unresolved: { token: string; tokenTime: number }[];
};

export function resolveUtterance(
  transcript: TranscriptResponse,
  utteranceStartXrTime: number,
  opts: ResolveOptions,
): ResolvedUtterance {
  const measurements: MeasurementBundle[] = [];
  const unresolved: { token: string; tokenTime: number }[] = [];

  for (const token of findDeicticTokens(transcript.words)) {
    const tokenTime = clock.wordTimeToXrTime(token.start, utteranceStartXrTime);
    const bundle = resolveMeasurement(token.token, tokenTime, opts);
    if (bundle) measurements.push(bundle);
    else unresolved.push({ token: token.token, tokenTime });
  }

  return {
    text: transcript.text,
    words: transcript.words,
    utteranceStartXrTime,
    measurements,
    unresolved,
  };
}

/** One-line summary for the debug HUD. */
export function summariseUtterance(u: ResolvedUtterance): string {
  if (u.measurements.length === 0) {
    return u.unresolved.length > 0
      ? `${u.unresolved.length} deictic token(s) unresolved — pose outside buffer`
      : "no deictic tokens";
  }
  const first = u.measurements[0]!;
  const where = first.pointHit
    ? `hit ${first.pointHit.position.map((n) => n.toFixed(2)).join(",")}`
    : `height ${first.handHeightAboveFloor.toFixed(2)}m`;
  return `"${first.token}" ${first.hand} ${where} conf ${first.trackingConfidence.toFixed(2)}`;
}
