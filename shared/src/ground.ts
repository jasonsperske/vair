/**
 * Ground styles.
 *
 * A closed set rather than free text, for two reasons: the model can only emit
 * a style the client can actually render, and a fixed vocabulary is what makes
 * the local fast path (§9) possible — matching a known word needs no round
 * trip, which is what §13 demands of the ground plane.
 *
 * Names live in shared/ because the prompt has to list them; the colours are a
 * rendering concern and stay in the client.
 */
export const GROUND_STYLES = [
  "void",
  "grid",
  "grass",
  "stone",
  "sand",
  "snow",
  "wood",
  "water",
] as const;

export type GroundStyle = (typeof GROUND_STYLES)[number];

/** Shown to the model so it picks sensibly. Keep these concrete and visual. */
export const GROUND_STYLE_DESCRIPTIONS: Record<GroundStyle, string> = {
  void: "no floor at all — the original empty black void",
  grid: "near-black with faint blue gridlines, the default",
  grass: "dark green turf",
  stone: "grey flagstones",
  sand: "pale desert sand",
  snow: "cold blue-white snow",
  wood: "dark timber planks",
  water: "deep blue water",
};

export function isGroundStyle(value: string): value is GroundStyle {
  return (GROUND_STYLES as readonly string[]).includes(value);
}
