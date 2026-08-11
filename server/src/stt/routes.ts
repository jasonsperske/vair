import { Router, raw } from "express";
import { z } from "zod";
import { capabilities, env, isMockStt, isVoskStt } from "../env.js";
import { getScript, setScript, transcribeMock } from "./mock.js";
import { SttError, transcribeVosk, voskModelAvailable, voskModelPath } from "./vosk.js";

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

/**
 * Audio arrives as a raw body rather than multipart: one file, no fields, so a
 * multipart parser would be a dependency earning nothing.
 */
const audioBody = raw({
  type: ["audio/*", "video/webm", "application/octet-stream"],
  limit: "25mb",
});

sttRouter.post("/", audioBody, async (req, res) => {
  if (isMockStt()) {
    res.json(transcribeMock());
    return;
  }

  if (isVoskStt()) {
    if (!voskModelAvailable()) {
      res.status(501).json({
        error: "Vosk model not downloaded",
        hint: `Expected at ${voskModelPath()} — run: npm run stt:model`,
      });
      return;
    }
    try {
      const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      res.json(await transcribeVosk(audio));
    } catch (err) {
      if (err instanceof SttError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
    return;
  }

  if (!capabilities().stt) {
    res.status(501).json({
      error: "STT not configured",
      hint: "STT_PROVIDER=vosk for offline local STT, or =mock for a scripted transcript. Any other provider must return word-level timestamps (plan.md §6).",
    });
    return;
  }

  res.status(501).json({
    error: `STT provider "${env.sttProvider}" is configured but not implemented`,
    hint: "Implement upload -> provider -> TranscriptResponse here. Return the raw provider word timings; do not synthesise them.",
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
