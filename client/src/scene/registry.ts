import {
  BoxGeometry,
  CylinderGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Group,
} from "three";
import type { SceneObject } from "@vair/shared";

/**
 * The bridge between the scene document (plan.md §8) and three.js objects.
 * The document is authoritative; everything here is a projection of it and may
 * be rebuilt from a fold at any time.
 */
export class ObjectRegistry {
  private readonly byId = new Map<string, Object3D>();
  private readonly idByObject = new WeakMap<Object3D, string>();

  constructor(private readonly parent: Group | Object3D) {}

  add(object: SceneObject, node: Object3D): void {
    node.name = object.name;
    this.applyTransform(node, object);
    this.byId.set(object.id, node);
    this.idByObject.set(node, object.id);
    this.parent.add(node);
  }

  get(id: string): Object3D | undefined {
    return this.byId.get(id);
  }

  remove(id: string): void {
    const node = this.byId.get(id);
    if (!node) return;
    node.removeFromParent();
    disposeDeep(node);
    this.byId.delete(id);
  }

  applyTransform(node: Object3D, object: SceneObject): void {
    node.position.fromArray(object.position);
    node.quaternion.fromArray(object.rotation);
    node.scale.fromArray(object.scale);
  }

  /** Raycast targets for deixis. Top-level nodes only; the cast recurses. */
  targets(): Object3D[] {
    return [...this.byId.values()];
  }

  /**
   * Walk up from a hit mesh to the registered root. glTF hits land on a leaf
   * primitive several levels below the object we actually named.
   */
  objectIdOf = (o: Object3D | null): string | null => {
    let cur: Object3D | null = o;
    while (cur) {
      const id = this.idByObject.get(cur);
      if (id) return id;
      cur = cur.parent;
    }
    return null;
  };

  clear(): void {
    for (const id of [...this.byId.keys()]) this.remove(id);
  }
}

/**
 * plan.md §14 — never respond "I can't find that". When an asset is missing we
 * substitute the nearest match, and when there is no match at all we fall back
 * to matched-material primitives rather than placing nothing.
 */
export function primitiveFor(assetId: string): Mesh {
  const material = new MeshStandardMaterial({
    color: 0x8899bb,
    roughness: 0.7,
    metalness: 0.05,
  });
  const shape = assetId.split(":").pop() ?? "box";
  const geometry =
    shape === "sphere"
      ? new SphereGeometry(0.25, 24, 16)
      : shape === "cylinder"
        ? new CylinderGeometry(0.2, 0.2, 0.5, 24)
        : new BoxGeometry(0.4, 0.4, 0.4);
  return new Mesh(geometry, material);
}

/** Position a node so it rests ON the surface described by a point hit. */
export function seatOnSurface(node: Object3D, point: Vector3, normal: Vector3): void {
  node.position.copy(point);
  // Objects sit upright on near-horizontal surfaces; on walls they take the
  // surface normal. Anything else looks broken regardless of what was asked for.
  if (Math.abs(normal.y) < 0.7) {
    node.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), normal.clone().normalize());
  } else {
    node.quaternion.identity();
  }
}

function disposeDeep(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as Mesh;
    mesh.geometry?.dispose?.();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose?.();
  });
}

export const IDENTITY = new Quaternion();
