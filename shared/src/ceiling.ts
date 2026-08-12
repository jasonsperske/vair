/**
 * Ceiling styles (plan.md §13 — local and instant, never a round trip).
 *
 * A ceiling is what turns a void into a room. `tiles` is the suspended office
 * grid — paired with a `carpet` ground it is the whole backrooms look, and the
 * two together are the reason a ceiling is worth having at all.
 */
export const CEILING_STYLES = [
  "void",
  "tiles",
  "concrete",
  "plaster",
  "wood",
] as const;

export type CeilingStyle = (typeof CEILING_STYLES)[number];

export const CEILING_STYLE_DESCRIPTIONS: Record<CeilingStyle, string> = {
  void: "no ceiling — open above, the default",
  tiles: "suspended office ceiling tiles on a grid, slightly yellowed",
  concrete: "raw grey concrete slab",
  plaster: "flat white plaster",
  wood: "dark timber boards",
};

/** Metres. Roughly a domestic room; low enough to feel enclosed. */
export const DEFAULT_CEILING_HEIGHT = 2.7;
export const MIN_CEILING_HEIGHT = 1.8;
export const MAX_CEILING_HEIGHT = 12;
