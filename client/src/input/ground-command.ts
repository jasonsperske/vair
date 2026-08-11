import type { GroundStyle } from "@vair/shared";

/**
 * Local recognition of ground commands (plan.md §9 and §13).
 *
 * §13 requires the ground plane to be local and instant, never a round trip.
 * §9 says how: attempt local first, escalate silently on low confidence, and
 * set the confidence bar high — "a wrong local match produces a confident
 * incorrect action; a missed match costs only a round trip. Bias hard toward
 * escalation."
 *
 * So this requires BOTH a word meaning the ground AND a recognised style, in a
 * sentence short enough to be about nothing else. "make the floor grass" is
 * handled here in a frame. "put a stone bench on the grass over there" is not
 * a ground command and must not be treated as one — it mentions two style
 * words and a lot besides, so it escalates and the model gets it right.
 */

const GROUND_NOUNS = /\b(floor|ground|terrain)\b/;

/** Style keywords and their synonyms. First match wins. */
const STYLE_WORDS: [GroundStyle, RegExp][] = [
  ["void", /\b(void|nothing|none|no floor|no ground|remove|hide|get rid|invisible)\b/],
  ["grid", /\b(grid|gridlines|wireframe|default|plain|blank)\b/],
  ["grass", /\b(grass|lawn|turf|meadow|green)\b/],
  ["stone", /\b(stone|rock|flagstone|flagstones|concrete|slate|paving)\b/],
  ["sand", /\b(sand|sandy|desert|beach|dune|dunes)\b/],
  ["snow", /\b(snow|snowy|ice|icy|frost)\b/],
  ["wood", /\b(wood|wooden|timber|planks|floorboards|parquet)\b/],
  ["water", /\b(water|sea|ocean|lake|river)\b/],
];

/**
 * Long enough for "could you make the ground look like grass please", short
 * enough to exclude a sentence that is doing something else as well.
 */
const MAX_WORDS = 9;

export function matchGroundCommand(text: string): GroundStyle | null {
  const normalised = text.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalised) return null;
  if (normalised.split(" ").length > MAX_WORDS) return null;
  if (!GROUND_NOUNS.test(normalised)) return null;

  const matched = STYLE_WORDS.filter(([, pattern]) => pattern.test(normalised));
  // Two style words in one short sentence is ambiguous — "change the grass
  // floor to stone" could go either way. Escalate rather than guess.
  if (matched.length !== 1) return null;

  return matched[0]![0];
}
