import {
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PointLight,
  SphereGeometry,
} from "three";
import { LIGHT_INTENSITY, lightKindOf, type LightColor, type LightKind } from "@vair/shared";

/**
 * Materialising a light.
 *
 * Lights are scene objects (see shared/lights.ts), so this is the light
 * equivalent of `primitiveFor` — the registry treats what comes back exactly
 * like any other placed object.
 *
 * A point light gets a small glowing marker. An unlit point source is invisible
 * by definition, so without one the user says "put a lamp there", the room
 * brightens, and there is nothing to look at, point at, or move. A sun gets no
 * marker: it is nominally infinitely far away, and a floating ball standing in
 * for it would be a lie about where it is.
 */

const COLOR_HEX: Record<LightColor, number> = {
  warm: 0xffd7a8,
  neutral: 0xfff4e6,
  cool: 0xdce8ff,
  candle: 0xffb26b,
  moonlight: 0xaec6ff,
  red: 0xff5a4d,
  orange: 0xff9a3c,
  amber: 0xffc247,
  green: 0x6bd98a,
  cyan: 0x5fd8e0,
  blue: 0x5a8dff,
  violet: 0xa87bff,
  pink: 0xff7ab8,
};

/**
 * The model works in 0..10; three's lights want very different magnitudes, and
 * a point light in physical units needs far more than a directional one.
 */
const POINT_UNITS_PER_STEP = 4;
const SUN_UNITS_PER_STEP = 0.35;

/** Distance at which a lamp has fallen to nothing. Keeps one lamp local. */
const POINT_DISTANCE = 18;

export type LightParameters = { color: LightColor; intensity: number };

export function isLightNode(node: Object3D): boolean {
  return node.userData.vairLight === true;
}

/** Build the node for a `light:*` asset. Returned to the registry like a mesh. */
export function createLight(assetId: string, params: LightParameters): Object3D {
  const kind = lightKindOf(assetId);
  const group = new Group();
  group.userData.vairLight = true;
  group.userData.lightKind = kind;

  const hex = COLOR_HEX[params.color] ?? COLOR_HEX.neutral;

  if (kind === "sun") {
    const sun = new DirectionalLight(hex, params.intensity * SUN_UNITS_PER_STEP);
    // Aims at the origin from wherever it was placed, so "put a sun over
    // there" lights the scene from that direction rather than nowhere.
    sun.target.position.set(0, 0, 0);
    group.add(sun, sun.target);
    group.userData.light = sun;
    return group;
  }

  const light = new PointLight(hex, params.intensity * POINT_UNITS_PER_STEP, POINT_DISTANCE, 2);
  const marker = new Mesh(
    new SphereGeometry(0.05, 16, 12),
    // Basic, not standard: the marker represents the source, so it should read
    // at full brightness rather than being lit by the very light it stands for.
    new MeshBasicMaterial({ color: hex }),
  );
  marker.name = "light-marker";
  group.add(light, marker);
  group.userData.light = light;
  group.userData.marker = marker;
  return group;
}

/**
 * Apply a `parameter_set` to an existing light. Returns false when the node
 * isn't a light or the parameter isn't one lights have, so the caller can tell
 * a no-op from a handled edit.
 */
export function applyLightParameter(node: Object3D, parameter: string, value: unknown): boolean {
  if (!isLightNode(node)) return false;

  const light = node.userData.light as PointLight | DirectionalLight | undefined;
  if (!light) return false;
  const kind = node.userData.lightKind as LightKind;
  const marker = node.userData.marker as Mesh | undefined;

  if (parameter === "intensity" && typeof value === "number") {
    const steps = Math.min(LIGHT_INTENSITY.max, Math.max(LIGHT_INTENSITY.min, value));
    light.intensity = steps * (kind === "sun" ? SUN_UNITS_PER_STEP : POINT_UNITS_PER_STEP);
    // A lamp turned fully off should stop looking like a lit bulb.
    if (marker) marker.visible = steps > 0;
    return true;
  }

  if (parameter === "color" && typeof value === "string") {
    const hex = COLOR_HEX[value as LightColor];
    if (hex === undefined) return false;
    light.color.setHex(hex);
    if (marker) (marker.material as MeshBasicMaterial).color.setHex(hex);
    return true;
  }

  return false;
}

/** Renderer units for the scene's ambient fill, from the model's 0..10. */
export function ambientUnits(intensity: number): number {
  return Math.max(0, intensity) * 0.12;
}

export { COLOR_HEX };
export type { Color };
