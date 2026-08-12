import type { CeilingStyle, GroundStyle, SkyStyle } from "@vair/shared";

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

const GROUND_NOUNS = /\b(floor|ground|terrain|carpet)\b/;

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
  ["carpet", /\b(carpet|carpeted|backrooms)\b/],
];

/**
 * Long enough for "could you make the ground look like grass please", short
 * enough to exclude a sentence that is doing something else as well.
 */
const MAX_WORDS = 9;

/**
 * Overall brightness, the other half of §13's instant lighting.
 *
 * Relative only — "brighter", "darker". An absolute level ("set the lights to
 * seven") is rare enough in speech that supporting it here would add ambiguity
 * for no real gain, and it escalates cleanly.
 *
 * Returns the step to apply to the scene's current ambient level, or null to
 * escalate. Deliberately refuses anything naming a specific light: "make the
 * lamp brighter" is about one object and needs the model to resolve which.
 */
export function matchBrightnessCommand(text: string): number | null {
  const normalised = text.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalised || normalised.split(" ").length > MAX_WORDS) return null;

  // A named object means one light, not the room.
  if (/\b(lamp|light|sun|bulb|candle|torch)s?\b/.test(normalised)) {
    // ...unless it is unmistakably the whole room's lighting.
    if (!/\b(the lights|all the lights|lighting)\b/.test(normalised)) return null;
  }

  const brighter = /\b(brighter|lighter|brighten|turn up|more light|too dark)\b/.test(normalised);
  const darker = /\b(darker|dimmer|dim|darken|turn down|less light|too bright)\b/.test(normalised);
  if (brighter === darker) return null; // neither, or contradictory

  const much = /\b(much|way|a lot|loads|far)\b/.test(normalised) ? 2 : 1;
  return (brighter ? 1 : -1) * 1.5 * much;
}

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

const SKY_NOUNS = /\b(sky|skybox|heavens|above us|overhead)\b/;

const SKY_WORDS: [SkyStyle, RegExp][] = [
  ["void", /\b(void|nothing|none|no sky|remove|hide|black)\b/],
  ["day", /\b(day|daytime|blue|clear|sunny|noon)\b/],
  ["dusk", /\b(dusk|sunset|sundown|evening|golden hour|twilight)\b/],
  ["night", /\b(night|nighttime|stars|starry|midnight)\b/],
  ["overcast", /\b(overcast|cloudy|clouds|grey|gray|dull)\b/],
  ["storm", /\b(storm|stormy|thunder|bruised|ominous)\b/],
];

const CEILING_NOUNS = /\b(ceiling|roof)\b/;

const CEILING_WORDS: [CeilingStyle, RegExp][] = [
  ["void", /\b(void|nothing|none|no ceiling|no roof|remove|hide|open)\b/],
  ["tiles", /\b(tiles|tiled|suspended|drop|office|backrooms|polystyrene)\b/],
  ["concrete", /\b(concrete|slab|brutalist|bunker)\b/],
  ["plaster", /\b(plaster|white|smooth|painted)\b/],
  ["wood", /\b(wood|wooden|timber|beams|boards)\b/],
];

/** Same shape and same confidence bar as the ground matcher. */
function matchSurface<T>(text: string, nouns: RegExp, words: [T, RegExp][]): T | null {
  const normalised = text.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalised) return null;
  if (normalised.split(" ").length > MAX_WORDS) return null;
  if (!nouns.test(normalised)) return null;

  const matched = words.filter(([, pattern]) => pattern.test(normalised));
  if (matched.length !== 1) return null;
  return matched[0]![0];
}

export function matchSkyCommand(text: string): SkyStyle | null {
  return matchSurface(text, SKY_NOUNS, SKY_WORDS);
}

export function matchCeilingCommand(text: string): CeilingStyle | null {
  return matchSurface(text, CEILING_NOUNS, CEILING_WORDS);
}
