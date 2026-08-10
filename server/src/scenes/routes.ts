import { Router } from "express";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EventLog, deriveNarrative, foldScene } from "@vair/shared";
import { env } from "../env.js";
import { z } from "zod";

/**
 * M6. Persistence.
 *
 * We store the EVENT LOG, not the folded document (plan.md §8). The document is
 * a fold and can always be recomputed; the log additionally carries undo,
 * replay and history, and a shared scene that replays is the M6 acceptance
 * criterion ("reloads identically in a fresh session from a share URL").
 *
 * The narrative is regenerated on every save and never read back — it is
 * derived, not authoritative.
 */
export const scenesRouter = Router();

const SaveRequest = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  name: z.string().min(1).max(120),
  events: EventLog,
});

scenesRouter.get("/", (_req, res) => {
  const files = existsSync(env.dataDir)
    ? readdirSync(env.dataDir).filter((f) => f.endsWith(".json"))
    : [];
  const scenes = files.map((f) => {
    const raw = JSON.parse(readFileSync(join(env.dataDir, f), "utf8")) as {
      id: string;
      name: string;
      savedAt: number;
    };
    return { id: raw.id, name: raw.name, savedAt: raw.savedAt };
  });
  res.json({ scenes });
});

scenesRouter.get("/:id", (req, res) => {
  const path = scenePath(req.params.id);
  if (!path || !existsSync(path)) {
    res.status(404).json({ error: "no such scene" });
    return;
  }
  res.json(JSON.parse(readFileSync(path, "utf8")));
});

scenesRouter.post("/", (req, res) => {
  const parsed = SaveRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid scene", detail: parsed.error.message });
    return;
  }
  const { id, name, events } = parsed.data;
  const path = scenePath(id);
  if (!path) {
    res.status(400).json({ error: "invalid scene id" });
    return;
  }

  const doc = foldScene(events, Date.now());
  const payload = {
    id,
    name,
    savedAt: Date.now(),
    events,
    narrative: deriveNarrative({ ...doc, name }),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2));
  res.json({ id, savedAt: payload.savedAt, objects: doc.objects.length });
});

/** The id is regex-validated above, but path construction gets its own guard. */
function scenePath(id: string): string | null {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return null;
  return join(env.dataDir, `${id}.json`);
}
