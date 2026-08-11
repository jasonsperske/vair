import { z } from "zod";

/**
 * The model-facing action vocabulary — the one validated schema boundary for
 * model output (plan.md §16).
 *
 * This is deliberately NOT the SceneEvent schema. Events carry `id`, `seq`, `t`
 * and `source`: bookkeeping the event log owns and the model has no business
 * inventing. The model proposes intent; the client turns intent into events and
 * assigns identity. See applyActions in apply.ts.
 *
 * Three shape choices here differ from the storage schema, all for the same
 * reason — structured outputs are most reliable on plain required object
 * fields:
 *
 *  1. `{x,y,z}` objects rather than the [x,y,z] tuples used in scene.ts. Tuples
 *     cost fewer tokens (which is why storage uses them) but serialise to
 *     JSON Schema as positional array constraints, which the structured-output
 *     support matrix does not cover. The expander converts.
 *  2. `yawDegrees` rather than a quaternion. Asking a model for four
 *     normalised floats invites silently unnormalised rotations; yaw is the
 *     only axis a placed prop realistically needs.
 *  3. Every field required, no defaults. An optional field in a structured
 *     output schema is a field the model can quietly omit.
 */

export const Vec3Object = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});
export type Vec3Object = z.infer<typeof Vec3Object>;

export const ModelAction = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("place_object"),
    /**
     * plan.md §8 — the reference surface for every later command. Human,
     * speakable, unique within the scene.
     */
    name: z.string(),
    /** Must come from the catalogue in the system prompt. */
    assetId: z.string(),
    /** World space, metres, y=0 is the floor. */
    position: Vec3Object,
    yawDegrees: z.number(),
    /** Uniform multiplier on the asset's natural size. 1 = as authored. */
    scale: z.number(),
  }),
  z.object({
    action: z.literal("move_object"),
    objectId: z.string(),
    position: Vec3Object,
  }),
  z.object({
    action: z.literal("rotate_object"),
    objectId: z.string(),
    yawDegrees: z.number(),
  }),
  z.object({
    action: z.literal("scale_object"),
    objectId: z.string(),
    scale: z.number(),
  }),
  z.object({
    action: z.literal("rename_object"),
    objectId: z.string(),
    name: z.string(),
  }),
  z.object({
    action: z.literal("remove_object"),
    objectId: z.string(),
  }),
  /**
   * "save this" / "save this as the campfire".
   *
   * The name is required, so the model always supplies one: verbatim when the
   * user said it, invented from what is actually in the scene when they didn't.
   * Naming therefore costs no extra round trip — it falls out of the turn that
   * was already happening.
   */
  z.object({
    action: z.literal("save_scene"),
    name: z.string(),
  }),
  /**
   * "exit" / "I'm done". Ends the immersive session and returns to the landing
   * page.
   *
   * "save and exit" needs no special case: the model emits save_scene followed
   * by exit_session and the existing in-order application does the rest. It
   * must be the last action in a turn — anything after it acts on a session
   * that is already gone.
   */
  z.object({
    action: z.literal("exit_session"),
  }),
]);
export type ModelAction = z.infer<typeof ModelAction>;

/**
 * plan.md §14 — `speech` is spoken aloud and must never be "I can't find that".
 * `question` is non-null only when the model genuinely cannot proceed, and
 * drives the NEEDS_INPUT / amber state in §7.
 */
/**
 * Field order is load-bearing. Structured output is emitted in schema order, so
 * `actions` first means the first object commits to the scene before the model
 * has written a word of the sentence describing it — worth roughly the length
 * of `speech` in time-to-first-object, on every turn.
 *
 * `speech` reads better last anyway: it describes work already decided.
 */
export const TurnResponse = z.object({
  actions: z.array(ModelAction),
  speech: z.string(),
  question: z.string().nullable(),
});
export type TurnResponse = z.infer<typeof TurnResponse>;

/**
 * The wire format of a streamed turn — NDJSON, one event per line.
 *
 * plan.md §12 (M3): objects populate as they resolve. Each `action` event is
 * committed to the event log the moment it arrives, so the first object is
 * visible long before the model has finished writing the rest of the turn.
 *
 * Every action carried here has already been validated individually against
 * ModelAction, so a client can apply it without waiting for `done`.
 */
export const TurnStreamEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("action"), action: ModelAction }),
  z.object({
    type: z.literal("done"),
    speech: z.string(),
    question: z.string().nullable(),
  }),
  z.object({
    type: z.literal("error"),
    error: z.string(),
    detail: z.string().optional(),
    /**
     * True when nothing was committed, so the caller may safely retry. False
     * once any action has been applied — retrying then would double-apply.
     */
    retryable: z.boolean(),
  }),
]);
export type TurnStreamEvent = z.infer<typeof TurnStreamEvent>;
