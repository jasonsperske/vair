import { z } from "zod";
import { Vec3 } from "./math.js";

/**
 * plan.md §6.
 *
 * The client supplies EVERY candidate measurement for a deictic token and the
 * model picks which one the linguistic form implies. Client does physics, model
 * does interpretation. Do not add client-side heuristics that pre-select one of
 * these fields — that is the model's job and it has the sentence.
 */

export const PointHit = z.object({
  position: Vec3,
  normal: Vec3,
  /** null when the ray hit the ground plane or nothing registered. */
  objectId: z.string().nullable(),
});
export type PointHit = z.infer<typeof PointHit>;

export const Ray = z.object({
  origin: Vec3,
  direction: Vec3,
});
export type Ray = z.infer<typeof Ray>;

export const MeasurementBundle = z.object({
  /** The word's start time, in the XR frame clock domain (ms). */
  tokenTime: z.number(),
  /** The deictic token as transcribed ("here", "this high", ...). */
  token: z.string(),
  /** Which hand was doing the deixis, as chosen by recency of motion. */
  hand: z.enum(["left", "right", "none"]),

  pointHit: PointHit.nullable(),
  handHeightAboveFloor: z.number(),
  twoHandSpan: z.number().nullable(),
  gazeRay: Ray,
  palmNormal: Vec3,
  /** Radians. For resolving "back", "left", "closer". */
  headYaw: z.number(),
  headPosition: Vec3,
  /** 0..1. Fraction of valid tracking samples in a window around tokenTime. */
  trackingConfidence: z.number().min(0).max(1),
});
export type MeasurementBundle = z.infer<typeof MeasurementBundle>;

/**
 * Tokens that trigger a measurement bundle lookup. Multi-word forms are matched
 * on their leading word and then extended; see client/src/input/deixis.ts.
 */
export const DEICTIC_TOKENS = [
  "here",
  "there",
  "this",
  "that",
  "these",
  "those",
] as const;
