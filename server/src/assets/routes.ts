import { Router } from "express";
import { AssetCatalogue, type AssetEntry } from "@vair/shared";
import catalogueJson from "./catalogue.json" with { type: "json" };

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

/** The catalogue the model is shown each turn. See claude/prompt.ts. */
export function catalogueEntries(): readonly AssetEntry[] {
  return catalogue.entries;
}

assetsRouter.get("/", (req, res) => {
  const q = String(req.query.q ?? "")
    .toLowerCase()
    .trim();
  if (!q) {
    res.json(catalogue);
    return;
  }

  const terms = q.split(/\s+/);
  const scored = catalogue.entries
    .map((entry) => ({ entry, score: score(entry, terms) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  // Never empty. A nearest-match with an honest note is the contract (§14);
  // returning nothing pushes "I can't find that" onto the model.
  const entries = scored.length > 0 ? scored.map((r) => r.entry) : [catalogue.entries[0]!];
  res.json({ entries });
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
