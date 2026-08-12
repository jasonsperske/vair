/**
 * Sky styles (plan.md §13 — local and instant, never a round trip).
 *
 * `void` is the default and is the original §2 black: the scene is a fully
 * immersive void until someone asks for otherwise. A sky is part of the scene,
 * not a window onto the room, so it does not conflict with the no-passthrough
 * rule.
 */
export const SKY_STYLES = [
  "void",
  "day",
  "dusk",
  "night",
  "overcast",
  "storm",
] as const;

export type SkyStyle = (typeof SKY_STYLES)[number];

export const SKY_STYLE_DESCRIPTIONS: Record<SkyStyle, string> = {
  void: "no sky — pure black in every direction, the default",
  day: "clear blue sky, bright toward the horizon",
  dusk: "warm orange at the horizon fading up to deep violet",
  night: "deep blue-black with stars",
  overcast: "flat grey cloud, no sun",
  storm: "dark bruised grey, heavy and close",
};
