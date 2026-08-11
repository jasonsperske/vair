import type { SceneEvent, SceneObject } from "@vair/shared";
import { foldScene, isLightAsset } from "@vair/shared";
import { primitiveFor, type ObjectRegistry } from "./registry.js";
import { applyLightParameter, createLight, type LightParameters } from "./lights.js";
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
        this.registry.add(object, nodeFor(object));
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

      case "object_removed":
        this.registry.remove(e.objectId);
        break;

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
        if (node) applyLightParameter(node, e.parameter, e.value);
        break;
      }

      // Neither changes the scene graph: a save names the scene, the other
      // touches document-level state the fold already owns.
      case "scene_saved":
      case "scene_created":
        break;
    }
  }

  private rebuild(): void {
    this.registry.clear();
    for (const object of foldScene(this.log.all(), Date.now()).objects) {
      this.registry.add(object, nodeFor(object));
    }
    this.syncEnvironment();
  }
}

/**
 * A placed object becomes either a light or a mesh, decided by its asset id.
 *
 * Primitives only for props so far. M3 proper swaps that for a GLTFLoader keyed
 * on assetId, with the primitive kept as the §14 fallback.
 */
function nodeFor(object: SceneObject) {
  if (isLightAsset(object.assetId)) {
    return createLight(object.assetId, {
      color: (object.parameters.color as LightParameters["color"]) ?? "neutral",
      intensity: typeof object.parameters.intensity === "number" ? object.parameters.intensity : 5,
    });
  }
  return primitiveFor(object.assetId);
}
