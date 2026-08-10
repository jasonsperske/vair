import { z } from "zod";
import { SceneEvent } from "./events.js";
import { Vec3 } from "./math.js";
import { MeasurementBundle } from "./measurement.js";
import { SceneDocument } from "./scene.js";

/**
 * The one validated schema boundary every model interaction goes through
 * (plan.md §16). If Claude returns something unparseable: retry once with the
 * validation error appended, then fail loudly. Do not add a lenient fallback
 * parser — a silently-coerced payload is how a wrong scene gets built.
 */

/* ------------------------------------------------------------------ STT --- */

/**
 * Word-level timestamps are a hard requirement, not a preference (plan.md §6.3).
 * A provider that returns only utterance-level timing cannot drive deixis and
 * must be rejected at integration time, not worked around here.
 */
export const TranscriptWord = z.object({
  word: z.string(),
  /** Seconds from utterance start. Converted to XR clock by the client. */
  start: z.number(),
  end: z.number(),
  confidence: z.number().min(0).max(1).optional(),
});
export type TranscriptWord = z.infer<typeof TranscriptWord>;

export const TranscriptResponse = z.object({
  text: z.string(),
  words: z.array(TranscriptWord),
  /** Provider id, for the latency tables in tools/. */
  provider: z.string(),
  durationMs: z.number(),
});
export type TranscriptResponse = z.infer<typeof TranscriptResponse>;

/* --------------------------------------------------------------- Claude --- */

/**
 * plan.md §10 — capabilities the user enabled in the companion web app, injected
 * into the system prompt each turn. Ungated failures must be graceful and spoken
 * ("I can't do that yet — you can enable it on the web"), never a silent no-op.
 */
export const CapabilityManifest = z.object({
  capabilities: z.array(z.string()).default([]),
});
export type CapabilityManifest = z.infer<typeof CapabilityManifest>;

/**
 * Where the user is standing and facing right now. Without this the model has
 * no frame for "in front of me" or "over there" on an utterance that contains
 * no deictic token at all — which is most of them, including "create a cube".
 */
export const Viewer = z.object({
  position: Vec3,
  /** Radians about world +Y. 0 faces -Z. */
  yaw: z.number(),
});
export type Viewer = z.infer<typeof Viewer>;

export const TurnRequest = z.object({
  sceneId: z.string(),
  utterance: z.string(),
  viewer: Viewer,
  /** One per deictic token found in the transcript. */
  measurements: z.array(MeasurementBundle).default([]),
  /**
   * plan.md §8 — events applied since the last model turn, so locally-handled
   * edits never leave the model reasoning about stale state.
   */
  eventsSinceLastTurn: z.array(SceneEvent).default([]),
  scene: SceneDocument,
  manifest: CapabilityManifest.default({ capabilities: [] }),
});
export type TurnRequest = z.infer<typeof TurnRequest>;

// TurnResponse lives in actions.ts — the model returns actions, not events.
// Events carry id/seq/t/source, which the event log owns and the model must
// not invent. See actions.ts for why that boundary is where it is.

/* --------------------------------------------------------------- Assets --- */

export const AssetEntry = z.object({
  id: z.string(),
  name: z.string(),
  /** Search surface: "oak table", "dining table", "desk". */
  tags: z.array(z.string()),
  url: z.string(),
  /** Metres, for sane default scaling on placement. */
  boundsY: z.number().optional(),
  /** CC0 provenance is not optional — see plan.md §4. */
  license: z.literal("CC0"),
  attribution: z.string().optional(),
});
export type AssetEntry = z.infer<typeof AssetEntry>;

export const AssetCatalogue = z.object({
  entries: z.array(AssetEntry),
});
export type AssetCatalogue = z.infer<typeof AssetCatalogue>;

/* ------------------------------------------------------------- Latency --- */

/**
 * plan.md §16 — instrument stages, not totals, and write it in M1 rather than
 * retrofitting timestamps later. tools/ reads these names directly.
 */
export const LATENCY_STAGES = [
  "utterance_start",
  "vad_end",
  "upload_start",
  "transcript_ready",
  "intent_resolved",
  "scene_mutated",
  "frame_presented",
] as const;
export type LatencyStage = (typeof LATENCY_STAGES)[number];

export const LatencySample = z.object({
  turnId: z.string(),
  /** Which path handled it — the two must stay indistinguishable to the user. */
  path: z.enum(["local", "server"]),
  stages: z.record(z.number()),
});
export type LatencySample = z.infer<typeof LatencySample>;
