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
  WINDOW,
  clamp,
  type OpeningKind,
  type OpeningStyle,
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

const DOOR_SPECS: Record<OpeningStyle, Spec> = {
  wood: { color: 0x6b4a2f, roughness: 0.75, metalness: 0, opacity: 1 },
  metal: { color: 0x8d9196, roughness: 0.45, metalness: 0.7, opacity: 1 },
  glass: { color: 0xbcd8e6, roughness: 0.1, metalness: 0.1, opacity: 0.35 },
};

/** Glazing is the same whatever the frame is made of. */
const GLASS: Spec = { color: 0xbcd8e6, roughness: 0.05, metalness: 0.15, opacity: 0.25 };

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
  kind: OpeningKind;
  offset: number;
  width: number;
  height: number;
  /** Metres from the floor to the bottom edge. 0 for a door. */
  sill: number;
  style: OpeningStyle;
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
  const kind: OpeningKind = p.kind === "window" ? "window" : "door";
  const fallback = kind === "window" ? WINDOW : DOOR;
  return {
    wallId: typeof p.wallId === "string" ? p.wallId : "",
    kind,
    offset: typeof p.offset === "number" ? p.offset : 0.5,
    width: typeof p.width === "number" ? p.width : fallback.defaultWidth,
    height: typeof p.height === "number" ? p.height : fallback.defaultHeight,
    sill: typeof p.sill === "number" ? p.sill : fallback.defaultSill,
    style: (p.style as OpeningStyle) ?? "wood",
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
      const sill = clamp(d.sill, 0, Math.max(0, dims.height - 0.05));
      return {
        from: clamp(centre - width / 2, -half, half),
        to: clamp(centre + width / 2, -half, half),
        sill,
        top: Math.min(sill + d.height, dims.height),
      };
    })
    .sort((a, b) => a.from - b.from);

  const addBox = (w: number, h: number, x: number, y: number): void => {
    if (w <= 0.001 || h <= 0.001) return;
    const mesh = new Mesh(new BoxGeometry(w, h, dims.thickness), material);
    mesh.position.set(x, y + h / 2, 0);
    group.add(mesh);
  };

  // Full-height spans between the openings, then for each opening an apron
  // below it and a lintel above. The apron is what makes a window a window
  // rather than a doorway that happens to start partway up.
  let cursor = -half;
  for (const opening of openings) {
    const centre = (opening.from + opening.to) / 2;
    const width = opening.to - opening.from;
    addBox(opening.from - cursor, dims.height, (cursor + opening.from) / 2, 0);
    addBox(width, opening.sill, centre, 0);
    addBox(width, dims.height - opening.top, centre, opening.top);
    cursor = Math.max(cursor, opening.to);
  }
  addBox(half - cursor, dims.height, (cursor + half) / 2, 0);

  return group;
}

/**
 * What fills an opening: a leaf that swings for a door, a glazed pane in a
 * frame for a window.
 *
 * Positioned in the wall's local space and then given the wall's world
 * transform by the caller, so an opening never stores a copy of where its wall
 * is and a moved wall cannot leave its windows behind.
 */
export function createDoor(object: SceneObject, wall: SceneObject | undefined): Object3D {
  const dims = doorDimsOf(object);
  const group = new Group();
  group.userData.vairDoor = true;

  const wallDims = wall ? wallDimsOf(wall) : null;
  const frameMaterial = materialFor(DOOR_SPECS[dims.style]);
  const leafThickness = Math.max(0.03, WALL.thickness * 0.4);

  // Hinged at one edge so it swings, rather than sliding or fading.
  const hinge = new Group();

  if (dims.kind === "window") {
    // Glazing plus a slim frame around it. Casement windows swing too, so the
    // pane hangs off the same hinge and set_open works on either.
    const inset = 0.05;
    const pane = new Mesh(
      new BoxGeometry(
        Math.max(0.01, dims.width - inset * 2),
        Math.max(0.01, dims.height - inset * 2),
        leafThickness * 0.4,
      ),
      materialFor(GLASS),
    );
    pane.position.set(dims.width / 2, dims.height / 2, 0);
    hinge.add(pane);

    for (const [w, h, x, y] of [
      [dims.width, inset, dims.width / 2, inset / 2],
      [dims.width, inset, dims.width / 2, dims.height - inset / 2],
      [inset, dims.height, inset / 2, dims.height / 2],
      [inset, dims.height, dims.width - inset / 2, dims.height / 2],
    ] as const) {
      const bar = new Mesh(new BoxGeometry(w, h, leafThickness), frameMaterial);
      bar.position.set(x, y, 0);
      hinge.add(bar);
    }
  } else {
    const leaf = new Mesh(
      new BoxGeometry(dims.width, dims.height, leafThickness),
      frameMaterial,
    );
    leaf.position.set(dims.width / 2, dims.height / 2, 0);
    hinge.add(leaf);
  }

  hinge.rotation.y = -clamp(dims.open, 0, 1) * (Math.PI / 2);
  group.add(hinge);
  group.userData.hinge = hinge;

  if (wallDims) {
    const half = wallDims.length / 2;
    const centre = -half + clamp(dims.offset, 0, 1) * wallDims.length;
    // Hinge at the opening's left edge, raised to the sill.
    hinge.position.set(centre - dims.width / 2, dims.sill, 0);
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
