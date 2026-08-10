import type { TranscriptResponse, TranscriptWord } from "./protocol.js";

/**
 * A mock STT provider for development. Turns a string into a TranscriptResponse
 * with plausible per-word timings.
 *
 * This lives in shared/ so the server's `STT_PROVIDER=mock` path and the
 * client's debug bridge produce IDENTICAL timings. Two separate fake
 * transcribers would drift, and then a deixis bug would reproduce under one and
 * not the other.
 *
 * IMPORTANT — what this does and does not prove.
 *
 * Word times here are synthesised from word length, not measured from audio.
 * That is fine for exercising temporal binding (the pose lookup, the clock
 * conversion, the ring buffer window) because those care only that a word has a
 * distinct, plausible timestamp. It proves NOTHING about a real provider's
 * accuracy, and it must never be used to justify skipping the word-level
 * timestamp requirement in plan.md §6.3. It is a test double, not a fallback.
 */

export type SynthesizeOptions = {
  /** Wall-clock length of the whole utterance. */
  durationMs?: number;
  provider?: string;
};

const DEFAULT_DURATION_MS = 1800;
/** Silence between words. Real speech has more, but this keeps tokens distinct. */
const INTER_WORD_GAP_S = 0.04;

export function synthesizeTranscript(
  text: string,
  opts: SynthesizeOptions = {},
): TranscriptResponse {
  const durationMs = Math.max(1, opts.durationMs ?? DEFAULT_DURATION_MS);
  const tokens = text.trim().split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return { text: "", words: [], provider: opts.provider ?? "mock", durationMs };
  }

  // Weight by syllable count so "cube" and "immediately" do not get the same
  // slice. A deictic word landing at the wrong point in the utterance would
  // make the mock useless for exactly the thing it exists to test.
  const weights = tokens.map(syllables);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const totalS = durationMs / 1000;
  const gapTotal = INTER_WORD_GAP_S * (tokens.length - 1);
  const speechS = Math.max(0.001, totalS - gapTotal);

  const words: TranscriptWord[] = [];
  let cursor = 0;
  for (let i = 0; i < tokens.length; i++) {
    const span = (weights[i]! / totalWeight) * speechS;
    words.push({
      word: tokens[i]!,
      start: round(cursor),
      end: round(cursor + span),
      confidence: 1,
    });
    cursor += span + INTER_WORD_GAP_S;
  }

  return {
    text: tokens.join(" "),
    words,
    provider: opts.provider ?? "mock",
    durationMs,
  };
}

/** Vowel-group count, floored at one. Crude, deterministic, good enough. */
function syllables(word: string): number {
  const groups = word.toLowerCase().replace(/[^a-z]/g, "").match(/[aeiouy]+/g);
  return Math.max(1, groups?.length ?? 1);
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
