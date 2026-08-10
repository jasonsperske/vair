import Anthropic from "@anthropic-ai/sdk";
import {
  ModelAction,
  TurnResponse,
  type AssetEntry,
  type TurnRequest,
  type TurnStreamEvent,
} from "@vair/shared";
import { env } from "../env.js";
import { ActionScanner } from "./action-stream.js";
import { buildSystemPrompt, buildUserMessage } from "./prompt.js";
import { turnResponseJsonSchema } from "./schema.js";

/**
 * One scene turn: utterance in, validated actions out, streamed (plan.md §16).
 *
 * plan.md §14 — the key never leaves this process. The client talks to
 * /api/claude/turn and nothing else.
 */

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  // Constructed lazily so the server boots (and /api/health answers) with no
  // key configured — M0 and M1 run standalone.
  client ??= new Anthropic({ apiKey: env.anthropicKey });
  return client;
}

/** Derived once: it is fixed for the process lifetime. */
let outputSchema: Record<string, unknown> | null = null;

/**
 * plan.md §13 — under 5s from utterance to first visible change feels like
 * magic. Effort is the primary latency lever, and placing props from a clear
 * instruction is closer to structured extraction than to hard reasoning, so it
 * runs low by default. Whether placement quality needs more is a measurement to
 * take on-device, not a guess to make here.
 */
const EFFORT = "low" as const;

/**
 * Off, and the reason is variance rather than mean.
 *
 * Measured on identical warm requests: adaptive thinking produced 9.2s then
 * 3.4s to first object — it decides per turn whether to think, and the user
 * feels that as the same sentence sometimes taking three times as long.
 * plan.md §9 is explicit that inconsistent latency feels worse than uniform
 * latency. Disabled, the same request ran a steady ~3.0s.
 *
 * Disabling is permitted at effort `high` or below, and this turn is
 * constrained extraction against an explicit rulebook rather than open
 * reasoning. The documented risk is stray reasoning leaking into the visible
 * response; structured output makes that unlikely here, since the response is
 * schema-constrained JSON rather than prose. If placement quality regresses,
 * this is the first knob to put back — and the §12 budget would then need to
 * come from somewhere else (fast mode, or a smaller model for this turn).
 */
const THINKING = { type: "disabled" } as const;

/** Room for a multi-object turn. */
const MAX_TOKENS = 4096;

/**
 * Yields each action as soon as the model finishes writing it, then a final
 * `done` carrying the speech.
 *
 * The retry rule from §16 still applies, but only while nothing has been
 * committed: once an action has gone out, re-running the turn would apply it
 * twice. So a failure after the first action is reported as non-retryable and
 * the partial scene stands — which is the right outcome anyway, since every
 * emitted action was individually validated.
 */
export async function* runTurn(
  req: TurnRequest,
  catalogue: readonly AssetEntry[],
): AsyncGenerator<TurnStreamEvent> {
  outputSchema ??= turnResponseJsonSchema();

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: buildUserMessage(req) }];
  let committed = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    const scanner = new ActionScanner();

    const stream = anthropic().messages.stream({
      model: env.anthropicModel,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: buildSystemPrompt(catalogue),
          // Byte-identical across turns — the whole reason the scene, viewer
          // and measurements live in the user message instead of up here.
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
      thinking: THINKING,
      output_config: {
        effort: EFFORT,
        format: { type: "json_schema", schema: outputSchema },
      },
    });

    for await (const event of stream) {
      // Thinking deltas stream too; only the answer text carries the JSON.
      if (event.type !== "content_block_delta" || event.delta.type !== "text_delta") continue;

      for (const raw of scanner.push(event.delta.text)) {
        const parsed = ModelAction.safeParse(safeJson(raw));
        if (!parsed.success) {
          // A malformed action is dropped rather than aborting the turn — the
          // rest of the response is still worth having.
          console.warn("[vair] dropped unparseable action:", parsed.error.message);
          continue;
        }
        committed++;
        yield { type: "action", action: parsed.data };
      }
    }

    const final = await stream.finalMessage();

    if (final.stop_reason === "refusal") {
      yield {
        type: "error",
        error: "the model declined this request",
        detail: final.stop_details?.explanation ?? final.stop_details?.category ?? undefined,
        retryable: false,
      };
      return;
    }

    if (final.stop_reason === "max_tokens") {
      yield {
        type: "error",
        error: "response hit max_tokens",
        detail: `raise MAX_TOKENS (currently ${MAX_TOKENS})`,
        retryable: false,
      };
      return;
    }

    const whole = TurnResponse.safeParse(safeJson(scanner.text()));
    if (whole.success) {
      yield { type: "done", speech: whole.data.speech, question: whole.data.question };
      return;
    }

    // plan.md §16 — retry once with the validation error appended, then fail
    // loudly. Only safe while the scene is untouched.
    if (attempt === 0 && committed === 0) {
      messages.push(
        { role: "assistant", content: scanner.text() || "(no output)" },
        {
          role: "user",
          content: `That did not validate: ${whole.error.message}\n\nRe-send the same turn as a single object matching the required schema exactly, and nothing else.`,
        },
      );
      continue;
    }

    yield {
      type: "error",
      error:
        committed > 0
          ? `applied ${committed} action(s) but the response did not validate`
          : "model output failed schema validation twice",
      detail: whole.error.message,
      retryable: false,
    };
    return;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
