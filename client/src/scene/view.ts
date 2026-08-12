import type { SceneEvent, SceneObject } from "@vair/shared";
import { foldScene, isDoorAsset, isLightAsset, isWallAsset } from "@vair/shared";
import { primitiveFor, type ObjectRegistry } from "./registry.js";
import { applyLightParameter, createLight, type LightParameters } from "./lights.js";
import {
  applyDoorParameter,
  createDoor,
  createWall,
  doorDimsOf,
} from "./structures.js";
import type { SceneEnvironment } from "../vfx/environment.js";
import type { EventLogStore } from "./event-log.js";

/**
 * Keeps the three.js scene graph in step with the event log.
 *
 * The log is authoritative; this is a projection of it (plan.md §8). Updates
 * are applied incrementally rather than by rebuilding on every event — a
 * rebuild would drop and recreate every mesh, which shows up as a visible
 * flicker in a headset and throws away loaded geometry.
 */
export class SceneView {
  constructor(
    private readonly registry: ObjectRegistry,
    private readonly log: EventLogStore,
    private readonly environment: SceneEnvironment,
  ) {
    log.onAppend((e) => this.apply(e));
    // A load replaces the whole log, so incremental application has nothing to
    // work from — rebuild instead.
    log.onReload(() => this.rebuild());
    this.syncEnvironment();
  }

  /** Driven by the folded document, so a loaded scene restores its floor and
   * brightness rather than only the events that happened to arrive live. */
  private syncEnvironment(): void {
    this.environment.apply(this.log.scene().environment);
  }

  private apply(e: SceneEvent): void {
    switch (e.type) {
      case "object_placed": {
        const object: SceneObject = {
          id: e.objectId,
          name: e.name,
          assetId: e.assetId,
          position: e.position,
          rotation: e.rotation,
          scale: e.scale,
          parameters: e.parameters ?? {},
          affordances: e.affordances ?? [],
          utterance: e.utterance,
          createdAt: e.t,
        };
        this.registry.add(object, this.nodeFor(object));
        // A new door cuts an opening, so its wall must be rebuilt around it.
        if (isDoorAsset(object.assetId)) this.rebuildWall(doorDimsOf(object).wallId);
        break;
      }

      case "object_moved":
        this.registry.get(e.objectId)?.position.fromArray(e.position);
        break;

      case "object_rotated":
        this.registry.get(e.objectId)?.quaternion.fromArray(e.rotation);
        break;

      case "object_scaled":
        this.registry.get(e.objectId)?.scale.fromArray(e.scale);
        break;

      case "object_renamed": {
        const node = this.registry.get(e.objectId);
        if (node) node.name = e.name;
        break;
      }

      case "object_removed": {
        // Note the wall before the door is gone, so the opening can close up.
        const doomed = this.objectById(e.objectId);
        const wallId = doomed && isDoorAsset(doomed.assetId) ? doorDimsOf(doomed).wallId : null;
        this.registry.remove(e.objectId);
        if (wallId) this.rebuildWall(wallId);
        break;
      }

      case "undone":
        // Undo is an event, so the cheapest correct response is to re-fold and
        // rebuild. Undo is not a hot path; correctness beats the flicker here.
        this.rebuild();
        break;

      // Applied from the folded document rather than the event, so a partial
      // event still resolves against the scene's current environment.
      case "environment_set":
        this.syncEnvironment();
        break;

      case "parameter_set": {
        const node = this.registry.get(e.objectId);
        if (!node) break;
        if (applyLightParameter(node, e.parameter, e.value)) break;
        if (applyDoorParameter(node, e.parameter, e.value)) break;
        // Anything else changes geometry rather than a uniform, so rebuild.
        this.refresh(e.objectId);
        break;
      }

      // Neither changes the scene graph: a save names the scene, the other
      // touches document-level state the fold already owns.
      case "scene_saved":
      case "scene_created":
        break;
    }
  }

  private objectById(id: string): SceneObject | undefined {
    return this.log.scene().objects.find((o) => o.id === id);
  }

  /**
   * A placed object becomes a light, a wall, a door or a mesh, decided by its
   * asset id.
   *
   * Primitives only for props so far. M3 proper swaps that for a GLTFLoader
   * keyed on assetId, with the primitive kept as the §14 fallback.
   */
  private nodeFor(object: SceneObject) {
    if (isLightAsset(object.assetId)) {
      return createLight(object.assetId, {
        color: (object.parameters.color as LightParameters["color"]) ?? "neutral",
        intensity:
          typeof object.parameters.intensity === "number" ? object.parameters.intensity : 5,
      });
    }
    if (isWallAsset(object.assetId)) {
      return createWall(object, this.doorsFor(object.id));
    }
    if (isDoorAsset(object.assetId)) {
      return createDoor(object, this.objectById(doorDimsOf(object).wallId));
    }
    return primitiveFor(object.assetId);
  }

  private doorsFor(wallId: string): SceneObject[] {
    return this.log
      .scene()
      .objects.filter((o) => isDoorAsset(o.assetId) && doorDimsOf(o).wallId === wallId);
  }

  /** Drop and rebuild one object's node, for changes geometry depends on. */
  private refresh(id: string): void {
    const object = this.objectById(id);
    if (!object) return;
    this.registry.remove(id);
    this.registry.add(object, this.nodeFor(object));
  }

  private rebuildWall(wallId: string): void {
    if (wallId) this.refresh(wallId);
  }

  private rebuild(): void {
    this.registry.clear();
    for (const object of foldScene(this.log.all(), Date.now()).objects) {
      this.registry.add(object, this.nodeFor(object));
    }
    this.syncEnvironment();
  }
}

