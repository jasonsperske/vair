import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
} from "three";
import {
  DOOR,
  WALL,
  clamp,
  type DoorStyle,
  type WallStyle,
} from "@vair/shared";
import type { SceneObject } from "@vair/shared";

/**
 * Walls and doors.
 *
 * A door cuts a REAL opening: the wall is rebuilt as segments around the hole —
 * left of it, right of it, and a lintel above — rather than having a
 * door-shaped panel laid on top of a solid wall. Boolean geometry would be the
 * textbook answer and is far too heavy for a Quest; segmenting a box costs
 * three boxes and looks identical from every angle that matters.
 *
 * Wall geometry is built at true size from `parameters`, so the node's `scale`
 * stays [1,1,1] and nothing is scaled twice.
 */

type Spec = { color: number; roughness: number; metalness: number; opacity: number };

const WALL_SPECS: Record<WallStyle, Spec> = {
  plaster: { color: 0xd6d2c8, roughness: 0.95, metalness: 0, opacity: 1 },
  brick: { color: 0x8a4436, roughness: 0.9, metalness: 0, opacity: 1 },
  concrete: { color: 0x6f7276, roughness: 0.85, metalness: 0, opacity: 1 },
  wood: { color: 0x4a3524, roughness: 0.7, metalness: 0, opacity: 1 },
  glass: { color: 0x9fc4d8, roughness: 0.1, metalness: 0.1, opacity: 0.28 },
};

const DOOR_SPECS: Record<DoorStyle, Spec> = {
  wood: { color: 0x6b4a2f, roughness: 0.75, metalness: 0, opacity: 1 },
  metal: { color: 0x8d9196, roughness: 0.45, metalness: 0.7, opacity: 1 },
  glass: { color: 0xbcd8e6, roughness: 0.1, metalness: 0.1, opacity: 0.35 },
};

function materialFor(spec: Spec): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: spec.color,
    roughness: spec.roughness,
    metalness: spec.metalness,
    transparent: spec.opacity < 1,
    opacity: spec.opacity,
  });
}

export type WallDims = { length: number; height: number; thickness: number; style: WallStyle };
export type DoorDims = {
  wallId: string;
  offset: number;
  width: number;
  height: number;
  style: DoorStyle;
  open: number;
};

export function wallDimsOf(object: SceneObject): WallDims {
  const p = object.parameters;
  return {
    length: typeof p.length === "number" ? p.length : 1,
    height: typeof p.height === "number" ? p.height : WALL.defaultHeight,
    thickness: typeof p.thickness === "number" ? p.thickness : WALL.thickness,
    style: (p.style as WallStyle) ?? "plaster",
  };
}

export function doorDimsOf(object: SceneObject): DoorDims {
  const p = object.parameters;
  return {
    wallId: typeof p.wallId === "string" ? p.wallId : "",
    offset: typeof p.offset === "number" ? p.offset : 0.5,
    width: typeof p.width === "number" ? p.width : DOOR.defaultWidth,
    height: typeof p.height === "number" ? p.height : DOOR.defaultHeight,
    style: (p.style as DoorStyle) ?? "wood",
    open: typeof p.open === "number" ? p.open : 0,
  };
}

/**
 * Build a wall, minus the openings its doors cut in it.
 *
 * Local space: +X along the wall from its start, origin at the base midpoint,
 * so the wall spans -length/2..+length/2 and 0..height.
 */
export function createWall(object: SceneObject, doors: readonly SceneObject[]): Object3D {
  const dims = wallDimsOf(object);
  const group = new Group();
  group.userData.vairWall = true;
  group.userData.dims = dims;

  const material = materialFor(WALL_SPECS[dims.style]);
  const half = dims.length / 2;

  // Openings as [from, to] spans along local X, in order and non-overlapping.
  const openings = doors
    .map((d) => doorDimsOf(d))
    .filter((d) => d.width > 0)
    .map((d) => {
      const centre = -half + clamp(d.offset, 0, 1) * dims.length;
      const width = Math.min(d.width, dims.length);
      return {
        from: clamp(centre - width / 2, -half, half),
        to: clamp(centre + width / 2, -half, half),
        height: Math.min(d.height, dims.height),
      };
    })
    .sort((a, b) => a.from - b.from);

  const addBox = (w: number, h: number, x: number, y: number): void => {
    if (w <= 0.001 || h <= 0.001) return;
    const mesh = new Mesh(new BoxGeometry(w, h, dims.thickness), material);
    mesh.position.set(x, y + h / 2, 0);
    group.add(mesh);
  };

  // Solid spans between the openings, plus a lintel over each one.
  let cursor = -half;
  for (const opening of openings) {
    addBox(opening.from - cursor, dims.height, (cursor + opening.from) / 2, 0);
    addBox(
      opening.to - opening.from,
      dims.height - opening.height,
      (opening.from + opening.to) / 2,
      opening.height,
    );
    cursor = Math.max(cursor, opening.to);
  }
  addBox(half - cursor, dims.height, (cursor + half) / 2, 0);

  return group;
}

/**
 * The door itself: a frame around the opening and a leaf that swings.
 *
 * Positioned in the wall's local space and then given the wall's world
 * transform by the caller, so a door never stores a copy of where its wall is.
 */
export function createDoor(object: SceneObject, wall: SceneObject | undefined): Object3D {
  const dims = doorDimsOf(object);
  const group = new Group();
  group.userData.vairDoor = true;

  const wallDims = wall ? wallDimsOf(wall) : null;
  const material = materialFor(DOOR_SPECS[dims.style]);

  // Hinged at one edge so it swings like a door rather than sliding.
  const hinge = new Group();
  const leafThickness = Math.max(0.03, WALL.thickness * 0.4);
  const leaf = new Mesh(new BoxGeometry(dims.width, dims.height, leafThickness), material);
  leaf.position.set(dims.width / 2, dims.height / 2, 0);
  hinge.add(leaf);
  hinge.rotation.y = -clamp(dims.open, 0, 1) * (Math.PI / 2);
  group.add(hinge);
  group.userData.hinge = hinge;

  if (wallDims) {
    const half = wallDims.length / 2;
    const centre = -half + clamp(dims.offset, 0, 1) * wallDims.length;
    // Hinge sits at the opening's left edge.
    hinge.position.set(centre - dims.width / 2, 0, 0);
  }

  return group;
}

/** Swing an existing door without rebuilding it. Returns false if not a door. */
export function applyDoorParameter(node: Object3D, parameter: string, value: unknown): boolean {
  if (node.userData.vairDoor !== true) return false;
  if (parameter !== "open" || typeof value !== "number") return false;
  const hinge = node.userData.hinge as Group | undefined;
  if (!hinge) return false;
  hinge.rotation.y = -clamp(value, 0, 1) * (Math.PI / 2);
  return true;
}
