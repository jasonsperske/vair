# plan.md — Voice-Driven VR Scene Builder

Handoff document for a Claude Code session. Read this fully before writing code.

---

## 1. What we are building

A WebXR experience for Meta Quest 3 in which a user, standing in an empty black void,
builds a 3D scene by talking. Speech is combined with hand/controller gesture so that
deictic commands work naturally:

- "Place the lamp **here**" — while touching a point on a virtual table
- "Make the door **this high**" — while holding a hand above their head
- "Move it **further back**" — resolved against the user's facing direction

Objects are **named on placement** so they can be referenced in later turns. Every command
appends to an event log which materialises into a scene document that can be saved,
reloaded and shared.

### The one-sentence thesis

Existing tools (World Labs Marble, Meta WorldGen, skybox generators) generate a world and
hand it to you frozen. **Persistent named handles plus conversational editing** is the
thing nobody has shipped. Generation quality is secondary; the editing loop is the product.

---

## 2. Non-goals

These are explicitly out of scope. Do not build them, do not scaffold for them, do not
add config flags for them.

- Passthrough / mixed reality / room scanning. The scene is a fully immersive black void.
- Multiplayer or real-time collaboration.
- A web-based 3D scene editor. The companion web app is view-and-share only (see §10).
- Runtime mesh generation, Gaussian splats, or any diffusion-based 3D asset creation.
- Store distribution, monetisation, accounts-with-billing.
- Native Unity or Unreal builds. See §11 for the one native exception.

---

## 3. Dead ends — already investigated, do not revisit

| Idea | Why it's dead |
|---|---|
| Unity Asset Store as a runtime asset source | No official runtime API. Licence forbids redistribution and forbids end users extracting assets. `.unitypackage` is an Editor-time format and is not runtime-loadable. |
| Suno for ambient music | No public developer API as of mid-2026. Third-party wrappers are reverse-engineered consumer-app clients. Song generation is also the wrong shape for loopable ambience. |
| Spotify integration | Developer terms prohibit game functionality and prohibit synchronising recordings with visual media. DRM'd audio also cannot be routed through our spatial audio graph. |
| YouTube Audio Library | Download-only, no API, third-party downloading prohibited. Only the CC-BY subset is licensed for non-YouTube use. |
| In-headset OAuth to third-party services | Typing credentials in a headset is miserable. All credentials are entered in the companion web app; the server holds all keys. |
| Quest Pro for eye-tracked gaze deixis | XR2 Gen 1 (Quest 2-class GPU), discontinued, and eye tracking is not exposed through WebXR. Revisit only if we ever go native. |

---

## 4. Stack

**Client:** TypeScript, Three.js, WebXR (`immersive-vr`), Vite dev server.
**Audio:** Tone.js — procedural/generative ambient, no licensed music. Synthesis plus a
small bank of CC0 loopable textures.
**Assets:** self-curated glTF kit from CC0 sources (Poly Haven, Kenney, Quaternius,
Sketchfab CC0). Loaded at runtime via `GLTFLoader` with a Draco/Meshopt pipeline.
**Server:** Node + TypeScript. Holds all API keys. Endpoints for STT, Claude, asset
catalogue, scene persistence.
**Model:** Claude via the Anthropic API, structured JSON output.
**STT:** cloud Whisper (or equivalent) with **word-level timestamps** — this is a hard
requirement, not a preference. See §6.
**Target device:** Quest 3 / 3S. Quest 2 is not a target (6GB RAM, half the GPU).

### Why WebXR and not Unity

1. Iteration is seconds, not minutes. `adb reverse tcp:5173 tcp:5173`, hot reload,
   Chrome DevTools remote debugging into the headset.
2. Linux is first-class. Unity's Meta XR path needs Windows-only tooling (Horizon Link)
   for in-editor VR preview.
3. **No IL2CPP.** Unity AOT-compiles for Quest, so model-generated behaviour code would
   need an embedded interpreter. In JS we can run generated behaviour in a sandboxed
   worker directly.

---

## 5. Repository layout

```
/client          Three.js + WebXR app
  /core          XR session, render loop, pose ring buffer
  /input         gesture detection, state machine, deixis resolution
  /scene         scene document, event log, object registry
  /audio         Tone.js generative ambient
  /vfx           wisp system + state indication
  /net           server client, streaming
/server          Node API
  /stt           audio -> transcript with word timings
  /claude        prompt assembly, schema validation, streaming
  /assets        catalogue, search, glTF serving
  /scenes        persistence, event log storage
/shared          scene schema (zod), affordance grammar types
/web             companion app (library + share, NOT an editor)
/tools           latency analysis scripts
```

---

## 6. The core mechanic: temporal binding

**This is the highest-risk, highest-value part of the system. Build it before anything
else that touches Claude.**

Speech and gesture are asynchronous. The deictic moment is *when the word was spoken*, not
when the utterance ended. By the time a transcript returns, the hand has moved.

### Required implementation

1. **Pose ring buffer.** Every XR frame, record `{ xrTime, head, leftHand, rightHand,
   leftController, rightController }` into a fixed-size circular buffer covering the last
   ~10 seconds. Never allocate in the hot loop.
2. **Audio capture with timestamps.** Record the utterance with a start timestamp captured
   from the same clock domain as the XR frame time. Persist the offset between
   `AudioContext.currentTime` and `XRFrame` time at capture start; you will need it and it
   drifts.
3. **Word-level STT.** The transcript must return per-word start/end times. Reject any STT
   provider that does not.
4. **Deixis resolution.** For each deictic token ("here", "this high", "this big", "this
   way", "like this"), look up the buffered pose at that token's timestamp and produce a
   **measurement bundle**:

```ts
type MeasurementBundle = {
  tokenTime: number;
  pointHit: { position: Vec3; normal: Vec3; objectId: string | null } | null;
  handHeightAboveFloor: number;
  twoHandSpan: number | null;
  gazeRay: { origin: Vec3; direction: Vec3 };
  palmNormal: Vec3;
  headYaw: number;          // for resolving "back", "left", "closer"
  trackingConfidence: number;
};
```

The client supplies **every candidate measurement**. Claude picks which one the linguistic
form implies. Client does physics; model does interpretation.

### Acceptance test

"Put a cube here" while touching a surface places a cube within 5cm of the touched point,
across 20 trials, with the hand moving continuously during the utterance.

---

## 7. Interaction state machine

Gesture: **thumb-to-middle-finger touch** to start listening, **retouch** to commit.
Detect the *pose* (fingertip distance below threshold with hysteresis), not the snap motion.
The controller trigger is an always-available equivalent and must never be removed.

### States

| State | Trigger | Wisp behaviour |
|---|---|---|
| `IDLE` | default | slow ambient drift |
| `LISTENING` | pinch pose, or trigger | blue, rising, converge on active hand |
| `TRANSCRIBING` | commit / silence timeout | blue, tightening |
| `THINKING` | request in flight | blue, slow peripheral orbit — **low salience** |
| `APPLYING` | response streaming in | wisps flow toward the target object |
| `NEEDS_INPUT` | clarification required | amber |
| `FAILED` | error / no match | red, brief |

### Rules

- **Latch, not hold.** The pinch starts listening and releases immediately. Holding the
  pose through the utterance would occupy the hand needed for pointing.
- **Backstop:** auto-commit after 1.5s of silence and hard-cap utterances at 15s. A missed
  commit gesture must never strand the user in `LISTENING`.
- **Show the transcript** as floating text before the round trip. STT error is the most
  frequent failure and the only one the user can diagnose instantly.
- **Cancel:** a new pinch during `THINKING` aborts the in-flight request rather than queuing.
- **Haptics and audio lead.** A tick on listen-start and listen-stop; distinct earcons per
  transition. During "place the lamp here" the user is looking at the table, not at an
  indicator — visual state outside the FOV is no state at all.
- **Never** teach a gesture performed with the palm toward the face. Palm-pinch is reserved
  by the system and left palm-pinch exits the WebXR session.
- **Low salience while thinking.** If wisps orbit conspicuously the user turns to watch
  them, which changes their facing direction, which corrupts the next "further back".

---

## 8. Scene document and event log

**Event-sourced.** Every command — local or model-driven — appends an immutable event.
Scene state is a fold over the log. This gives undo, replay, and shareable history from
one decision.

- **JSON, not XML.** Better model reliability, JSON Schema validation, fewer tokens.
- **Store resolved absolutes, never gesture phrases.** "Make the door this high" is
  meaningless to someone opening a shared scene. Write `height: 2.0` and keep the utterance
  as annotation.
- **The markdown narrative is derived, not authoritative.** Regenerate it from scene state
  on save. Two sources of truth will drift within a week.
- **Object naming.** Every placed object gets a stable id and a human name, either
  model-assigned or user-assigned. Names are the reference surface for all later commands.
- **Sync.** Every Claude request carries the events applied since the last model turn, so
  locally-handled edits never leave the model reasoning about stale state.

---

## 9. Affordance fast path

When Claude returns an object it may attach affordances. Crucially, **the model ships the
grammar with the payload** — trigger phrases, synonyms, target parameter, step size. Client
code stays generic and never needs to know what a lamp is.

```ts
type Affordance = {
  label: string;              // "smaller / larger"
  parameter: string;          // "scale"
  axis?: "x" | "y" | "z";
  triggers: string[];         // ["smaller","tinier","shrink","reduce"]
  direction: 1 | -1;
  step: number;               // 0.9
  min?: number; max?: number;
};
```

### Rules

- **Always attempt local first; escalate silently on low confidence.** No extra gesture,
  no visible mode. The user must never learn there are two paths — inconsistent latency
  feels worse than uniform latency.
- **Set the local confidence threshold high.** A wrong local match produces a confident
  incorrect action; a missed match costs only a round trip. Bias hard toward escalation.
- **Magnitude modifiers:** "a little" / "somewhat" / "much" / "way" → multiplier scaling.
- **Repeat momentum:** a user repeating "smaller" is telling you the step size is wrong.
  Accelerate on consecutive repeats of the same affordance.
- **Frame resolution:** "further back" is relative to the user's facing direction at the
  moment of utterance, from the ring buffer — not object-forward, not world space.
- Local edits append to the same event log and the same undo stack. Do not build two.

---

## 10. Companion web app

Deliberately minimal in v1. **Account, credential entry, scene library, thumbnails, share
links, and a static viewer.** Authoring happens only in VR — that is the pitch, and a 2D
scene editor is a second product that would compete with it.

Capabilities the user enables here are delivered to the client as a **capability manifest**
injected into the Claude system prompt each turn. Ungated failures must be graceful and
spoken ("I can't do that yet — you can enable it on the web").

**The zero-connection experience must be genuinely good.** Most users will never connect
anything. If the ungated baseline is thin the funnel dies at first run.

---

## 11. Native C++ measurement harness (separate track, separate repo)

Not part of the product. A time-boxed measurement rig to answer three questions WebXR
cannot answer. **Cap: three weeks. Grey primitives and one shader. No assets, no audio,
no Claude integration. Throw it away afterward.**

Base it on Meta's OpenXR SDK sample `XrHandsAndControllers` (Gradle + CMake, builds from
the CLI on Ubuntu; SDK path must contain no spaces).

The real justification is **clock alignment**: `xrLocateHandJointsEXT` accepts an arbitrary
`XrTime`, so hand pose can be queried at the exact moment a word was spoken rather than
interpolated between sampled frames. WebXR structurally cannot do this.

### The three experiments

1. **Gesture reliability by zone.** 50 trials at marked physical heights. Log tracking-loss
   rate and pose variance per hand region — especially above-head, which is outside the
   camera cone and is exactly where "this high" puts the hand.
2. **On-device STT feasibility.** whisper.cpp, quantized base model, arm64 + NEON. Decides
   whether the affordance fast path can ever be genuinely fast.
3. **Perceived vs. measured latency.** Inject artificial delay in 100ms steps and find the
   noticing threshold. If 400ms is indistinguishable from 80ms, the entire on-device STT
   effort is unnecessary.

### Methodology requirement

Build **one harness with swappable pipelines** — same scene, same gestures, a config flag
selecting local-vs-server intent and on-device-vs-cloud STT. Two separately-written apps
compare implementations, not architectures, and the one written second always wins.

Instrument stages, not totals: timestamp utterance-start, VAD-end, transcript-ready,
intent-resolved, scene-mutated, frame-presented into a ring buffer; dump over `adb`.

---

## 12. Milestones

Each milestone has a testable acceptance criterion. Do not start the next before the
current one passes on-device.

**M0 — Void.** WebXR session, black environment, wisp particle system, hand tracking with
25 joints, thumb-middle pinch detection with hysteresis, controller fallback, haptic tick.
*Accept:* pinch reliably toggles a debug indicator across 50 trials on-device, both hands.
*Status:* implemented — **awaiting on-device acceptance run**. Verified in the Immersive Web
Emulator (Quest 3 profile, head at 1.60m): session enters, void + wisps + HUD render at ~60fps,
both controller triggers latch correctly with independent per-hand counters, and the state
machine completes IDLE → LISTENING → silence backstop → FAILED → IDLE. The hand-tracking pinch
path is NOT covered by that — emulators lie about hand tracking, so it stays unverified until
the on-device run. The §6 pose ring buffer and
deixis resolver landed here rather than in M2, per the instruction in §6 to build temporal
binding first; the debug HUD prints the resolved point hit on every pinch so that path is
exercised on-device from M0. Interpolation error measured at <0.01mm against a synthetic
90Hz track. Buffer holds ~22s at 90Hz, sized to exceed the 15s utterance cap plus the STT
round trip.

**M1 — Voice loop.** Gesture-gated audio capture, upload, cloud STT, floating transcript,
full state machine driving wisp behaviour, cancel, silence backstop.
*Accept:* speak a sentence, see an accurate transcript within 1.5s, cancel mid-flight.

**M2 — Temporal binding.** Pose ring buffer, word-level timestamps, measurement bundle,
deixis resolution. Hardcoded object types only.
*Accept:* the §6 acceptance test passes.

**M3 — Scene + Claude.** Scene schema, event log, backend proxy, asset catalogue, object
naming, streaming progressive commit (ground plane and lighting instant; objects populate
as they resolve).
*Accept:* "put a wooden table here, and a lamp on it" produces both, correctly named and
positioned, first object visible in under 2s.
*Status:* prompt, schema boundary, apply path and **streaming progressive commit** built;
the **glTF asset pipeline is not**, so the catalogue is three primitives and every prop is
a substitution. The acceptance utterance passes on content: both objects placed,
geometrically stacked, distinctly named, substitution spoken honestly.

The model returns *actions*, not events — the event log owns id/seq/t/source, and
`shared/apply.ts` expands actions into events next to the log that assigns identity.
Actions stream as NDJSON and each one is committed the moment it arrives; a five-object
scene lands at 3.5s / 4.1s / 4.8s / 5.5s rather than all at the end.

*Latency, measured warm:* **~3.0s to first object**, 4.1s total for a one-object turn.
Misses the 2s criterion. Two known costs were removed getting there — `actions` now
precedes `speech` in the schema so the first object commits before the sentence is
written, and thinking is off because adaptive was *variable* (9.2s then 3.4s on identical
warm requests, and §9 says inconsistent latency feels worse than uniform). Remaining
options if 2s is to be met: fast mode, or a smaller model for this turn.

*Gotcha:* changing the action schema costs a one-time ~4s recompile on the next request.
A cold measurement after a schema edit is not a regression.

**M4 — Affordances.** Model-supplied grammars, local recogniser, escalation, magnitude
modifiers, repeat momentum, undo.
*Accept:* "a little smaller" applies in under 300ms; "a little smaller and turn it toward
the window" escalates transparently with no user-visible difference in mechanism.

**M5 — Audio.** Tone.js generative ambient reacting to scene state — swell on placement,
key shift with time of day, thin out in empty scenes. Web Audio HRTF for object sounds.
*Accept:* audio changes audibly and appropriately when the scene changes, with no clicks.

**M6 — Persistence.** Save, auto-name, reload, derived markdown narrative, companion web
library and share links.
*Accept:* a scene built in VR reloads identically in a fresh session from a share URL.

---

## 13. Performance budget

- Ground plane, sky, lighting and object *movement* are **local and instant**. Never a
  round trip. If picking up a named object takes 2s the illusion dies.
- Under 5s from utterance to first visible change feels like magic; over 15s feels broken.
- Browser heap will hit limits before native would. Implement asset eviction from M3, not
  later.
- Budget roughly 60–70% of native throughput — no Application SpaceWarp, limited foveated
  rendering control.

---

## 14. Non-negotiables

- **No API key ever reaches the client.** All model, STT and asset access goes through the
  server.
- Never store third-party passwords. OAuth tokens only, encrypted at rest.
- The controller path must always work. Hand tracking will fail, and a user who cannot get
  the app's attention is a user who quits.
- Never respond "I can't find that." When an asset is missing, substitute the nearest match
  with an honest spoken note, or fall back to matched-material primitives.

---

## 15. Dev environment (Ubuntu)

```bash
# adb device access
sudo usermod -aG plugdev $USER
# /etc/udev/rules.d/51-android.rules -> Meta vendor id 2833

# serve to headset
npm run dev                                  # vite, host 0.0.0.0
adb reverse tcp:5173 tcp:5173                # then open localhost:5173 in Quest Browser
```

- Enable Developer Mode via the Meta mobile app first — it is not discoverable in-headset.
- HTTPS or `localhost` is required for microphone access. `adb reverse` gives you the
  `localhost` origin for free.
- Remote-debug via `chrome://inspect` over adb.
- USB-A to USB-C is fine; only Horizon Link needs more, and Link is Windows-only anyway.

---

## 16. How to work on this

- Read this file before each session. Update §12 milestone status as you go; do not
  silently expand scope.
- Keep `shared/` schemas as the single source of truth and generate types from them.
- Every model interaction goes through one validated schema boundary. If Claude returns
  something unparseable, retry once with the validation error appended, then fail loudly.
- Write the latency instrumentation in M1, not later. Retrofitting timestamps is painful
  and the numbers are the whole point of several decisions downstream.
- Test on-device every milestone. Desktop WebXR emulators lie about hand tracking.

## 17. Open questions

- Does gaze-based deixis outperform touch/point enough to justify a future native port?
  (Blocked: eye tracking is not exposed through WebXR.)
- Where is the noticing threshold for latency? M11-experiment-3 answers this and may
  cancel a large chunk of planned optimisation work.
- What is the right size for the curated asset kit? Start at ~150 well-chosen props; the
  miss rate at that size determines whether the concept survives.
- Does the app need a purpose beyond generation — a game, a DM, a sketchpad? "Speak a world
  into existence" demos brilliantly for ninety seconds. The second act is unsolved.
