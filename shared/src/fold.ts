import type { SceneEvent } from "./events.js";
import { emptyScene, type SceneDocument, type SceneObject } from "./scene.js";

/**
 * Scene state is a fold over the event log (plan.md §8). This function is the
 * only place that turns events into state — client and server both call it, so
 * a shared scene reloads byte-identically to the session that built it (M6
 * acceptance criterion).
 */
export function foldScene(events: readonly SceneEvent[], now = 0): SceneDocument {
  const undone = new Set<string>();
  for (const e of events) {
    if (e.type === "undone") undone.add(e.targetEventId);
  }

  let doc = emptyScene("untitled", "Untitled", now);
  const byId = new Map<string, SceneObject>();

  for (const e of events) {
    if (undone.has(e.id)) continue;

    switch (e.type) {
      case "scene_created":
        doc = { ...doc, id: e.sceneId, name: e.name, createdAt: e.t };
        break;

      case "object_placed":
        byId.set(e.objectId, {
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
        });
        break;

      case "object_moved":
        patch(byId, e.objectId, (o) => ({ ...o, position: e.position }));
        break;

      case "object_rotated":
        patch(byId, e.objectId, (o) => ({ ...o, rotation: e.rotation }));
        break;

      case "object_scaled":
        patch(byId, e.objectId, (o) => ({ ...o, scale: e.scale }));
        break;

      case "object_renamed":
        patch(byId, e.objectId, (o) => ({ ...o, name: e.name }));
        break;

      case "object_removed":
        byId.delete(e.objectId);
        break;

      case "parameter_set":
        patch(byId, e.objectId, (o) => ({
          ...o,
          parameters: { ...o.parameters, [e.parameter]: e.value },
        }));
        break;

      case "environment_set":
        doc = { ...doc, environment: { ...doc.environment, ...e.environment } };
        break;

      // A save names the scene, so replaying the log reproduces the name too.
      case "scene_saved":
        doc = { ...doc, id: e.sceneId, name: e.name };
        break;

      case "undone":
        break;
    }

    doc = { ...doc, updatedAt: e.t };
  }

  return { ...doc, objects: [...byId.values()] };
}

function patch(
  byId: Map<string, SceneObject>,
  id: string,
  f: (o: SceneObject) => SceneObject,
): void {
  const o = byId.get(id);
  // Events referencing a removed object are dropped, not an error: the log is
  // append-only and a stale model turn may still reference something deleted.
  if (o) byId.set(id, f(o));
}

/**
 * plan.md §8 — the markdown narrative is derived, not authoritative.
 * Regenerated from scene state on every save.
 */
export function deriveNarrative(doc: SceneDocument): string {
  const lines = [`# ${doc.name}`, ""];
  if (doc.objects.length === 0) {
    lines.push("An empty void.");
    return lines.join("\n");
  }
  lines.push(`${doc.objects.length} object${doc.objects.length === 1 ? "" : "s"}:`, "");
  for (const o of doc.objects) {
    const [x, y, z] = o.position;
    lines.push(
      `- **${o.name}** (${o.assetId}) at ${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}` +
        (o.utterance ? ` — _"${o.utterance}"_` : ""),
    );
  }
  return lines.join("\n");
}
