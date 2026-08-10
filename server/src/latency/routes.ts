import { Router } from "express";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { LatencySample } from "@vair/shared";
import { env } from "../env.js";

/**
 * plan.md §16 — write the latency instrumentation in M1, not later.
 * Retrofitting timestamps is painful and these numbers decide whether the
 * on-device STT work in §11 is worth doing at all.
 *
 * Stages, not totals. JSONL so tools/latency.ts can stream it.
 */
export const latencyRouter = Router();

latencyRouter.post("/", (req, res) => {
  const parsed = LatencySample.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  appendFileSync(
    join(env.dataDir, "latency.jsonl"),
    `${JSON.stringify({ ...parsed.data, receivedAt: Date.now() })}\n`,
  );
  res.status(204).end();
});
