# Working on Vair

**Read `plan.md` in full before writing code.** It is the authoritative design document and it
carries decisions that are expensive to relitigate.

## The rules that are not negotiable

- **§2 non-goals and §3 dead ends are closed.** No passthrough, no multiplayer, no 2D scene
  editor, no runtime mesh generation. Unity Asset Store, Suno, Spotify and YouTube Audio Library
  have all been investigated and ruled out on licensing or API grounds. Do not re-propose them.
- **No API key ever reaches the client** (§14). Everything goes through `server/`.
- **The controller path must always work** (§14). Hand tracking will fail.
- **Never respond "I can't find that"** (§14). Substitute the nearest asset with an honest
  spoken note, or fall back to matched-material primitives.
- **STT must return word-level timestamps** (§6). Hard requirement. Do not interpolate them.
- **Do not start a milestone before the previous one passes on-device** (§12). Desktop WebXR
  emulators lie about hand tracking.

## Where the truth lives

- `shared/` holds the zod schemas. Types are derived from them, never hand-written alongside.
- The event log is the scene (§8). State is a fold, in `shared/src/fold.ts`, used by both client
  and server so a shared scene replays identically.
- The markdown narrative is derived on save and never read back.
- Local affordance edits append to the same log and the same undo stack. There is one of each.

## Client invariants

- Never allocate in the frame loop. `client/src/core/pose-buffer.ts` is flat typed arrays.
- The client supplies every candidate measurement; the model decides which one the sentence
  implies (§6). Don't add "this probably means height" heuristics to `input/deixis.ts`.
- Affordance grammars ship from the model with the payload (§9). If you write
  `if (type === "lamp")` in the client, something has gone wrong.
- Wisps stay **low salience while thinking** (§7). A conspicuous orbit makes the user turn to
  watch, which changes their facing direction, which corrupts the next "further back".

## Debugging without a headset or an STT key

`window.vair` (dev builds only) drives the real pipeline — see the README section. `vair.say()`
back-dates the utterance so deictic words bind to genuinely recorded past poses; that back-dating
is the point, so don't "simplify" it to stamp words at the current time. `STT_PROVIDER=mock` does
the same job at the `/api/stt` boundary.

Neither is a fallback. If a real provider turns out not to emit word-level timestamps, the answer
is a different provider, not the mock (§6.3).

Real STT is `STT_PROVIDER=vosk` — offline, no key, native word timings, `npm run stt:model` to
fetch the model. Don't reach for the Web Speech API: it returns no word timings and the Quest
browser doesn't implement it. `health.stt` deliberately reports false until the model is on disk.

## The model boundary

The model returns **actions** (`shared/actions.ts`), never events — events carry id/seq/t/source
that the log owns. `shared/apply.ts` is the only expander; don't add a second one server-side.

The system prompt must stay byte-identical across turns or prompt caching stops working. Scene,
viewer and measurements belong in the user message. If you need to add a rule, add it to
`buildSystemPrompt`; if you need to add per-turn state, add it to `buildUserMessage`.

The client sends every candidate measurement and the model picks (§6). Don't add
"this probably means height" logic to either side of the wire.

`actions` precedes `speech` in the schema on purpose — structured output is emitted in schema
order, so the first object commits before the sentence is written. Don't reorder it. Each action
is committed as it streams in, which is also why the §16 retry only fires when nothing has been
applied yet: retrying after a partial commit would double-apply.

Thinking is off on this turn for **variance**, not mean — adaptive measured 9.2s then 3.4s on
identical warm requests. If you turn it back on, expect the latency to become uneven, which §9
says is worse than uniformly slower.

## Commands

```bash
npm run dev          # client, loopback:5173
npm run dev:server   # API, :8787
npm run headset      # adb reverse for both
npm run typecheck    # all workspaces
npm run latency      # stage timing tables from server/data/latency.jsonl
```

## Housekeeping

Update the milestone status table in `README.md` and §12 of `plan.md` as work lands. Do not
silently expand scope.
