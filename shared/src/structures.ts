/**
 * Walls and doors.
 *
 * Like lights, these are scene *objects* rather than a new concept, so naming,
 * moving, removing, undo, save and reload all come for free and no new event
 * type is needed. Asset ids are prefixed `structure:` so the client knows to
 * build geometry rather than look up a prop.
 *
 * A wall is described by its two ENDPOINTS rather than a centre and a length.
 * That is the shape the product actually needs: "put a wall from here to
 * there" produces two deictic tokens, so §6 hands the model two measurement
 * bundles and it can drop one on each end. A centre-and-length wall would make
 * the most natural phrasing the hardest one to satisfy.
 *
 * Dimensions live in `parameters`, not in the event's `scale`. `scale` stays a
 * uniform multiplier everywhere else in the system, and geometry built at true
 * size would otherwise be scaled twice.
 */

export const WALL_STYLES = ["plaster", "brick", "concrete", "wood", "glass"] as const;
export type WallStyle = (typeof WALL_STYLES)[number];

export const WALL_STYLE_DESCRIPTIONS: Record<WallStyle, string> = {
  plaster: "flat painted plaster, off-white",
  brick: "red brick with mortar courses",
  concrete: "grey board-formed concrete",
  wood: "dark timber panelling",
  glass: "tinted glass, see-through",
};

export const DOOR_STYLES = ["wood", "metal", "glass"] as const;
export type DoorStyle = (typeof DOOR_STYLES)[number];

export const DOOR_STYLE_DESCRIPTIONS: Record<DoorStyle, string> = {
  wood: "a panelled timber door",
  metal: "a plain steel door",
  glass: "a glazed door",
};

export const WALL = {
  minHeight: 0.3,
  maxHeight: 12,
  defaultHeight: 2.7,
  /** Metres. Thin enough to read as a partition, thick enough to catch light. */
  thickness: 0.12,
  /** Below this the two endpoints are effectively the same point. */
  minLength: 0.2,
  maxLength: 60,
} as const;

export const DOOR = {
  minWidth: 0.5,
  maxWidth: 4,
  defaultWidth: 0.9,
  minHeight: 1.2,
  maxHeight: 6,
  defaultHeight: 2.05,
} as const;

export const WALL_ASSET = "structure:wall";
export const DOOR_ASSET = "structure:door";

export function isWallAsset(assetId: string): boolean {
  return assetId === WALL_ASSET;
}

export function isDoorAsset(assetId: string): boolean {
  return assetId === DOOR_ASSET;
}

export function isStructureAsset(assetId: string): boolean {
  return assetId.startsWith("structure:");
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
