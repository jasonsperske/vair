import {
  AssetCatalogue,
  EventLog,
  TranscriptResponse,
  TurnStreamEvent,
  type LatencySample,
  type ModelAction,
  type SceneEvent,
  type TurnRequest,
} from "@vair/shared";
import { z } from "zod";

/**
 * plan.md §14 — no API key ever reaches the client. Every model, STT and asset
 * call goes through the server, which holds the keys. If you are ever tempted to
 * put a key in a Vite env var: `import.meta.env` is compiled into the bundle and
 * is readable by anyone who opens DevTools in the Quest browser.
 *
 * plan.md §16 — every model interaction goes through one validated schema
 * boundary. Parsing here rather than at each call site is what makes that true.
 */

const BASE = "/api";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function parseJson<T extends z.ZodTypeAny>(res: Response, schema: T): Promise<z.infer<T>> {
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ApiError(detail || res.statusText, res.status);
  }
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) {
    // Fail loudly (§16). A partially-valid scene payload applied optimistically
    // is worse than a visible error.
    throw new ApiError(`schema violation: ${parsed.error.message}`, 500);
  }
  return parsed.data;
}

export type Health = {
  ok: boolean;
  stt: boolean;
  claude: boolean;
  /** "" when unset, "mock" for the test double. Never render this as "ready". */
  sttProvider: string;
};

export async function health(): Promise<Health> {
  const res = await fetch(`${BASE}/health`);
  if (!res.ok) return { ok: false, stt: false, claude: false, sttProvider: "" };
  return res.json() as Promise<Health>;
}

/**
 * M1. Word-level timestamps are a hard requirement — see shared/protocol.ts.
 *
 * Posted as a raw body rather than multipart: one file and no fields, so the
 * server needs no multipart parser.
 */
export async function transcribe(audio: Blob, signal?: AbortSignal): Promise<TranscriptResponse> {
  const res = await fetch(`${BASE}/stt`, {
    method: "POST",
    headers: { "content-type": audio.type || "audio/webm" },
    body: audio,
    signal,
  });
  return parseJson(res, TranscriptResponse);
}

/**
 * M3. Streams a turn as NDJSON, invoking `onAction` for each action the moment
 * the model finishes writing it, so objects populate progressively (§12).
 *
 * Cancellable: a new pinch during THINKING aborts the request (§7).
 */
export async function streamTurn(
  req: TurnRequest,
  onAction: (action: ModelAction) => void,
  signal?: AbortSignal,
): Promise<{ speech: string; question: string | null }> {
  const res = await fetch(`${BASE}/claude/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });

  if (!res.ok) {
    throw new ApiError((await res.text().catch(() => "")) || res.statusText, res.status);
  }
  if (!res.body) throw new ApiError("streaming unsupported by this browser", 500);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: { speech: string; question: string | null } | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // NDJSON: a chunk can split mid-line, so only complete lines are consumed.
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      const parsed = TurnStreamEvent.safeParse(JSON.parse(line));
      if (!parsed.success) throw new ApiError(`schema violation: ${parsed.error.message}`, 500);

      switch (parsed.data.type) {
        case "action":
          onAction(parsed.data.action);
          break;
        case "done":
          result = { speech: parsed.data.speech, question: parsed.data.question };
          break;
        case "error":
          throw new ApiError(parsed.data.detail ?? parsed.data.error, 502);
      }
    }
  }

  if (!result) throw new ApiError("stream ended without completing the turn", 502);
  return result;
}

export async function catalogue(query?: string): Promise<AssetCatalogue> {
  const url = query ? `${BASE}/assets?q=${encodeURIComponent(query)}` : `${BASE}/assets`;
  return parseJson(await fetch(url), AssetCatalogue);
}

/* -------------------------------------------------------------- scenes --- */

export const SavedSceneSummary = z.object({
  id: z.string(),
  name: z.string(),
  savedAt: z.number(),
  objectCount: z.number(),
});
export type SavedSceneSummary = z.infer<typeof SavedSceneSummary>;

const SceneList = z.object({ scenes: z.array(SavedSceneSummary) });

const SavedScene = z.object({
  id: z.string(),
  name: z.string(),
  savedAt: z.number(),
  events: EventLog,
});

export async function listScenes(): Promise<SavedSceneSummary[]> {
  const parsed = await parseJson(await fetch(`${BASE}/scenes`), SceneList);
  return parsed.scenes;
}

/**
 * We store the event LOG, not the folded document (§8). The document is a fold
 * and can always be recomputed; the log additionally carries undo, replay and
 * history — and replaying it is what makes a reloaded scene identical to the
 * session that built it.
 */
export async function saveScene(
  id: string,
  name: string,
  events: readonly SceneEvent[],
): Promise<void> {
  const res = await fetch(`${BASE}/scenes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, name, events }),
  });
  if (!res.ok) {
    throw new ApiError((await res.text().catch(() => "")) || res.statusText, res.status);
  }
}

export async function loadScene(id: string): Promise<z.infer<typeof SavedScene>> {
  return parseJson(await fetch(`${BASE}/scenes/${encodeURIComponent(id)}`), SavedScene);
}

/**
 * plan.md §16 — write the latency instrumentation in M1, not later.
 * Retrofitting timestamps is painful and the numbers are the whole point of
 * several decisions downstream. Fire-and-forget; never block a frame on it.
 */
export function reportLatency(sample: LatencySample): void {
  void fetch(`${BASE}/latency`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sample),
    keepalive: true,
  }).catch(() => {});
}
