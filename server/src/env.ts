import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Anchored to this module, never to cwd. `npm run dev:server` runs with cwd at
// the workspace root, a bare `tsx server/src/index.ts` runs it at the repo root,
// and a relative default would put the data directory in a different place
// depending on which one you used.
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(serverRoot, "..");

/**
 * plan.md §14 — no API key ever reaches the client. This module is the only
 * place keys are read, and nothing here is ever serialised into a response.
 * `capabilities()` deliberately reports booleans, never values.
 */

function loadDotEnv(): void {
  // Tiny reader instead of a dependency: we need six variables, and a .env
  // parser is not worth an npm audit surface on the box holding the keys.
  for (const file of [resolve(repoRoot, ".env"), resolve(serverRoot, ".env")]) {
    try {
      const text = readFileSync(file, "utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        process.env[key] ??= value;
      }
      return;
    } catch {
      // absent .env is normal — M0 runs with no configuration at all
    }
  }
}

loadDotEnv();

export const env = {
  port: Number(process.env.PORT ?? 8787),
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-opus-5",
  sttProvider: process.env.STT_PROVIDER ?? "",
  sttKey: process.env.STT_API_KEY ?? "",
  dataDir: process.env.DATA_DIR
    ? resolve(repoRoot, process.env.DATA_DIR)
    : resolve(serverRoot, "data"),
  /**
   * Where the Object Studio generator library is published (plan.md §2,
   * amended). This origin's code is fetched and evaluated on this server, so it
   * must be one you control; the default is the project's own build. Unset it
   * to work entirely from the bundled snapshot.
   */
  studioUrl: process.env.STUDIO_URL ?? "https://jasonsperske.github.io/object_studio/",
  /** Offline STT model. Downloaded by `npm run stt:model`, never committed. */
  voskModelPath: process.env.VOSK_MODEL_PATH
    ? resolve(repoRoot, process.env.VOSK_MODEL_PATH)
    : resolve(serverRoot, "models/vosk-model-small-en-us-0.15"),
};

/** The `mock` provider needs no key — it is a test double, see stt/mock.ts. */
export function isMockStt(): boolean {
  return env.sttProvider === "mock";
}

/** Vosk runs locally: no key, but useless without its model on disk. */
export function isVoskStt(): boolean {
  return env.sttProvider === "vosk";
}

export function capabilities(): { stt: boolean; claude: boolean; sttProvider: string } {
  return {
    stt:
      isMockStt() ||
      // Reported false until the model is downloaded, so the client says "not
      // configured" instead of promising capture that would fail on first use.
      (isVoskStt() && existsSync(env.voskModelPath)) ||
      Boolean(env.sttProvider && env.sttKey),
    claude: Boolean(env.anthropicKey),
    // Named so the client can say "mock" rather than "ready" in its status line
    // — a mock reporting itself as working STT is how a demo lies to you.
    sttProvider: env.sttProvider,
  };
}
