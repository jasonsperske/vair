import type { SceneEvent, SceneObject } from "@vair/shared";
import { foldScene } from "@vair/shared";
import { primitiveFor, type ObjectRegistry } from "./registry.js";
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
  ) {
    log.onAppend((e) => this.apply(e));
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
        // Primitives only so far. M3 proper swaps this for a GLTFLoader keyed
        // on assetId, with the primitive kept as the §14 fallback.
        this.registry.add(object, primitiveFor(e.assetId));
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

      case "scene_created":
      case "parameter_set":
      case "environment_set":
        break;
    }
  }

  private rebuild(): void {
    this.registry.clear();
    for (const object of foldScene(this.log.all(), Date.now()).objects) {
      this.registry.add(object, primitiveFor(object.assetId));
    }
  }
}
