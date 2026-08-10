/**
 * Pulls complete action objects out of a JSON document that is still arriving.
 *
 * plan.md §12 (M3) wants objects to populate as they resolve rather than all at
 * once when the response completes. The model emits one JSON object per turn,
 * so "as they resolve" means extracting each element of the `actions` array the
 * moment its closing brace arrives, without waiting for the rest.
 *
 * This is a brace scanner, not a JSON parser: it finds balanced objects inside
 * the actions array and hands the raw text to zod for validation. Anything it
 * emits is syntactically complete — a half-written action is never surfaced.
 */
export class ActionScanner {
  private buf = "";
  private i = 0;
  private phase: "seek" | "array" | "done" = "seek";
  private depth = 0;
  private inString = false;
  private escaped = false;
  private objStart = -1;

  /** Feed a chunk; returns the raw JSON text of any actions completed by it. */
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];

    if (this.phase === "seek" && !this.findArrayStart()) return out;
    if (this.phase !== "array") return out;

    while (this.i < this.buf.length) {
      const c = this.buf[this.i]!;

      if (this.inString) {
        // Escapes matter: a brace or quote inside a string must not move the
        // depth counter, and "\\" must not escape the quote that follows it.
        if (this.escaped) this.escaped = false;
        else if (c === "\\") this.escaped = true;
        else if (c === '"') this.inString = false;
      } else if (c === '"') {
        this.inString = true;
      } else if (c === "{") {
        if (this.depth === 0) this.objStart = this.i;
        this.depth++;
      } else if (c === "}") {
        this.depth--;
        if (this.depth === 0 && this.objStart >= 0) {
          out.push(this.buf.slice(this.objStart, this.i + 1));
          this.objStart = -1;
        }
      } else if (c === "]" && this.depth === 0) {
        this.phase = "done";
        this.i++;
        break;
      }

      this.i++;
    }

    return out;
  }

  /** Everything received so far, for the final whole-document validation. */
  text(): string {
    return this.buf;
  }

  /**
   * Locate `"actions": [` and park the cursor just past the bracket.
   *
   * The key is only accepted when a colon follows it, so the word "actions"
   * appearing inside the speech string cannot be mistaken for the array.
   */
  private findArrayStart(): boolean {
    let from = 0;
    for (;;) {
      const key = this.buf.indexOf('"actions"', from);
      if (key === -1) return false;

      const after = this.buf.slice(key + '"actions"'.length);
      const colon = after.match(/^\s*:/);
      if (!colon) {
        from = key + 1;
        continue;
      }

      const bracket = this.buf.indexOf("[", key + '"actions"'.length);
      if (bracket === -1) return false;

      this.i = bracket + 1;
      this.phase = "array";
      return true;
    }
  }
}
