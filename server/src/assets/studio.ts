import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { env } from "../env.js";
import type { AssetEntry } from "@vair/shared";
import snapshotJson from "./studio-snapshot.json" with { type: "json" };

/**
 * Parametric props, from the Object Studio library (plan.md §2, amended).
 *
 * The catalogue in catalogue.json is a fixed kit: what is in it is what you can
 * place. This is the other half — a set of shape *generators*, each with a
 * parameter schema, so "a two metre farmhouse table" is a table built to that
 * description rather than the nearest table somebody happened to model.
 *
 * The library is fetched from a hosted build of the studio, which publishes an
 * agent bundle: an index of every generator and its parameters, the generator
 * sources, and a self-contained runtime that turns one into geometry. Fetching
 * it rather than vendoring it means a generator added to the studio shows up
 * here without a redeploy.
 *
 * Two consequences worth being explicit about:
 *
 *  - **This evaluates code fetched from STUDIO_URL.** It must be an origin you
 *    control. The default is the project's own GitHub Pages build.
 *  - **The network is not on the critical path.** A snapshot of the index ships
 *    in this directory and is used whenever the fetch fails, so the server
 *    starts and the model still sees the generators offline. Only baking a mesh
 *    for a generator whose source is not yet cached needs the network.
 */

export interface StudioParam {
  id: string;
  label: string;
  type: "number" | "int" | "select" | "boolean";
  default: number | string | boolean;
  group?: string;
  help?: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  conditional?: boolean;
}

export interface StudioObject {
  id: string;
  name: string;
  description: string;
  source: string;
  params: StudioParam[];
  presets: { name: string; params: Record<string, number | string | boolean> }[];
}

interface StudioIndex {
  format: number;
  library: string;
  license: string;
  runtime: string;
  objects: StudioObject[];
}

/** The shape of the bundle this code knows how to read. */
const SUPPORTED_FORMAT = 1;

let cached: StudioIndex | null = null;
/** False when the index came from the snapshot, which changes what can be built. */
let live = false;

function cacheDir(): string {
  return join(env.dataDir, "studio");
}

function usable(index: StudioIndex): boolean {
  return index.format === SUPPORTED_FORMAT && Array.isArray(index.objects);
}

/**
 * The generator index, from the network if it answers and from the snapshot if
 * it does not. Read once per process — the library changes when the studio is
 * redeployed, not per request, and the system prompt has to stay byte-identical
 * across turns for prompt caching to work (see claude/prompt.ts).
 */
export async function studioIndex(): Promise<StudioIndex> {
  if (cached) return cached;
  const snapshot = snapshotJson as StudioIndex;
  if (!env.studioUrl) {
    cached = snapshot;
    return cached;
  }
  try {
    const response = await fetch(new URL("agent/index.json", env.studioUrl), {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const index = (await response.json()) as StudioIndex;
    if (!usable(index)) {
      // A format we do not know is not something to guess at.
      throw new Error(`unsupported bundle format ${index.format}`);
    }
    cached = index;
    live = true;
    console.log(`[vair] studio: ${index.objects.length} generators from ${env.studioUrl}`);
  } catch (err) {
    cached = snapshot;
    console.warn(
      `[vair] studio: using bundled snapshot (${snapshot.objects.length} generators) — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return cached;
}

/** The generator source, cached on disk after the first fetch. */
export async function studioSource(id: string): Promise<string> {
  const object = (await studioIndex()).objects.find((o) => o.id === id);
  if (!object) throw new Error(`no generator called "${id}"`);
  const file = join(cacheDir(), `${id}.js`);
  if (existsSync(file)) return readFile(file, "utf8");
  if (!env.studioUrl) throw new Error(`generator "${id}" is not cached and STUDIO_URL is unset`);
  const response = await fetch(new URL(`agent/${object.source}`, env.studioUrl)).catch((err) => {
    throw new Error(`generator "${id}" is not cached and ${env.studioUrl} is unreachable: ${err}`);
  });
  if (!response.ok) throw new Error(`fetching ${id}: HTTP ${response.status}`);
  const source = await response.text();
  await mkdir(cacheDir(), { recursive: true });
  await writeFile(file, source);
  return source;
}

/**
 * The runtime, cached on disk. It is an ES module with no imports left in it,
 * so once it is on disk it can simply be imported.
 */
export async function studioRuntimePath(): Promise<string> {
  const file = join(cacheDir(), "runtime.mjs");
  if (existsSync(file)) return file;
  if (!env.studioUrl) throw new Error("STUDIO_URL is unset, so no runtime to fetch");
  const index = await studioIndex();
  const response = await fetch(new URL(`agent/${index.runtime}`, env.studioUrl));
  if (!response.ok) throw new Error(`fetching runtime: HTTP ${response.status}`);
  await mkdir(cacheDir(), { recursive: true });
  await writeFile(file, await response.text());
  return file;
}

/* ------------------------------------------------------ Asset identity --- */

// `studio:table?length=2000` is parsed in shared/src/studio.ts — the client
// needs the same parse to build the URL it loads the baked mesh from.

/**
 * Parameters as the generator wants them: typed, clamped to their range, and
 * with anything unrecognised dropped. The model is told the ranges, but a
 * generator asked for a 40-metre table should produce a large table rather than
 * an error, and a misspelt parameter should be ignored rather than fatal —
 * §14's "never respond I can't find that" applies to shapes too.
 */
export function coerceParams(
  object: StudioObject,
  given: URLSearchParams,
): { params: Record<string, number | string | boolean>; notes: string[] } {
  const params: Record<string, number | string | boolean> = {};
  const notes: string[] = [];
  for (const spec of object.params) {
    const raw = given.get(spec.id);
    if (raw === null) continue;
    if (spec.type === "boolean") {
      params[spec.id] = raw === "true" || raw === "1";
      continue;
    }
    if (spec.type === "select") {
      const allowed = spec.options?.some((option) => option.value === raw);
      if (!allowed) {
        notes.push(`${spec.id}="${raw}" is not one of its choices; left at the default`);
        continue;
      }
      params[spec.id] = raw;
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      notes.push(`${spec.id}="${raw}" is not a number; left at the default`);
      continue;
    }
    const min = spec.min ?? Number.NEGATIVE_INFINITY;
    const max = spec.max ?? Number.POSITIVE_INFINITY;
    const clamped = Math.min(max, Math.max(min, value));
    if (clamped !== value) notes.push(`${spec.id} clamped from ${value} to ${clamped}`);
    params[spec.id] = spec.type === "int" ? Math.round(clamped) : clamped;
  }
  for (const key of given.keys()) {
    if (!object.params.some((spec) => spec.id === key)) notes.push(`no parameter called "${key}"`);
  }
  return { params, notes };
}

/* ---------------------------------------------------------- Catalogue --- */

/**
 * The generators as catalogue entries, so they sit alongside the CC0 kit in
 * search and in the prompt. `url` points at this server's bake route rather
 * than at the studio: the client loads a glTF from a URL and neither knows nor
 * needs to know that this one is built on demand.
 */
export async function studioEntries(): Promise<AssetEntry[]> {
  const index = await studioIndex();
  return index.objects.filter(buildable).map((object) => ({
    id: `studio:${object.id}`,
    name: object.name.toLowerCase(),
    tags: tagsFor(object),
    url: `/api/assets/studio/${object.id}.glb`,
    license: "CC0" as const,
    attribution: index.library,
  }));
}

/**
 * Whether this generator can actually be built right now.
 *
 * The snapshot lets the server start and the search keep working with the
 * library unreachable, but a generator whose source has never been fetched
 * cannot be built while it stays unreachable. Advertising one anyway would put
 * a broken asset in front of the model, which is worse than a smaller
 * catalogue: §14 is about never refusing, not about promising.
 */
function buildable(object: StudioObject): boolean {
  return live || existsSync(join(cacheDir(), `${object.id}.js`));
}

function tagsFor(object: StudioObject): string[] {
  const words = `${object.name} ${object.description}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);
  return [...new Set([object.id, ...words])].slice(0, 24);
}

export async function studioObject(id: string): Promise<StudioObject | undefined> {
  return (await studioIndex()).objects.find((object) => object.id === id);
}

/* ------------------------------------------------------------- Prompt --- */

/** How many parameters of one generator are worth the tokens in the prompt. */
const LISTED_PARAMS = 8;

function describeParam(spec: StudioParam): string {
  if (spec.type === "boolean") return `${spec.id}=true|false`;
  if (spec.type === "select") {
    return `${spec.id}=${(spec.options ?? []).map((option) => option.value).join("|")}`;
  }
  const unit = spec.unit && spec.unit !== "mm" ? spec.unit : "";
  return `${spec.id}=${spec.min}..${spec.max}${unit}`;
}

/**
 * The generators, for the system prompt.
 *
 * Compact on purpose. Every generator has more parameters than are listed here
 * and all of them have defaults, so the model's job is to set the two or three
 * a request actually turns on. Parameters the studio itself hides in some
 * combinations are left out — they are the ones most likely to be set
 * pointlessly.
 */
export async function describeGenerators(): Promise<string> {
  const index = await studioIndex();
  // Same filter as the catalogue: a generator that cannot be built right now is
  // not offered to the model either. Listing one the bake route would 500 on is
  // the "promise something and then fail" case §14 does not license.
  return index.objects
    .filter(buildable)
    .map((object) => {
      const listed = object.params
        .filter((spec) => !spec.conditional)
        .slice(0, LISTED_PARAMS)
        .map(describeParam)
        .join(" ");
      const presets = object.presets.slice(0, 4).map((preset) => preset.name);
      return [
        `- studio:${object.id} — ${object.description}`,
        `    ${listed}`,
        presets.length ? `    presets: ${presets.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}
