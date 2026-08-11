import type { ModelAction, Vec3Object } from "./actions.js";
import type { SceneEvent } from "./events.js";
import type { Quat, Vec3 } from "./math.js";
import type { SceneDocument } from "./scene.js";
import { LIGHT_INTENSITY, lightAssetId } from "./lights.js";

/**
 * Turning model intent into event drafts (plan.md §8).
 *
 * A plain `Omit` over a discriminated union collapses it to the shared keys and
 * loses every payload field. Distribute first.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event as authored at a call site: the log assigns `id` and `seq`. */
export type EventDraft = DistributiveOmit<SceneEvent, "id" | "seq"> & { id?: string };

export type ApplyContext = {
  /** Wall clock for the resulting events. */
  t: number;
  /** The utterance responsible. Annotation only, never authoritative (§8). */
  utterance: string;
  /** Mint a stable id for a newly placed object. */
  newObjectId(name: string): string;
  /** Mint a storage id for a scene from its name. */
  newSceneId(name: string): string;
};

export type ApplyResult = {
  events: EventDraft[];
  /**
   * Actions that referenced an object that isn't in the scene. Surfaced rather
   * than swallowed — a silently dropped "move the lamp" leaves the user staring
   * at an unchanged scene with no idea why.
   */
  dropped: { action: ModelAction; reason: string }[];
};

export function applyActions(
  actions: readonly ModelAction[],
  scene: SceneDocument,
  ctx: ApplyContext,
): ApplyResult {
  const events: EventDraft[] = [];
  const dropped: ApplyResult["dropped"] = [];

  // Objects placed earlier in this same turn are referenceable by later actions
  // in it — "put a table here and a lamp on it" is one turn, and the lamp's
  // action can name the table.
  const byId = new Map(scene.objects.map((o) => [o.id, o.name]));
  const byName = new Map(scene.objects.map((o) => [normalise(o.name), o.id]));

  const resolve = (ref: string): string | null =>
    byId.has(ref) ? ref : (byName.get(normalise(ref)) ?? null);

  for (const action of actions) {
    switch (action.action) {
      case "place_object": {
        const objectId = ctx.newObjectId(action.name);
        const name = uniqueName(action.name, byName);
        byId.set(objectId, name);
        byName.set(normalise(name), objectId);
        events.push({
          type: "object_placed",
          t: ctx.t,
          source: "model",
          utterance: ctx.utterance,
          objectId,
          name,
          assetId: action.assetId,
          position: toVec3(action.position),
          rotation: yawToQuat(action.yawDegrees),
          scale: uniformScale(action.scale),
        });
        break;
      }

      case "move_object": {
        const id = resolve(action.objectId);
        if (!id) {
          dropped.push({ action, reason: `no object "${action.objectId}"` });
          break;
        }
        events.push({
          type: "object_moved",
          t: ctx.t,
          source: "model",
          utterance: ctx.utterance,
          objectId: id,
          position: toVec3(action.position),
        });
        break;
      }

      case "rotate_object": {
        const id = resolve(action.objectId);
        if (!id) {
          dropped.push({ action, reason: `no object "${action.objectId}"` });
          break;
        }
        events.push({
          type: "object_rotated",
          t: ctx.t,
          source: "model",
          utterance: ctx.utterance,
          objectId: id,
          rotation: yawToQuat(action.yawDegrees),
        });
        break;
      }

      case "scale_object": {
        const id = resolve(action.objectId);
        if (!id) {
          dropped.push({ action, reason: `no object "${action.objectId}"` });
          break;
        }
        events.push({
          type: "object_scaled",
          t: ctx.t,
          source: "model",
          utterance: ctx.utterance,
          objectId: id,
          scale: uniformScale(action.scale),
        });
        break;
      }

      case "rename_object": {
        const id = resolve(action.objectId);
        if (!id) {
          dropped.push({ action, reason: `no object "${action.objectId}"` });
          break;
        }
        events.push({
          type: "object_renamed",
          t: ctx.t,
          source: "model",
          utterance: ctx.utterance,
          objectId: id,
          name: uniqueName(action.name, byName),
        });
        break;
      }

      case "save_scene": {
        // Persistence itself is a side effect the caller performs when it sees
        // this event; the event exists so the save is in the history and the
        // scene carries its name.
        events.push({
          type: "scene_saved",
          t: ctx.t,
          source: "model",
          utterance: ctx.utterance,
          sceneId: ctx.newSceneId(action.name),
          name: action.name,
        });
        break;
      }

      // Produces no event: leaving changes nothing about the scene. The caller
      // performs it as a side effect, the same way it performs the save.
      case "exit_session":
        break;

      case "place_light": {
        // An ordinary object_placed — the light's settings ride in the
        // `parameters` bag that SceneObject already carries.
        const objectId = ctx.newObjectId(action.name);
        const name = uniqueName(action.name, byName);
        byId.set(objectId, name);
        byName.set(normalise(name), objectId);
        events.push({
          type: "object_placed",
          t: ctx.t,
          source: "model",
          utterance: ctx.utterance,
          objectId,
          name,
          assetId: lightAssetId(action.kind),
          position: toVec3(action.position),
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
          parameters: {
            color: action.color,
            intensity: clampIntensity(action.intensity),
          },
        });
        break;
      }

      case "adjust_light": {
        const id = resolve(action.objectId);
        if (!id) {
          dropped.push({ action, reason: `no light "${action.objectId}"` });
          break;
        }
        // Two parameter_set events rather than one combined edit: each is
        // independently undoable, which is what the single undo stack expects.
        events.push({
          type: "parameter_set",
          t: ctx.t,
          source: "model",
          utterance: ctx.utterance,
          objectId: id,
          parameter: "intensity",
          value: clampIntensity(action.intensity),
        });
        events.push({
          type: "parameter_set",
          t: ctx.t,
          source: "model",
          utterance: ctx.utterance,
          objectId: id,
          parameter: "color",
          value: action.color,
        });
        break;
      }

      case "set_ambient":
        events.push({
          type: "environment_set",
          t: ctx.t,
          source: "model",
          utterance: ctx.utterance,
          environment: { ambientIntensity: clampIntensity(action.intensity) },
        });
        break;

      case "set_ground":
        events.push({
          type: "environment_set",
          t: ctx.t,
          source: "model",
          utterance: ctx.utterance,
          environment: {
            groundMaterial: action.style,
            // "void" is the absence of a floor rather than a material, so the
            // two fields are kept consistent here instead of asking the model
            // to remember to set both.
            groundVisible: action.style !== "void",
          },
        });
        break;

      case "remove_object": {
        const id = resolve(action.objectId);
        if (!id) {
          dropped.push({ action, reason: `no object "${action.objectId}"` });
          break;
        }
        events.push({
          type: "object_removed",
          t: ctx.t,
          source: "model",
          utterance: ctx.utterance,
          objectId: id,
        });
        break;
      }
    }
  }

  return { events, dropped };
}

function toVec3(v: Vec3Object): Vec3 {
  return [v.x, v.y, v.z];
}

/** Yaw about world +Y, degrees, to an xyzw quaternion. */
function yawToQuat(degrees: number): Quat {
  const half = (degrees * Math.PI) / 360;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

/** Clamped: a zero or negative scale makes an object invisible or inverted. */
function uniformScale(s: number): Vec3 {
  const clamped = Math.min(100, Math.max(0.01, s));
  return [clamped, clamped, clamped];
}

/** Keeps a model-supplied intensity inside the range the client can render. */
function clampIntensity(value: number): number {
  return Math.min(LIGHT_INTENSITY.max, Math.max(LIGHT_INTENSITY.min, value));
}

function normalise(name: string): string {
  return name.toLowerCase().replace(/^(the|a|an)\s+/, "").trim();
}

/**
 * Names are the reference surface for later commands (§8), so two objects
 * sharing one is a scene where "move the lamp" is ambiguous forever.
 */
function uniqueName(name: string, taken: Map<string, string>): string {
  if (!taken.has(normalise(name))) return name;
  for (let i = 2; i < 100; i++) {
    const candidate = `${name} ${i}`;
    if (!taken.has(normalise(candidate))) return candidate;
  }
  return `${name} ${Date.now()}`;
}
