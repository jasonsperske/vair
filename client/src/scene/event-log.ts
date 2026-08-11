import {
  foldScene,
  isUndoable,
  type EventDraft,
  type SceneDocument,
  type SceneEvent,
} from "@vair/shared";

/**
 * An event as authored at a call site: the store assigns `id` and `seq`.
 * Defined in shared/apply.ts so the action expander and this store agree on it.
 */
export type NewSceneEvent = EventDraft;

/**
 * plan.md §8 — the single event log.
 *
 * Local affordance edits (§9) append here too. There is exactly one log and
 * exactly one undo stack; building a second of either is how the two paths
 * start disagreeing about what the scene contains.
 */
export class EventLogStore {
  private readonly events: SceneEvent[] = [];
  private seq = 0;
  /** Index into `events` marking the last turn sent to the model. */
  private syncedUpTo = 0;
  private readonly listeners = new Set<(e: SceneEvent) => void>();
  private readonly reloadListeners = new Set<() => void>();
  private cachedDoc: SceneDocument | null = null;

  append(event: NewSceneEvent): SceneEvent {
    const full = {
      ...event,
      id: event.id ?? `e${this.seq}-${Math.random().toString(36).slice(2, 8)}`,
      seq: this.seq++,
    } as SceneEvent;
    this.events.push(full);
    this.cachedDoc = null;
    for (const l of this.listeners) l(full);
    return full;
  }

  /** Undo is an event, not a truncation — history stays replayable (§8). */
  undo(now: number): SceneEvent | null {
    const undoneIds = new Set(
      this.events.filter((e) => e.type === "undone").map((e) => e.targetEventId),
    );
    for (let i = this.events.length - 1; i >= 0; i--) {
      const candidate = this.events[i];
      if (!isUndoable(candidate) || undoneIds.has(candidate.id)) continue;
      return this.append({
        type: "undone",
        targetEventId: candidate.id,
        t: now,
        source: "local",
      });
    }
    return null;
  }

  scene(): SceneDocument {
    this.cachedDoc ??= foldScene(this.events, Date.now());
    return this.cachedDoc;
  }

  all(): readonly SceneEvent[] {
    return this.events;
  }

  /**
   * plan.md §8 — every Claude request carries the events applied since the last
   * model turn, so locally-handled edits never leave the model reasoning about
   * stale state. Call markSynced() only once the request is actually sent.
   */
  sinceLastTurn(): SceneEvent[] {
    return this.events.slice(this.syncedUpTo);
  }

  markSynced(): void {
    this.syncedUpTo = this.events.length;
  }

  onAppend(cb: (e: SceneEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Wholesale replacement, as opposed to an append. Drives a scene rebuild. */
  onReload(cb: () => void): () => void {
    this.reloadListeners.add(cb);
    return () => this.reloadListeners.delete(cb);
  }

  /** Load a saved scene: replay, don't reconstruct (M6 acceptance). */
  load(events: readonly SceneEvent[]): void {
    this.events.length = 0;
    this.events.push(...events);
    this.seq = this.events.reduce((m, e) => Math.max(m, e.seq + 1), 0);
    // The loaded events are history the model has never seen, so the next turn
    // must not replay them as "changes since last turn".
    this.syncedUpTo = this.events.length;
    this.cachedDoc = null;
    for (const l of this.reloadListeners) l();
  }
}
