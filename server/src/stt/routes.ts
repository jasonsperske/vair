import { Router } from "express";
import { z } from "zod";
import { capabilities, env, isMockStt } from "../env.js";
import { getScript, setScript, transcribeMock } from "./mock.js";

/**
 * M1. Audio in, transcript with WORD-LEVEL TIMESTAMPS out.
 *
 * plan.md §6.3 — word-level timing is a hard requirement, not a preference.
 * Deixis binds a word to a hand position; an utterance-level timestamp binds it
 * to a two-second window during which the hand crossed the whole room.
 *
 * Before wiring a real provider here, verify it returns per-word start/end. If
 * it does not, reject the provider — do not interpolate word times from the
 * utterance duration. Evenly-spaced fake timings look plausible in a log and
 * are wrong by hundreds of milliseconds exactly when speech rate varies, which
 * is precisely at the deictic word.
 *
 * `STT_PROVIDER=mock` serves a scripted transcript so this endpoint is
 * exercisable with no key. See stt/mock.ts for what that does and does not
 * prove.
 */
export const sttRouter = Router();

sttRouter.post("/", (_req, res) => {
  if (isMockStt()) {
    res.json(transcribeMock());
    return;
  }

  if (!capabilities().stt) {
    res.status(501).json({
      error: "STT not configured",
      hint: "Set STT_PROVIDER=mock for a scripted transcript, or a real provider that returns word-level timestamps (plan.md §6).",
    });
    return;
  }

  res.status(501).json({
    error: `STT provider "${env.sttProvider}" is configured but not implemented`,
    hint: "M1 — implement upload -> provider -> TranscriptResponse here. Return the raw provider word timings; do not synthesise them.",
  });
});

/* ------------------------------------------------------ mock control --- */

const ScriptRequest = z.object({
  text: z.string().min(1).max(500),
  durationMs: z.number().min(100).max(15_000).optional(),
});

sttRouter.get("/mock", (_req, res) => {
  if (!isMockStt()) {
    res.status(404).json({ error: "mock STT is not enabled (set STT_PROVIDER=mock)" });
    return;
  }
  res.json(getScript());
});

/** Set what the next upload "hears". */
sttRouter.post("/mock", (req, res) => {
  if (!isMockStt()) {
    res.status(404).json({ error: "mock STT is not enabled (set STT_PROVIDER=mock)" });
    return;
  }
  const parsed = ScriptRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  setScript(parsed.data.text, parsed.data.durationMs);
  res.json(getScript());
});
