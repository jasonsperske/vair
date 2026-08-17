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
| M3 — Scene + Claude | **partial** — prompt, schema boundary, apply path, object naming and streaming progressive commit work end to end, and generated props now load as real meshes; the curated kit is still three primitives, and first object lands at ~3.0s against a 2s target |
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

### Over Wi-Fi instead of the cable

The cable is only needed once, to tell the headset to start listening for adb on the network.
With it plugged in and `adb devices` showing the headset:

```bash
adb tcpip 5555                   # adbd restarts, listening on :5555
                                 # ...now unplug the cable
adb connect 192.168.4.29:5555    # your headset's address
```

The wireless connection is a separate transport and asks for its own authorisation, so put the
headset on and accept the debugging prompt again — tick *Always allow from this computer*.
`adb devices` should then show `192.168.4.29:5555   device`. The address is in the headset under
Settings → Wi-Fi → your network, or on your router.

Nothing else changes. `adb reverse` is carried over the adb connection itself, so it does not
care whether that connection is a cable or a network:

```bash
npm run headset        # same two reverses, now over the air
```

**You still open `http://localhost:5173`, and you still do not want `VAIR_LAN=1`.** Being on
Wi-Fi is not a reason to expose the dev server to the LAN: the reverse forward makes the
headset's own localhost point back at this machine either way, and localhost is the secure
origin WebXR and `getUserMedia` require. `http://192.168.4.29:5173` is still the wrong URL,
even now that the headset can reach it — it will load, and the *enter VR* button will not
appear.

Two things worth knowing:

- With the cable *and* the wireless connection attached, adb sees two devices and `adb reverse`
  fails with *more than one device/emulator*. Unplug the cable, or pin the run to one of them:
  `ANDROID_SERIAL=192.168.4.29:5555 npm run headset`.
- TCP mode does not survive rebooting the headset, and the address changes if the DHCP lease
  does. Either one means plugging the cable back in for one more `adb tcpip 5555`.

If `adb connect` reports *connection refused*, adbd is not in TCP mode — the `adb tcpip` step
did not take, or the headset has rebooted since. If it reports *failed to authenticate*, the
prompt is waiting for you inside the headset.

Wi-Fi adb is enough for the M0–M2 loop, but it is worth knowing that audio upload and the model
turn both cross it, so the §16 stage timings measure your wireless link as well as the pipeline.
Take latency numbers over the cable.

### Shutting it down

The reverse forwards outlive the process that created them, so they need removing explicitly:

```bash
npm run unforward       # drop the :5173 and :8787 reverses
npm run unforward:all   # ...or every forward on the device
npm run disconnect      # drop the Wi-Fi connection to the headset
npm run headset:stop    # both of those, in one
```

`adb reverse --list` says what is currently forwarded. None of this touches TCP mode on the
headset: after `npm run disconnect`, a plain `adb connect 192.168.4.29:5555` picks it up again
with no cable — only rebooting the headset undoes `adb tcpip 5555`.

## Talking to it

Two gestures, deliberately different:

- **Pinch (thumb to middle finger) latches.** Press to start, press again to commit. §7 rules out
  holding a pinch through an utterance because it occupies the hand you need for pointing.
- **Controller trigger is hold-to-talk.** Hold it down while speaking, release to commit. The
  objection above doesn't apply — the controller *is* the pointer, so a held trigger leaves aiming
  intact.

A trigger tap shorter than 300ms is treated as a latch instead, so a quick pull doesn't commit an
empty utterance. Both gestures therefore live on the same button: tap to latch, hold to talk.

**While the trigger is held, the 1.5s silence backstop is suppressed.** That backstop exists
because a missed commit gesture must never strand the user, and a held trigger can't miss its
commit — letting go *is* the commit. Pausing mid-sentence while holding must not cut you off. The
15s hard cap still applies.

Hands are drawn as one sphere per tracked joint, sized by the joint's own radius. Toggle with
`window.vair.hands(false)`. They're rendered directly rather than via three's
`XRHandModelFactory`, whose only lifelike profile fetches a glTF from a CDN — the headset reaches
this app over `adb reverse` on localhost and may have no route to the internet, which would leave
you with invisible hands and no obvious reason why.

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

## The ground

There is a floor at y=0 with nine styles — `void`, `grid` (the default), `grass`, `stone`,
`sand`, `snow`, `wood`, `water`, `carpet`. Deixis was always raycasting that plane; this makes it visible,
which is what stops placed objects reading as floating in nothing.

Say **"make the floor grass"** and it changes in a frame. §13 requires the ground to be local and
instant, never a round trip, so common phrasings are matched on-device and applied straight to the
event log. Anything the matcher isn't confident about escalates silently to the model, per §9 —
the user is never told there are two paths.

The confidence bar is deliberately high, because §9 is explicit that a wrong local match produces
a confident incorrect action while a missed one costs only a round trip. A match needs both a
ground noun *and* exactly one recognised style, in a sentence short enough to be about nothing
else. So "make the floor grass" is local, and "put a stone bench on the grass over there" is not a
ground command at all and goes to the model — as does "the floor is lava", which comes back as
stone with an honest note that there's no lava texture.

This is the first thing to populate the `local` row in `npm run latency`, which is what makes the
local-vs-server comparison in `tools/` mean anything.

## Sky and ceiling

`set_sky` gives the void a gradient dome — `day`, `dusk`, `night` (with procedural stars),
`overcast`, `storm`, or `void` for §2's original black, which stays the default. It's two colours
and a star toggle in a shader rather than a cube map, so styles change by swapping uniforms with
no texture loading, no network and nothing to evict.

`set_ceiling` closes the room in: `tiles`, `concrete`, `plaster`, `wood`, at a height between 1.8m
and 12m. Faded at the rim like the ground, because a hard rectangular edge overhead reads as a
floating slab.

**Whole-place requests compose.** "Make this the backrooms" isn't a special case — the model sets
carpet floor, tile ceiling at 2.4m, no sky, flat amber ambient and a buzzing amber lamp, all in one
turn, because those together *are* the effect and any one alone misses it:

```
"make this the backrooms"              → carpet + tiles@2.4m + no sky + amber fill + lamp
"put me under a starry night sky"      → grass + night + low ambient + moonlight sun
"make the ceiling concrete"            → local, instant
```

Sky and ceiling are *surfaces*, not objects — no name, not movable, not deletable like a lamp.
`void` removes one.

## Walls and doors

Walls are described by their two **endpoints**, not a centre and a length — because "put a wall
from here to there" produces two deictic tokens, so §6 hands the model two measurement bundles and
it drops one on each end. A centre-and-length wall would make the most natural phrasing the
hardest to satisfy. Verified: pointing at two spots produced a wall spanning exactly those points.

**Doors cut a real opening.** The wall is rebuilt as segments around the hole — left of it, right
of it, and a lintel above — rather than laying a door-shaped panel over a solid wall. Boolean
geometry is the textbook answer and far too heavy for a Quest; three boxes look identical from
every angle that matters. A 4m wall with a 0.9m door becomes 1.55m + lintel + 1.55m.

**A window is a door with a sill.** Both are one `place_opening` action with a `kind` — the only
real difference is the height of the hole's bottom edge, and that difference is what the wall
geometry reads to decide whether to build an apron beneath it. A door's sill is forced to the
floor regardless of what the model asks for; a raised one would be a hole to step over.

```
"put a brick wall from here to there"      → wall spanning both pointed-at spots
"build me a room with a door in the front" → four walls, a door, a ceiling, a lamp
"place a window in this wall"              → uses the wall you POINTED at
"open the door" / "shut the window"        → swings on its hinge
```

"This wall" is deictic and resolves through `pointHit.objectId` — the measurement bundle already
carries which object the finger was on, so with two walls in the scene it picks the one you were
pointing at rather than the nearest. That path needed no new machinery; §6 had already built it.

A door belongs to a wall and stores only that relationship, never a copy of the wall's position —
so a moved wall can't leave its door behind. Removing a door rebuilds the wall and closes the hole.

## Lights

**A light is a scene object**, not a separate concept — `assetId: "light:point"` or
`"light:sun"`, with colour and intensity in the `parameters` bag that `SceneObject` already
carried. That wasn't a shortcut: it means "move the lamp", "get rid of the lamp", undo, save and
reload all work with no new machinery, and adding lighting required **no new event type at all**
(`object_placed` already had `parameters`; `parameter_set` already existed).

```
"put a warm light above the table"     → a point light, named, placed above it
"add a low evening sun from the left"  → a directional sun, plus a drop in ambient
"make it brighter" / "a bit darker"    → local, instant, no round trip
"make the lamp brighter"               → escalates: which lamp is the model's job
```

Point lights get a small glowing marker, because an unlit point source is invisible by
definition — without one you'd say "put a lamp there", the room would brighten, and there'd be
nothing to look at, point at, or move. Suns get no marker: they're nominally infinitely far away,
and a floating ball would be a lie about where the light is.

Colours are a closed palette (`warm`, `candle`, `moonlight`, `amber`, …) for the same reason
ground styles are: structured output is far more reliable on an enum than on a hex string, and the
model can only ask for what the client can render. Intensity is 0–10 in the model's units, mapped
to renderer units client-side and clamped on the way in.

Shadows are off — they're a real cost on a Quest and §13's budget is already tight.

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

## Parametric props

Alongside the fixed CC0 kit, the model can place **generated** props: a table built to the size
asked for rather than the nearest table somebody modelled. These come from a hosted build of the
[Object Studio](https://jasonsperske.github.io/object_studio/) library, which publishes an agent
bundle — an index of every generator and its parameters, the sources, and a runtime that turns one
into geometry.

```
STUDIO_URL=https://jasonsperske.github.io/object_studio/
```

The server fetches that, bakes the mesh it is asked for into a glTF, and caches it under
`DATA_DIR/studio`. The headset loads a URL like any other asset. The model names a generator and
its parameters in one string:

```
studio:table?length=2000&width=950&legProfile=tapered
studio:rock?size=900&erosion=0.8&moss=0.6
```

Parameters outside their range are clamped and unknown names are ignored, so a near miss still
places something. Anything the generator's own metrics flag — a chair with too little knee
clearance, a case with more drives than bays — comes back on `X-Studio-Notes` and is logged.

In the headset a `studio:` id loads the baked glTF (`client/src/scene/gltf.ts`). The node goes
into the scene graph empty and fills in when the bytes land, because the scene view has to hand
back a node synchronously; a load that fails stands in a primitive rather than nothing (§14). The
mesh's origin is at its **base**, not its centre, so a table on the floor sits at y=0 — the
opposite of the primitives, and the system prompt says so.

`STUDIO_URL` is fetched **and its code is evaluated on the server**, so point it at a build you
control. Unset it and the server runs from the snapshot committed in
`server/src/assets/studio-snapshot.json`, which keeps search and the prompt working offline; a
generator whose source has never been fetched is then not offered at all. See plan.md §2 for why
this is in scope at all.
