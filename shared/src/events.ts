import { z } from "zod";
import { Quat, Vec3 } from "./math.js";
import { Affordance } from "./affordance.js";
import { Environment } from "./scene.js";

/**
 * plan.md §8 — event-sourced. Every command, local or model-driven, appends an
 * immutable event; scene state is a fold over the log. Undo, replay and
 * shareable history all fall out of that one decision.
 *
 * Local affordance edits (§9) append here too. Do not build a second log.
 */

const base = {
  id: z.string(),
  seq: z.number().int().nonnegative(),
  /** Wall clock ms at append time. */
  t: z.number(),
  source: z.enum(["local", "model", "system"]),
  /** The utterance responsible, when there was one. Annotation only. */
  utterance: z.string().optional(),
};

export const SceneEvent = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("scene_created"),
    sceneId: z.string(),
    name: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("object_placed"),
    objectId: z.string(),
    name: z.string(),
    assetId: z.string(),
    position: Vec3,
    rotation: Quat,
    scale: Vec3,
    parameters: z.record(z.union([z.number(), z.string(), z.boolean()])).optional(),
    affordances: z.array(Affordance).optional(),
  }),
  z.object({
    ...base,
    type: z.literal("object_moved"),
    objectId: z.string(),
    position: Vec3,
  }),
  z.object({
    ...base,
    type: z.literal("object_rotated"),
    objectId: z.string(),
    rotation: Quat,
  }),
  z.object({
    ...base,
    type: z.literal("object_scaled"),
    objectId: z.string(),
    scale: Vec3,
  }),
  z.object({
    ...base,
    type: z.literal("object_renamed"),
    objectId: z.string(),
    name: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("object_removed"),
    objectId: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("parameter_set"),
    objectId: z.string(),
    parameter: z.string(),
    value: z.union([z.number(), z.string(), z.boolean()]),
  }),
  z.object({
    ...base,
    type: z.literal("environment_set"),
    environment: Environment.partial(),
  }),
  /**
   * Undo is itself an event. The fold skips the referenced event rather than
   * truncating the log, so history stays replayable and shareable.
   */
  z.object({
    ...base,
    type: z.literal("undone"),
    targetEventId: z.string(),
  }),
]);
export type SceneEvent = z.infer<typeof SceneEvent>;
export type SceneEventType = SceneEvent["type"];

export const EventLog = z.array(SceneEvent);
export type EventLog = z.infer<typeof EventLog>;

/** Events that an `undone` event may target. */
export function isUndoable(e: SceneEvent): boolean {
  return e.type !== "undone" && e.type !== "scene_created";
}
