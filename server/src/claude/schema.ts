import { TurnResponse } from "@vair/shared";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * The JSON Schema handed to the structured-output API, derived from the zod
 * schema rather than written twice.
 *
 * The SDK ships a `zodOutputFormat` helper, but it takes a zod v4 schema and
 * `shared/` is on zod v3. Deriving the schema here keeps one source of truth —
 * hand-maintaining a parallel JSON Schema is exactly the two-sources-of-truth
 * drift plan.md §8 warns about, and it would fail silently: the model would
 * happily emit whatever the stale copy described.
 *
 * Structured outputs reject a few constructs, so the derived schema is walked
 * afterward to enforce what the API requires:
 *   - every object closed with `additionalProperties: false`
 *   - every property required (an optional field is one the model can omit)
 *   - `$schema` stripped
 */
export function turnResponseJsonSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(TurnResponse, {
    target: "jsonSchema7",
    $refStrategy: "none", // structured outputs do not support $ref indirection
  }) as Record<string, unknown>;

  delete schema.$schema;
  harden(schema);
  return schema;
}

function harden(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) harden(child);
    return;
  }
  if (!node || typeof node !== "object") return;

  const obj = node as Record<string, unknown>;

  if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
    const properties = obj.properties as Record<string, unknown>;
    obj.additionalProperties = false;
    obj.required = Object.keys(properties);
    for (const value of Object.values(properties)) harden(value);
  }

  for (const [key, value] of Object.entries(obj)) {
    if (key === "properties") continue;
    harden(value);
  }
}
