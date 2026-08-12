import { CEILING_STYLES } from "./ceiling.js";
import { GROUND_STYLES } from "./ground.js";
import { SKY_STYLES } from "./sky.js";

/**
 * The combined style vocabulary for `set_surface`.
 *
 * One enum rather than three, because three near-identical action variants cost
 * enough space in the compiled output grammar that adding walls pushed the
 * request past the API's size limit. Which styles are legal for which surface
 * is checked by the expander instead of by the grammar.
 */
export const SURFACE_STYLES = [
  ...new Set<string>([...GROUND_STYLES, ...SKY_STYLES, ...CEILING_STYLES]),
] as [string, ...string[]];

export type SurfaceKind = "ground" | "sky" | "ceiling";

export function stylesFor(surface: SurfaceKind): readonly string[] {
  if (surface === "ground") return GROUND_STYLES;
  if (surface === "sky") return SKY_STYLES;
  return CEILING_STYLES;
}
