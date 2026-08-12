import { z } from "zod";
import { LIGHT_COLORS, LIGHT_KINDS } from "./lights.js";
import { SURFACE_STYLES } from "./surfaces.js";
import { OPENING_KINDS, OPENING_STYLES, WALL_STYLES } from "./structures.js";

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
  /**
   * Move, turn and resize in one action, always restating the whole transform
   * rather than sending a delta — the same "state, not diff" rule adjust_light
   * follows. The expander compares against the scene and emits events only for
   * the parts that actually changed, so undo stays meaningful.
   */
  z.object({
    action: z.literal("transform_object"),
    objectId: z.string(),
    position: Vec3Object,
    yawDegrees: z.number(),
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
  /**
   * "put a warm light above the table", "add a sun".
   *
   * Expands to an ordinary object_placed event — a light is a scene object, so
   * it is named, movable, removable, saveable and undoable for free.
   */
  z.object({
    action: z.literal("place_light"),
    name: z.string(),
    kind: z.enum(LIGHT_KINDS),
    position: Vec3Object,
    color: z.enum(LIGHT_COLORS),
    /** 0 (off) to 10 (floodlight). 5 is an ordinary lamp. */
    intensity: z.number(),
  }),
  /**
   * "make the lamp warmer", "turn the sun down".
   *
   * Both fields are required, so the model always restates the whole state of
   * the light rather than sending a delta the client would have to merge.
   */
  z.object({
    action: z.literal("adjust_light"),
    objectId: z.string(),
    color: z.enum(LIGHT_COLORS),
    intensity: z.number(),
  }),
  /**
   * Overall brightness of the void itself, 0 to 10. Distinct from a placed
   * light: this is the ambient fill that keeps unlit faces from going black.
   */
  /**
   * The floor, the sky and the ceiling are one action rather than three: they
   * are the same shape, and three near-identical variants cost real space in
   * the compiled output grammar — enough that adding walls tipped the request
   * over the API's limit.
   *
   * `style` is the combined vocabulary; the expander checks it against the
   * surface named and drops the action if they do not match, rather than
   * failing the whole turn.
   */
  z.object({
    action: z.literal("set_surface"),
    surface: z.enum(["ground", "sky", "ceiling"]),
    style: z.enum(SURFACE_STYLES),
    /** Metres. Only meaningful for the ceiling; ignored otherwise. */
    height: z.number(),
  }),
  z.object({
    action: z.literal("set_ambient"),
    intensity: z.number(),
  }),
  /**
   * "put a wall from here to there", "wall off that side".
   *
   * Endpoints, not centre-and-length: the natural phrasing produces two deictic
   * tokens and therefore two measurement bundles, one per end.
   */
  z.object({
    action: z.literal("place_wall"),
    name: z.string(),
    start: Vec3Object,
    end: Vec3Object,
    /** Metres from the floor. */
    height: z.number(),
    style: z.enum(WALL_STYLES),
  }),
  /**
   * "put a door in that wall", "place a window in this wall".
   *
   * An opening belongs to a wall and cuts a real hole in it — the wall is
   * rebuilt as segments around it rather than having a panel laid over the top.
   * `offset` is a fraction along the wall so "in the middle" is 0.5 and the
   * model never has to work in metres from an end it cannot see.
   *
   * A door is an opening with sill 0; a window is one that starts partway up.
   */
  z.object({
    action: z.literal("place_opening"),
    name: z.string(),
    /** id of the wall this is cut into. */
    wallId: z.string(),
    kind: z.enum(OPENING_KINDS),
    /** 0 at the wall's start, 1 at its end. */
    offset: z.number(),
    width: z.number(),
    height: z.number(),
    /** Metres from the floor to the bottom edge. 0 for a door. */
    sill: z.number(),
    style: z.enum(OPENING_STYLES),
  }),
  /** "open the door", "shut the window" — 0 is closed, 1 is fully open. */
  z.object({
    action: z.literal("set_open"),
    objectId: z.string(),
    open: z.number(),
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
