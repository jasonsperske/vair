import { z } from "zod";
import { Quat, Vec3 } from "./math.js";
import { Affordance } from "./affordance.js";

/**
 * plan.md §8. JSON, not XML. Resolved absolutes only — never a gesture phrase.
 * "Make the door this high" is meaningless to someone opening a shared scene,
 * so we write `scale: [1, 2.0, 1]` and keep the utterance as annotation.
 */

export const SceneObject = z.object({
  id: z.string(),
  /**
   * The reference surface for every later command. Stable, human-speakable,
   * unique within a scene. Model-assigned unless the user named it.
   */
  name: z.string(),
  /** Catalogue key resolved by /api/assets, or a primitive fallback. */
  assetId: z.string(),
  position: Vec3,
  rotation: Quat,
  scale: Vec3,
  /** Free-form model-supplied parameters, addressed by Affordance.parameter. */
  parameters: z.record(z.union([z.number(), z.string(), z.boolean()])).default({}),
  affordances: z.array(Affordance).default([]),
  /** The utterance that created this object. Annotation only, never authoritative. */
  utterance: z.string().optional(),
  createdAt: z.number(),
});
export type SceneObject = z.infer<typeof SceneObject>;

export const Environment = z.object({
  /** plan.md §2 — fully immersive void. No passthrough, ever. */
  groundVisible: z.boolean().default(false),
  groundMaterial: z.string().default("void"),
  /** 0..24, drives the ambient key shift in M5. */
  timeOfDay: z.number().min(0).max(24).default(12),
  ambientIntensity: z.number().default(0.15),
});
export type Environment = z.infer<typeof Environment>;

export const SceneDocument = z.object({
  id: z.string(),
  name: z.string(),
  version: z.literal(1),
  environment: Environment,
  objects: z.array(SceneObject),
  /**
   * Derived on save from scene state, never edited by hand and never read back
   * as truth (plan.md §8). Two sources of truth drift within a week.
   */
  narrative: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type SceneDocument = z.infer<typeof SceneDocument>;

export function emptyScene(id: string, name: string, now: number): SceneDocument {
  return {
    id,
    name,
    version: 1,
    environment: Environment.parse({}),
    objects: [],
    createdAt: now,
    updatedAt: now,
  };
}
