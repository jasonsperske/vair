import type { ModelAction, Vec3Object } from "./actions.js";
import type { SceneEvent } from "./events.js";
import type { Quat, Vec3 } from "./math.js";
import type { SceneDocument } from "./scene.js";
import { LIGHT_INTENSITY, lightAssetId } from "./lights.js";
import { MAX_CEILING_HEIGHT, MIN_CEILING_HEIGHT } from "./ceiling.js";
import { stylesFor } from "./surfaces.js";
import { DOOR, WALL, WALL_ASSET, clamp, isWallAsset, openingAssetFor } from "./structures.js";

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

  /**
   * Walls created earlier in THIS turn, which are not in `scene` yet — it is
   * the fold of events up to the start of the turn. "Build a room with a door
   * in the front wall" places the wall and the door in one turn, so without
   * this the door is dropped for referencing a wall that demonstrably exists.
   */
  const wallsThisTurn = new Map<string, { position: Vec3; rotation: Quat }>();

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

      case "transform_object": {
        const id = resolve(action.objectId);
        const current = id ? scene.objects.find((o) => o.id === id) : undefined;
        if (!id || !current) {
          dropped.push({ action, reason: `no object "${action.objectId}"` });
          break;
        }

        // The model restates the whole transform, so emit an event only where
        // something actually moved. Emitting all three every time would make a
        // single "undo" take back only the last of them.
        const position = toVec3(action.position);
        const rotation = yawToQuat(action.yawDegrees);
        const scale = uniformScale(action.scale);

        if (!sameVec(position, current.position)) {
          events.push({
            type: "object_moved",
            t: ctx.t,
            source: "model",
            utterance: ctx.utterance,
            objectId: id,
            position,
          });
        }
        if (!sameQuat(rotation, current.rotation)) {
          events.push({
            type: "object_rotated",
            t: ctx.t,
            source: "model",
            utterance: ctx.utterance,
            objectId: id,
            rotation,
          });
        }
        if (!sameVec(scale, current.scale)) {
          events.push({
            type: "object_scaled",
            t: ctx.t,
            source: "model",
            utterance: ctx.utterance,
            objectId: id,
            scale,
          });
        }
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

      case "place_wall": {
        const dx = action.end.x - action.start.x;
        const dz = action.end.z - action.start.z;
        const length = Math.hypot(dx, dz);
        if (length < WALL.minLength) {
          dropped.push({ action, reason: "wall endpoints are the same point" });
          break;
        }

        const objectId = ctx.newObjectId(action.name);
        const name = uniqueName(action.name, byName);
        byId.set(objectId, name);
        byName.set(normalise(name), objectId);

        const wallPosition: Vec3 = [
          (action.start.x + action.end.x) / 2,
          0,
          (action.start.z + action.end.z) / 2,
        ];
        const wallRotation = yawToQuat(wallYawDegrees(dx, dz));
        wallsThisTurn.set(objectId, { position: wallPosition, rotation: wallRotation });

        events.push({
          type: "object_placed",
          t: ctx.t,
          source: "model",
          utterance: ctx.utterance,
          objectId,
          name,
          assetId: WALL_ASSET,
          // Origin at the wall's base midpoint, so its geometry is built from
          // the floor up and the door offsets are measured along local X.
          position: wallPosition,
          rotation: wallRotation,
          // Left uniform: the real dimensions live in parameters, so geometry
          // built at true size is not scaled a second time.
          scale: [1, 1, 1],
          parameters: {
            length: Math.min(WALL.maxLength, length),
            height: clamp(action.height, WALL.minHeight, WALL.maxHeight),
            thickness: WALL.thickness,
            style: action.style,
          },
        });
        break;
      }

      case "place_opening": {
        const wallId = resolve(action.wallId);
        const existing = wallId ? scene.objects.find((o) => o.id === wallId) : undefined;
        const wall =
          existing && isWallAsset(existing.assetId)
            ? { position: existing.position, rotation: existing.rotation }
            : wallId
              ? wallsThisTurn.get(wallId)
              : undefined;
        if (!wallId || !wall) {
          dropped.push({ action, reason: `no wall "${action.wallId}" to cut into` });
          break;
        }

        const objectId = ctx.newObjectId(action.name);
        const name = uniqueName(action.name, byName);
        byId.set(objectId, name);
        byName.set(normalise(name), objectId);

        // The door's world transform is derived from its wall at render time,
        // so the event carries the relationship rather than a duplicate copy of
        // the wall's position that could drift if the wall moved.
        events.push({
          type: "object_placed",
          t: ctx.t,
          source: "model",
          utterance: ctx.utterance,
          objectId,
          name,
          assetId: openingAssetFor(action.kind),
          position: wall.position,
          rotation: wall.rotation,
          scale: [1, 1, 1],
          parameters: {
            wallId,
            kind: action.kind,
            offset: clamp(action.offset, 0, 1),
            width: clamp(action.width, DOOR.minWidth, DOOR.maxWidth),
            height: clamp(action.height, DOOR.minHeight, DOOR.maxHeight),
            // A door ignores whatever sill it was given: it starts at the floor
            // by definition, and a raised one would be a hole to step over.
            sill: action.kind === "door" ? 0 : clamp(action.sill, 0, DOOR.maxSill),
            style: action.style,
            open: 0,
          },
        });
        break;
      }

      case "set_open": {
        const id = resolve(action.objectId);
        if (!id) {
          dropped.push({ action, reason: `nothing called "${action.objectId}" to open` });
          break;
        }
        events.push({
          type: "parameter_set",
          t: ctx.t,
          source: "model",
          utterance: ctx.utterance,
          objectId: id,
          parameter: "open",
          value: clamp(action.open, 0, 1),
        });
        break;
      }

      case "set_surface": {
        // The grammar allows any style on any surface; legality is checked
        // here so a mismatch drops one action instead of failing the turn.
        if (!stylesFor(action.surface).includes(action.style)) {
          dropped.push({
            action,
            reason: `"${action.style}" is not a ${action.surface} style`,
          });
          break;
        }

        const environment =
          action.surface === "ground"
            ? { groundMaterial: action.style as never, groundVisible: action.style !== "void" }
            : action.surface === "sky"
              ? { sky: action.style as never }
              : {
                  ceiling: action.style as never,
                  ceilingHeight: clamp(action.height, MIN_CEILING_HEIGHT, MAX_CEILING_HEIGHT),
                };

        events.push({
          type: "environment_set",
          t: ctx.t,
          source: "model",
          utterance: ctx.utterance,
          environment,
        });
        break;
      }

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

/** Loose comparison: model floats never round-trip exactly. */
function sameVec(a: Vec3, b: Vec3): boolean {
  return a.every((n, i) => Math.abs(n - b[i]!) < 1e-4);
}

function sameQuat(a: Quat, b: Quat): boolean {
  return a.every((n, i) => Math.abs(n - b[i]!) < 1e-4);
}

function toVec3(v: Vec3Object): Vec3 {
  return [v.x, v.y, v.z];
}

/**
 * Yaw that puts a wall's local +X along the line from start to end.
 *
 * A rotation of theta about +Y maps local X to (cos, 0, -sin), so aligning it
 * with (dx, dz) needs atan2(-dz, dx) rather than the atan2(dx, dz) that a
 * forward-facing object would use.
 */
function wallYawDegrees(dx: number, dz: number): number {
  return (Math.atan2(-dz, dx) * 180) / Math.PI;
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
