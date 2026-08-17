import { Router } from "express";
import { createReadStream } from "node:fs";
import { AssetCatalogue, type AssetEntry } from "@vair/shared";
import catalogueJson from "./catalogue.json" with { type: "json" };
import { bake } from "./bake.js";
import { studioEntries, studioObject } from "./studio.js";

/**
 * M3. The curated CC0 kit (plan.md §4).
 *
 * Everything in here must be CC0 — the schema enforces it, and the licence
 * field is not decorative. plan.md §3 rules out the Unity Asset Store as a
 * runtime source entirely; do not reopen that.
 *
 * §17 open question: the right kit size. Start at ~150 well-chosen props; the
 * miss rate at that size determines whether the concept survives. Right now
 * there are three primitives, which is the honest floor of §14's "never respond
 * 'I can't find that'" — a matched-material primitive beats an empty scene.
 */
export const assetsRouter = Router();

const catalogue = AssetCatalogue.parse(catalogueJson);

/**
 * The catalogue the model is shown each turn. See claude/prompt.ts.
 *
 * The fixed kit first, then the parametric generators: a modelled prop that
 * matches beats a generated one that has to be described, and the ordering is
 * what the model reads as preference.
 */
export async function catalogueEntries(): Promise<readonly AssetEntry[]> {
  return [...catalogue.entries, ...(await studioEntries())];
}

/**
 * A generator, built to the parameters in the query string and handed back as
 * a glTF. Everything is cached against the parameters, so the second request
 * for the same shape is a file read.
 *
 * The notes header carries anything worth saying about what was asked for —
 * a clamped parameter, a name that is not a parameter, a metric the generator
 * flagged. Nothing here fails for a bad parameter: it is dropped and noted.
 */
assetsRouter.get("/studio/:file", async (req, res, next) => {
  try {
    const id = String(req.params.file).replace(/\.glb$/, "");
    const object = await studioObject(id);
    if (!object) {
      res.status(404).json({ error: `no generator called "${id}"` });
      return;
    }
    const query = new URLSearchParams(req.url.slice(req.url.indexOf("?") + 1));
    const result = await bake(object, req.url.includes("?") ? query : new URLSearchParams());
    res.setHeader("Content-Type", "model/gltf-binary");
    // Deterministic in its parameters, so it can be cached hard.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("X-Studio-Bounds-Y", String(result.boundsY));
    if (result.notes.length) {
      // Percent-encoded: the notes come from generator metrics, which are
      // written for people and contain em dashes and multiplication signs.
      // A header may not.
      res.setHeader("X-Studio-Notes", encodeURIComponent(result.notes.join("; ")));
      console.log(`[vair] studio ${id}: ${result.notes.join("; ")}`);
    }
    createReadStream(result.file).pipe(res);
  } catch (err) {
    next(err);
  }
});

assetsRouter.get("/", async (req, res, next) => {
  try {
    const entries = await catalogueEntries();
    const q = String(req.query.q ?? "")
      .toLowerCase()
      .trim();
    if (!q) {
      res.json({ entries });
      return;
    }

    const terms = q.split(/\s+/);
    const scored = entries
      .map((entry) => ({ entry, score: score(entry, terms) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);

    // Never empty. A nearest-match with an honest note is the contract (§14);
    // returning nothing pushes "I can't find that" onto the model.
    res.json({ entries: scored.length > 0 ? scored.map((r) => r.entry) : [entries[0]!] });
  } catch (err) {
    next(err);
  }
});

function score(entry: AssetEntry, terms: string[]): number {
  let total = 0;
  for (const term of terms) {
    if (entry.name.includes(term)) total += 3;
    if (entry.tags.some((t) => t === term)) total += 2;
    else if (entry.tags.some((t) => t.includes(term))) total += 1;
  }
  return total;
}
