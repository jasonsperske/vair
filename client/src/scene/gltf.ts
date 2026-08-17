import { Group, type Object3D } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { studioAssetUrl } from "@vair/shared";
import { primitiveFor } from "./registry.js";

/**
 * Loading a baked mesh by assetId (plan.md §2, amended).
 *
 * The mesh is built on the server and arrives as a plain .glb, so there is no
 * generator code here and nothing lands in the frame budget (§13). Do not
 * "simplify" this by fetching generator sources and building geometry in the
 * headset — that is the thing §2 rules out.
 *
 * What this file really is, is the async seam. `nodeFor` has to hand the
 * registry a node synchronously, and the bytes are a fetch away, so a load
 * returns an empty group that fills in when they land. The object appears a
 * beat after the sentence commits, which is the same progressive behaviour
 * actions already have.
 */

const loader = new GLTFLoader();

/**
 * Keyed on the whole assetId, parameters included — two tables of different
 * lengths are two different meshes.
 *
 * The *bytes* are cached, not the parsed scene, and each instance parses its
 * own copy. Removing an object disposes its geometry and materials deeply
 * (registry.ts), so two instances sharing a parsed scene would leave the second
 * one holding disposed buffers the moment the first was deleted.
 */
const bytes = new Map<string, Promise<ArrayBuffer>>();

function fetchAsset(assetId: string): Promise<ArrayBuffer> {
  let pending = bytes.get(assetId);
  if (!pending) {
    pending = fetch(studioAssetUrl(assetId)).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    });
    // A failure must not poison the cache: the server bakes on demand, so the
    // next placement of the same thing is worth another try.
    pending.catch(() => {
      if (bytes.get(assetId) === pending) bytes.delete(assetId);
    });
    bytes.set(assetId, pending);
  }
  return pending;
}

/**
 * A node for a generated asset, empty until the mesh arrives.
 *
 * The mesh stands on y=0 with its origin at its base, which is the studio's
 * convention and vair's, so the group's transform is the object's transform
 * unmodified — nothing here re-seats it.
 */
export function loadMesh(assetId: string): Object3D {
  const node = new Group();

  void fetchAsset(assetId)
    .then(
      (buffer) =>
        new Promise<Object3D>((resolve, reject) => {
          loader.parse(buffer, "", (gltf) => resolve(gltf.scene), reject);
        }),
    )
    .then((scene) => {
      // Detached means the object was deleted while its mesh was in flight, and
      // its node has already been disposed. Filling it now would leak.
      if (node.parent) node.add(scene);
    })
    .catch((err: unknown) => {
      // §14 — never nothing. A load that fails stands in the primitive it would
      // have got before generators existed, and says so in the console rather
      // than silently looking like a deliberate box.
      console.warn(`[vair] ${assetId} did not load, standing in a primitive:`, err);
      if (node.parent) node.add(primitiveFor(assetId));
    });

  return node;
}
