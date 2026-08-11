# Vair

**V**irtual **A**rtificial **I**ntelligent **R**eality — a WebXR experience for Meta Quest 3
in which you stand in an empty black void and build a 3D scene by talking.

The product is the editing loop, not the generation. Objects are named on placement so they
can be referenced in later turns, and every command appends to an event log that materialises
into a scene document you can save, reload and share.

`plan.md` is the authoritative design document. **Read it before each session** — including
§2 (non-goals) and §3 (dead ends already investigated).

## Status

| Milestone | State |
|---|---|
| M0 — Void | implemented, **awaiting on-device acceptance** (50 pinch trials, both hands) |
| M1 — Voice loop | **passes on-device** — real speech transcribed and applied on a Quest 2 |
| M2 — Temporal binding | **passes on-device** — "put a cube here" placed the cube where the user pointed |
| M3 — Scene + Claude | **partial** — prompt, schema boundary, apply path, object naming and streaming progressive commit work end to end; the glTF pipeline does not, and first object lands at ~3.0s against a 2s target |
| M4 — Affordances | not started |
| M5 — Audio | not started |
| M6 — Persistence | **partial** — voice save, model auto-naming, reload and the scene library work; share links and the companion web app do not |

§6 says to build temporal binding before anything that touches Claude, so the ring buffer and
measurement-bundle resolver already exist. The M0 HUD prints the resolved point hit on every
pinch, which validates that path on-device from the first milestone.

## Running it

```bash
npm install
npm run dev            # client on http://localhost:5173
npm run dev:server     # API on http://localhost:8787 (optional for M0)
```

Then, with the headset attached over USB and Developer Mode enabled:

```bash
npm run headset        # adb reverse for both ports
```

and open `http://localhost:5173` in the Quest Browser.

`adb reverse` is not just convenience: it gives the headset a **localhost origin**, which is a
secure origin, and secure origins are what WebXR and `getUserMedia` require. The dev server
binds loopback only for that reason. If USB genuinely is not an option, `VAIR_LAN=1 npm run dev`
opens it to the LAN — but you will then need HTTPS to get the microphone in M1.

Enable Developer Mode from the Meta mobile app first; it is not discoverable in-headset.
Remote-debug via `chrome://inspect`.

## Speech to text

**Vosk, offline and local.** Word-level timestamps are a hard requirement (§6.3), which
disqualifies the obvious free option outright: the Web Speech API returns none, and the Quest
browser doesn't implement it anyway. Vosk clears the requirement natively — its word objects are
already `{word, start, end, conf}` in seconds — costs nothing, needs no key, and works offline.

```bash
npm run stt:model                 # 40MB download, 68MB on disk, gitignored
STT_PROVIDER=vosk npm run dev:server
```

Needs `ffmpeg` on PATH to transcode the browser's WebM/Opus to 16kHz mono PCM.

Measured on a 2-core i3 with the small English model: **0.09× realtime** — 727ms to decode 8.3s
of audio, so a 3s utterance lands in roughly 0.3s, comfortably inside M1's 1.5s criterion. The
model loads once at ~255ms and is held for the process lifetime.

The accuracy tradeoff is real: the small model handles command-shaped utterances well and mangles
proper nouns. A larger model is a `VOSK_MODEL_PATH` change and nothing else. If accuracy turns
out to matter more than offline operation, a cloud provider with word timestamps drops in behind
the same `STT_PROVIDER` switch — that's the §11 "one harness, swappable pipelines" shape.

`health.stt` stays false until the model is actually on disk, so the client says "not configured"
rather than promising capture that would fail on first use.

## Mock STT / debug bridge

Real capture works, but a mock is still the fastest way to iterate without speaking aloud — and
the only way to test on a machine with no microphone. Two ways in, both feeding the **real** state
machine, deixis resolver and pose ring buffer; only the mic and the provider are substituted.

**From the browser** (dev builds only, tree-shaken out of production):

```js
window.vair.help()                              // list everything
window.vair.say("put a cube here")              // latch, commit, transcribe, resolve
window.vair.say("make the door this high", { durationMs: 2500, hand: "left" })
window.vair.arm("put a lamp there")             // then pull a trigger yourself
window.vair.measure("here", 800)                // resolve one bundle 800ms in the past
window.vair.poseAt(1500)                        // raw ring-buffer pose
window.vair.state() / .scene() / .events() / .lastUtterance()
```

`say()` **back-dates** the utterance by `durationMs`, so word timestamps index poses the buffer
genuinely recorded while the hand was moving. Move the hand, then call `say()` — the deictic word
binds to where the hand *was*. A mock that stamped every word at "now" would exercise the plumbing
and none of the temporal binding, which is the part that actually breaks.

**From the server** — set `STT_PROVIDER=mock` (no key needed) and `/api/stt` returns a scripted
transcript, so the M1 upload path can be built before a provider is chosen:

```bash
curl -X POST localhost:8787/api/stt/mock -H 'content-type: application/json' \
     -d '{"text":"put a cube here","durationMs":2000}'
curl -X POST localhost:8787/api/stt
```

Both paths share one timing synthesiser (`shared/src/mock-stt.ts`) so they cannot drift.

**This is a test double, not a fallback.** Word times are synthesised from syllable counts, not
measured from audio. It proves the pose lookup, clock conversion and buffer window work. It proves
nothing about a real provider's accuracy, and `health.stt` being true because of it must never be
read as "STT works" — that is why health reports `sttProvider` separately and the UI says "mock".

## Saving and reloading

Say **"save this"** and the scene is stored under a name the model invents from what is actually
in it — a fire and two logs became "the campfire circle". Say **"save this as the reading room"**
and that name is used verbatim. Both are the same code path: saving is a `save_scene` action, so
the model that already has the utterance does the naming, and it costs no extra round trip. A
client-side keyword match would have needed its own naming call and would miss every phrasing
nobody thought of.

Saved scenes appear on the landing page; clicking one replays it and enters VR.

Say **"exit"** (or "I'm done", "get me out of here") to end the session and return to the landing
page, or **"save and exit"** to do both. That needs no special case either: the model emits
`save_scene` then `exit_session` and the existing in-order application handles it. The exit waits
on any save from the same turn — the write would survive leaving the session, but the library is
rendered from its response, so exiting first would drop you onto a list missing what you just
saved. A plain "exit" does not save, and the model says so when the scene isn't empty.

**What persists is the event log, not the folded document** (§8). The document is a fold and can
always be recomputed; the log additionally carries the history — which is why a reloaded scene is
identical rather than merely similar, and why editing continues cleanly on top of it. New object
ids are collision-checked against the live scene rather than a counter, because a reloaded scene
arrives with ids already in use.

The markdown narrative is regenerated from scene state on every save and never read back as truth.

## The model boundary

The model returns **actions**, never events. Events carry `id`, `seq`, `t` and `source` —
bookkeeping the event log owns and the model has no business inventing. `shared/actions.ts`
defines the action vocabulary; `shared/apply.ts` expands actions into event drafts next to the
log that assigns identity.

Three shapes in the model-facing schema deliberately differ from the storage schema, because
structured outputs are most reliable on plain required object fields: `{x,y,z}` objects rather
than the `[x,y,z]` tuples used in storage, `yawDegrees` rather than a quaternion (four
normalised floats invite silently unnormalised rotations), and no optional fields at all.

Prompt layout is dictated by caching: the system prompt is byte-identical across turns so it
caches, and everything volatile — scene, viewer, measurements — goes in the user message.
Interpolating the scene into the system prompt would put changing bytes at the front of the
prefix and make the cache useless.

The turn runs at `effort: "low"` with thinking **off** — placing props from a clear instruction
is closer to structured extraction than to hard reasoning. Thinking is off for variance, not
mean: adaptive produced 9.2s then 3.4s to first object on identical warm requests, and §9 says
inconsistent latency feels worse than uniform latency.

Actions stream back as NDJSON and are committed one at a time, so objects appear as they
resolve. `actions` deliberately precedes `speech` in the schema — structured output is emitted
in schema order, so the first object commits before the model writes a word about it.

Two things to know before you measure latency:

- Editing the action schema costs a **one-time ~4s recompile** on the next request. A cold
  number straight after a schema change is not a regression.
- Retry-on-invalid only fires while nothing has been committed. Once an action has been applied,
  re-running the turn would apply it twice, so a late failure is reported and the partial scene
  stands — every emitted action was individually validated.

## Layout

```
client/    Three.js + WebXR app
  core/    XR session, render loop, clock alignment, pose ring buffer
  input/   pinch detection, interaction state machine, deixis resolution
  scene/   event log, object registry
  vfx/     wisp field (the state indicator)
  audio/   earcons (Tone.js ambient arrives in M5)
  net/     server client
  debug/   in-world HUD — the M0 acceptance instrument
server/    Node API. Holds every key.
  stt/     audio -> transcript with word timings (M1)
  claude/  prompt assembly, schema validation (M3)
  assets/  CC0 catalogue and search
  scenes/  event log persistence (M6)
  latency/ stage timing ingest
shared/    zod schemas — the single source of truth for types
web/       companion app: library and share, NOT an editor
tools/     latency analysis
```

## Configuration

Copy `.env.example` to `.env`. Every key is server-side.

**No API key ever reaches the client** (§14). Note that `import.meta.env` is compiled into the
Vite bundle and is readable by anyone who opens DevTools in the Quest Browser — it is not a
place to put a secret.

STT must return **word-level timestamps**. This is a hard requirement, not a preference: deixis
binds a word to a hand position, and an utterance-level timestamp binds it to a two-second
window during which the hand crossed the room. Reject any provider that does not, and do not
synthesise word times from the utterance duration.

## Things that will bite you

- **Never allocate in the frame loop.** `PoseRingBuffer` is flat typed arrays for this reason.
- The pose buffer holds ~22s at 90Hz. That has to exceed the 15s utterance cap *plus* the STT
  round trip, because the word being looked up is the first word of the sentence.
- Out-of-range buffer queries return `null` rather than clamping. A clamped pose is a wrong
  answer wearing the costume of a right one.
- Head pose comes from `XRFrame.getViewerPose`, not the three.js camera: three only copies the
  XR camera onto the app camera inside `render()`, so reading the camera in a frame callback is
  one frame stale.
- The controller path must always work. Hand tracking will fail.
- Desktop WebXR emulators lie about hand tracking. Test on-device every milestone.

## Known issue

`npm audit` reports a moderate advisory in the esbuild version Vite 5 depends on
(GHSA-67mh-4wv8-2f99, dev server only). The fix is Vite 6+, which needs Node 20+; this project
is on Node 18.18. Loopback-only binding limits the exposure. Revisit when the toolchain moves
to Node 20.
