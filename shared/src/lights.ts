/**
 * Lights.
 *
 * A light is a scene *object*, not a separate concept: it gets a name, a
 * position, and an entry in the event log like anything else. That falls out of
 * §8 rather than being designed — because it is an object, "move the lamp",
 * "get rid of the lamp", undo, save and reload all work with no new machinery,
 * and no new event type was needed to add lighting at all.
 *
 * Asset ids are prefixed `light:` so the client can tell at materialisation
 * time whether to build a mesh or a light.
 */

export const LIGHT_KINDS = ["point", "sun"] as const;
export type LightKind = (typeof LIGHT_KINDS)[number];

export const LIGHT_KIND_DESCRIPTIONS: Record<LightKind, string> = {
  point: "a lamp — glows in all directions from a point in the scene, falls off with distance",
  sun: "sunlight — parallel rays from a direction, lights everything evenly, no falloff",
};

/**
 * A closed palette rather than free-form hex. Structured output is far more
 * reliable on an enum than on a six-digit hex string, and the same reasoning
 * applies here as to ground styles: the model can only ask for what the client
 * can actually render.
 */
export const LIGHT_COLORS = [
  "warm",
  "neutral",
  "cool",
  "candle",
  "moonlight",
  "red",
  "orange",
  "amber",
  "green",
  "cyan",
  "blue",
  "violet",
  "pink",
] as const;
export type LightColor = (typeof LIGHT_COLORS)[number];

/** Intensity the model works in. Mapped to renderer units by the client. */
export const LIGHT_INTENSITY = {
  min: 0,
  max: 10,
  /** What an unqualified "a lamp" should be. */
  default: 5,
} as const;

export function lightAssetId(kind: LightKind): string {
  return `light:${kind}`;
}

export function isLightAsset(assetId: string): boolean {
  return assetId.startsWith("light:");
}

export function lightKindOf(assetId: string): LightKind {
  const kind = assetId.slice("light:".length);
  return (LIGHT_KINDS as readonly string[]).includes(kind) ? (kind as LightKind) : "point";
}
