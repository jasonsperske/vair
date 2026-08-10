import { Router } from "express";
import { TurnRequest } from "@vair/shared";
import { capabilities } from "../env.js";
import { catalogueEntries } from "../assets/routes.js";
import { runTurn } from "./turn.js";

/**
 * M3. The one validated schema boundary for model interaction (plan.md §16).
 *
 * The model returns ACTIONS, not events — the event log owns id/seq/t/source.
 * The client expands actions into events via applyActions (shared/apply.ts) so
 * that expansion happens once, next to the log that assigns identity.
 *
 * The response is NDJSON, streamed: one action per line as the model writes it,
 * so objects populate progressively rather than all appearing at the end (§12).
 */
export const claudeRouter = Router();

claudeRouter.post("/turn", async (req, res) => {
  const parsed = TurnRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid TurnRequest", detail: parsed.error.message });
    return;
  }

  if (!capabilities().claude) {
    res.status(501).json({
      error: "Anthropic API key not configured",
      hint: "Set ANTHROPIC_API_KEY in .env (server-side only — plan.md §14).",
    });
    return;
  }

  res.setHeader("content-type", "application/x-ndjson");
  // Nothing between here and the headset may buffer: a proxy holding the first
  // action until the response completes turns progressive commit back into
  // all-at-once, silently.
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders();

  const abort = new AbortController();
  // A cancelled turn (§7 — a new pinch during THINKING aborts) must stop the
  // generator, not leave it writing into a dead socket.
  res.on("close", () => abort.abort());

  try {
    for await (const event of runTurn(parsed.data, catalogueEntries())) {
      if (abort.signal.aborted) break;
      res.write(`${JSON.stringify(event)}\n`);
    }
  } catch (err) {
    console.error("[vair] turn failed", err);
    if (!abort.signal.aborted) {
      // Headers are already sent, so the failure has to travel as a stream
      // event rather than a status code.
      res.write(
        `${JSON.stringify({
          type: "error",
          error: err instanceof Error ? err.message : "turn failed",
          retryable: false,
        })}\n`,
      );
    }
  } finally {
    res.end();
  }
});
