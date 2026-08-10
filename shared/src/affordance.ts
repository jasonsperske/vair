import { z } from "zod";

/**
 * plan.md §9.
 *
 * The model ships the grammar with the payload. Client code stays generic and
 * never needs to know what a lamp is — if you find yourself writing
 * `if (type === "lamp")` anywhere in the client, this type is being bypassed.
 */
export const Affordance = z.object({
  /** Human-facing, e.g. "smaller / larger". */
  label: z.string(),
  /** Path into the object's parameters, e.g. "scale" or "material.emissive". */
  parameter: z.string(),
  axis: z.enum(["x", "y", "z"]).optional(),
  /** Phrases that fire this affordance. Lowercase, no punctuation. */
  triggers: z.array(z.string()).min(1),
  direction: z.union([z.literal(1), z.literal(-1)]),
  /** Multiplicative for scale-like parameters, additive for positional ones. */
  step: z.number(),
  mode: z.enum(["multiply", "add"]).default("multiply"),
  min: z.number().optional(),
  max: z.number().optional(),
});
export type Affordance = z.infer<typeof Affordance>;

/** plan.md §9 — "a little" / "somewhat" / "much" / "way". */
export const MAGNITUDE_MODIFIERS: Record<string, number> = {
  "a tiny bit": 0.25,
  "a little": 0.4,
  "a bit": 0.4,
  slightly: 0.4,
  somewhat: 0.7,
  "": 1,
  much: 2,
  "a lot": 2,
  way: 3,
  loads: 3,
};

/**
 * Bias hard toward escalation (plan.md §9). A wrong local match produces a
 * confident incorrect action; a missed match costs one round trip.
 */
export const LOCAL_MATCH_CONFIDENCE_THRESHOLD = 0.9;
