import { Euler, HemisphereLight, Quaternion, Vector3 } from "three";
import { applyActions, synthesizeTranscript } from "@vair/shared";
import { clock } from "./core/clock.js";
import { poseBuffer } from "./core/pose-buffer.js";
import { createRuntime, isSupported } from "./core/xr.js";
import { HandInput } from "./input/hands.js";
import { InteractionMachine } from "./input/state-machine.js";
import type { ResolveOptions } from "./input/deixis.js";
import { resolveUtterance, summariseUtterance, type ResolvedUtterance } from "./input/utterance.js";
import { EventLogStore } from "./scene/event-log.js";
import { ObjectRegistry } from "./scene/registry.js";
import { SceneView } from "./scene/view.js";
import { WispField } from "./vfx/wisps.js";
import { HandModels } from "./vfx/hand-models.js";
import { Ground } from "./vfx/ground.js";
import { matchGroundCommand } from "./input/ground-command.js";
import { DebugHud, type HudData } from "./debug/hud.js";
import { earcons } from "./audio/earcons.js";
import { AudioCapture } from "./audio/capture.js";
import {
  health,
  listScenes,
  loadScene,
  saveScene,
  streamTurn,
  transcribe,
  type SavedSceneSummary,
} from "./net/api.js";
import { LatencyTurn, newTurnId } from "./net/latency.js";
import type { HandSide } from "./core/pose-buffer.js";

/**
 * M0 — Void (plan.md §12).
 *
 * WebXR session, black environment, wisps, hand tracking, thumb-middle pinch
 * with hysteresis, controller fallback, haptic tick.
 *
 * Accept: pinch reliably toggles a debug indicator across 50 trials on-device,
 * both hands.
 *
 * The pose ring buffer and deixis resolver are here too, ahead of M2, because
 * §6 says to build temporal binding before anything that touches Claude.
 */

const overlay = document.getElementById("overlay") as HTMLDivElement;
const button = document.getElementById("enter-xr") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const scenesEl = document.getElementById("scenes") as HTMLDivElement;
const sceneListEl = document.getElementById("scene-list") as HTMLUListElement;

const runtime = createRuntime();
const hands = new HandInput(runtime.renderer);
const handModels = new HandModels(runtime.renderer, runtime.root);
const wisps = new WispField();
const hud = new DebugHud();
const log = new EventLogStore();
const registry = new ObjectRegistry(runtime.root);
const ground = new Ground(runtime.root);
// Projects the event log onto the scene graph. Nothing else adds meshes.
new SceneView(registry, log, ground);

runtime.root.add(wisps.points);
runtime.root.add(hud.mesh);
// Just enough light that placed primitives are not silhouettes. The void stays
// a void — no environment map, no sky (plan.md §2).
runtime.root.add(new HemisphereLight(0x4a5f9e, 0x080a12, 0.6));

/**
 * Real microphone capture. Verified working inside an immersive session on
 * Quest 2 before this was wired — that was the M1 gate.
 */
const capture = new AudioCapture();
const CAPTURE_AVAILABLE = AudioCapture.supported();

/** Stage timings for the turn in flight (§16). */
let turnLatency: LatencyTurn | null = null;
/**
 * Flushed by the frame loop rather than inline, so `frame_presented` — stamped
 * on the first frame after the scene changed — makes it into the sample.
 */
let flushLatencyAfterFrame = false;

function endTurnTiming(): void {
  flushLatencyAfterFrame = true;
}

/** A mock utterance waiting for the next commit. Set by the debug bridge. */
type ArmedUtterance = { text: string; durationMs: number };
let armedUtterance: ArmedUtterance | null = null;
let lastResolved: ResolvedUtterance | null = null;

/** Set from /api/health — the server holds the key, the client only asks. */
let claudeAvailable = false;

let listenStartXrTime = 0;
let transcriptLine = "";
let note = "";
let lastSpeech = "";
let lastXrTime = 0;

const machine = new InteractionMachine({
  onListenStart(side, xrTime) {
    hands.pulse(side, 0.5, 30);
    listenStartXrTime = xrTime;
    pressCount[side]++;
    toggle = !toggle;
    transcriptLine = "";
    note = "";

    turnLatency = new LatencyTurn(newTurnId());
    turnLatency.mark("utterance_start", xrTime);

    // A mock utterance bypasses the microphone entirely, so don't open it.
    if (!armedUtterance && CAPTURE_AVAILABLE) void beginCapture(xrTime);
  },

  onListenStop(reason, xrTime) {
    hands.pulse(machine.side, 0.3, 20);
    turnLatency?.mark("vad_end", xrTime);

    const armed = armedUtterance;
    armedUtterance = null;
    if (armed) {
      completeUtterance(armed, xrTime);
      return;
    }

    if (!CAPTURE_AVAILABLE) {
      // Honest failure rather than a state machine stranded in TRANSCRIBING.
      // The bridge hint only makes sense where the bridge exists.
      note = import.meta.env.DEV
        ? 'no microphone here — try window.vair.say("put a cube here")'
        : "voice capture unavailable in this browser";
      machine.failed(xrTime);
      return;
    }

    note = `committed via ${reason}`;
    void finishCapture(xrTime);
  },

  onCancel() {
    inFlight?.abort();
    inFlight = null;
    armedUtterance = null;
    // §7 — a cancelled utterance must not reach the network.
    capture.abort();
    turnLatency = null;
    note = "cancelled";
  },

  onStateChange(next) {
    wisps.setState(next);
    earcons.play(next);
  },
});

let inFlight: AbortController | null = null;
let toggle = false;
const pressCount: Record<HandSide, number> = { left: 0, right: 0 };

/**
 * Route a resolved utterance: local fast path first, model otherwise.
 *
 * plan.md §9 — "always attempt local first; escalate silently on low
 * confidence. The user must never learn there are two paths." Nothing here
 * announces which path ran; the only visible difference is that the local one
 * happens in a frame.
 */
function dispatchUtterance(u: ResolvedUtterance): void {
  if (tryLocalGround(u)) return;

  if (claudeAvailable) {
    void sendTurn(u);
  } else {
    note = `${note} · no model configured`;
    machine.done();
    endTurnTiming();
  }
}

/**
 * The ground fast path (§13 — local and instant, never a round trip).
 *
 * Returns true when it handled the utterance. The confidence bar lives in
 * matchGroundCommand and is set deliberately high: a missed match costs one
 * round trip, a wrong one repaints the world under the user's feet.
 */
function tryLocalGround(u: ResolvedUtterance): boolean {
  const style = matchGroundCommand(u.text);
  if (!style) return false;

  // Appended to the same log and the same undo stack as everything else (§9 —
  // do not build two).
  log.append({
    type: "environment_set",
    t: Date.now(),
    source: "local",
    utterance: u.text,
    environment: { groundMaterial: style, groundVisible: style !== "void" },
  });

  turnLatency?.setPath("local");
  turnLatency?.mark("scene_mutated");
  note = style === "void" ? "floor removed" : `floor → ${style}`;
  machine.done();
  endTurnTiming();
  return true;
}

/**
 * Open the microphone and start recording.
 *
 * Async, but the utterance anchor is taken from the moment the encoder actually
 * starts, so a slow first device-open costs leading audio rather than
 * misaligning every word time against the pose buffer.
 */
async function beginCapture(xrTime: number): Promise<void> {
  try {
    await capture.prepare();
    if (machine.state !== "LISTENING") {
      // Committed or cancelled while the device was opening.
      capture.abort();
      return;
    }
    capture.start(xrTime);
  } catch (err) {
    note = `mic unavailable: ${err instanceof Error ? err.message : String(err)}`;
    machine.failed(lastXrTime);
  }
}

/** Stop recording, upload, transcribe, resolve deixis, then hand to the model. */
async function finishCapture(endXrTime: number): Promise<void> {
  let result: Awaited<ReturnType<AudioCapture["stop"]>>;
  try {
    result = await capture.stop();
  } catch (err) {
    note = `capture failed: ${err instanceof Error ? err.message : String(err)}`;
    machine.failed(endXrTime);
    return;
  }

  if (!result) {
    note = "no audio captured — the mic may not have opened in time";
    machine.failed(endXrTime);
    return;
  }

  const controller = new AbortController();
  inFlight = controller;

  try {
    turnLatency?.mark("upload_start");
    const transcript = await transcribe(result.audio, controller.signal);
    if (controller.signal.aborted) return;
    turnLatency?.mark("transcript_ready");

    machine.transcriptReady();
    // plan.md §7 — show the transcript before the round trip. STT error is the
    // most frequent failure and the only one the user can diagnose instantly.
    transcriptLine = transcript.text;

    if (transcript.words.length === 0) {
      note = "heard nothing — say it again";
      machine.failed(lastXrTime);
      endTurnTiming();
      return;
    }

    const resolved = resolveUtterance(transcript, result.utteranceStartXrTime, resolveOptions());
    turnLatency?.mark("intent_resolved");
    lastResolved = resolved;
    note = summariseUtterance(resolved);

    dispatchUtterance(resolved);
  } catch (err) {
    if (controller.signal.aborted) return;
    note = err instanceof Error ? err.message : String(err);
    machine.failed(lastXrTime);
    turnLatency?.flush();
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}

/**
 * Turn an armed utterance into measurements through the real pipeline.
 *
 * The utterance is BACK-DATED by its declared duration. A mock that stamped
 * every word at "now" would exercise the plumbing and none of the temporal
 * binding — the hand would be wherever it currently is, which is exactly the
 * mistake §6 exists to prevent. Back-dating makes the word times index poses
 * the ring buffer genuinely recorded while the hand was moving.
 */
function completeUtterance(armed: ArmedUtterance, endXrTime: number): ResolvedUtterance {
  const startXrTime = Math.min(listenStartXrTime, endXrTime - armed.durationMs);
  const transcript = synthesizeTranscript(armed.text, {
    durationMs: endXrTime - startXrTime,
  });

  machine.transcriptReady();
  transcriptLine = transcript.text;

  const resolved = resolveUtterance(transcript, startXrTime, resolveOptions());
  lastResolved = resolved;
  note = summariseUtterance(resolved);

  // Same routing as a real utterance: local fast path first, model otherwise.
  dispatchUtterance(resolved);
  return resolved;
}

/**
 * M3 — utterance and measurements to the server, actions back, events appended.
 *
 * The model never sees an event and never mints an id: it returns actions, and
 * applyActions expands them here, next to the log that assigns identity.
 */
async function sendTurn(u: ResolvedUtterance): Promise<void> {
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;

  const scene = log.scene();
  const request = {
    sceneId: scene.id,
    utterance: u.text,
    viewer: { position: headPosition.toArray() as [number, number, number], yaw: headYaw() },
    measurements: u.measurements,
    eventsSinceLastTurn: [...log.sinceLastTurn()],
    scene,
    manifest: { capabilities: [] },
  };
  // Marked as sent, not as answered: a turn that fails still consumed the
  // context, and re-sending those events on the next turn would double-count.
  log.markSynced();

  let applied = 0;
  let firstDrop: string | null = null;

  try {
    const response = await streamTurn(
      request,
      (action) => {
        // Leaving touches no scene state, so it never reaches applyActions.
        if (action.action === "exit_session") {
          void exitSession();
          return;
        }

        // Committed the instant it arrives — this is the progressive part.
        // Re-folding the scene per action means a later action can reference an
        // object placed by an earlier one in the same turn.
        if (applied === 0) {
          machine.applying();
          // The moment the void first changes — the number §12 budgets at 2s.
          turnLatency?.mark("scene_mutated");
        }
        const { events, dropped } = applyActions([action], log.scene(), {
          t: Date.now(),
          utterance: u.text,
          newObjectId,
          newSceneId,
        });
        for (const event of events) {
          log.append(event);
          // Persistence is the side effect of the save event, performed once
          // the event is in the log so the saved history includes the save.
          if (event.type === "scene_saved") void persistScene(event.sceneId, event.name);
        }
        applied += events.length;
        firstDrop ??= dropped[0]?.reason ?? null;
        note = `${applied} object${applied === 1 ? "" : "s"}…`;
      },
      controller.signal,
    );
    if (controller.signal.aborted) return;

    lastSpeech = response.speech;
    // Speech is meant to be heard, not read — this is the debug stand-in until
    // TTS lands. §7's rule that audio leads still applies on device.
    note = firstDrop
      ? `“${response.speech}” · ${applied} applied, dropped (${firstDrop})`
      : `“${response.speech}” · ${applied} applied`;

    if (response.question) machine.needsInput();
    else machine.done();
    endTurnTiming();
  } catch (err) {
    if (controller.signal.aborted) return;
    note = err instanceof Error ? err.message : String(err);
    machine.failed(lastXrTime);
    endTurnTiming();
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}

const scratchEuler = new Euler();

/** Viewer yaw about world +Y, radians. 0 faces -Z, matching the prompt. */
function headYaw(): number {
  scratchEuler.setFromQuaternion(headQuaternion, "YXZ");
  return scratchEuler.y;
}

let objectCounter = 0;

function slugify(name: string, max: number): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, max) || "untitled"
  );
}

/**
 * Stable, readable, unique. Collision-checked against the live scene rather
 * than trusting a counter: a reloaded scene arrives with ids already in use,
 * and a fresh counter would happily mint a duplicate.
 */
function newObjectId(name: string): string {
  const base = slugify(name, 24);
  const taken = new Set(log.scene().objects.map((o) => o.id));
  for (;;) {
    const candidate = `${base}-${objectCounter++}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Storage id for a scene. Saving under a name already used overwrites it. */
function newSceneId(name: string): string {
  return slugify(name, 48);
}

/**
 * The save in flight, if any. "save and exit" arrives as two actions applied
 * back to back, so the exit has to wait for this or it would race the write
 * and could drop the scene it just promised to keep.
 */
let pendingSave: Promise<void> | null = null;

/** Write the whole event log to the server (§8 — the log is what persists). */
function persistScene(id: string, name: string): Promise<void> {
  pendingSave = (async () => {
    try {
      await saveScene(id, name, log.all());
      savedScenes = await listScenes();
      renderSceneList();
    } catch (err) {
      // The model has already said "saved" by now, so a silent failure would
      // be a lie. Surface it where the user can see it.
      note = `save failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  })();
  return pendingSave;
}

/**
 * End the session and return to the landing page.
 *
 * Waits on any save from the same turn first. The fetch itself would survive
 * leaving the session — nothing cancels it — but the list on the landing page
 * is rendered from the response, so exiting first would drop the user onto a
 * library that does not yet show what they just saved.
 */
async function exitSession(): Promise<void> {
  try {
    await pendingSave;
  } finally {
    pendingSave = null;
    runtime.exit();
  }
}

function resolveOptions(): ResolveOptions {
  return {
    buffer: poseBuffer,
    targets: registry.targets(),
    objectIdOf: registry.objectIdOf,
    preferredSide: machine.side,
  };
}

const headPosition = new Vector3();
const headQuaternion = new Quaternion();
const focus = new Vector3();
let fps = 0;
let elapsed = 0;
/** Live voice level while listening — shown on the HUD for threshold tuning. */
let micRms = 0;
let micGate = 0;

runtime.onFrame(({ xrTime, dt, frame, referenceSpace }) => {
  elapsed += dt;
  lastXrTime = xrTime;
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05;

  // Head pose straight from the frame — see DebugHud.update for why not camera.
  const viewer = frame && referenceSpace ? frame.getViewerPose(referenceSpace) : null;
  if (viewer) {
    const t = viewer.transform;
    headPosition.set(t.position.x, t.position.y, t.position.z);
    headQuaternion.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
  }

  hands.update(xrTime, headPosition);
  // After hands.update so the joint world matrices are current this frame.
  handModels.update();

  // Record every frame, unconditionally. A buffer with gaps in it is a buffer
  // that silently returns the wrong pose for exactly the moments that matter.
  const base = poseBuffer.record(xrTime, headPosition, headQuaternion);
  if (hands.left.tracked) {
    poseBuffer.recordHand(base, "left", hands.left.isHand, hands.left.tip, hands.left.tipQuaternion);
  }
  if (hands.right.tracked) {
    poseBuffer.recordHand(
      base,
      "right",
      hands.right.isHand,
      hands.right.tip,
      hands.right.tipQuaternion,
    );
  }

  // Hands latch (§7 — a held pinch would occupy the pointing hand); controller
  // triggers hold-to-talk, where that objection doesn't apply because the
  // controller is the pointer. A short trigger tap falls back to latching.
  if (hands.left.justPressed) {
    machine.press("left", xrTime, hands.left.isHand ? "latch" : "hold");
  }
  if (hands.right.justPressed) {
    machine.press("right", xrTime, hands.right.isHand ? "latch" : "hold");
  }
  if (hands.left.justReleased) machine.release("left", xrTime);
  if (hands.right.justReleased) machine.release("right", xrTime);

  // Voice activity feeds the 1.5s silence backstop (§7). Sampled only while
  // listening: the analyser is meaningless otherwise and the mic may be shut.
  if (machine.state === "LISTENING" && capture.recording) {
    const level = capture.sample();
    micRms = level.rms;
    micGate = level.gate;
    if (level.voice) machine.noteVoice(xrTime);
  } else if (machine.state !== "LISTENING") {
    micRms = 0;
  }

  machine.tick(xrTime);

  if (turnLatency) {
    // Runs before the flush so the presentation stamp lands in the sample.
    turnLatency.notePresented(xrTime);
    if (flushLatencyAfterFrame) {
      turnLatency.flush();
      turnLatency = null;
      flushLatencyAfterFrame = false;
    }
  }

  // The swarm converges on the active hand while listening and stays with the
  // user otherwise. Never on the HUD — that would train the user to look at it.
  const active = machine.side === "left" ? hands.left : hands.right;
  const listening = machine.state === "LISTENING" || machine.state === "TRANSCRIBING";
  focus.copy(listening && active.tracked ? active.tip : headPosition);
  if (!listening) focus.y = Math.max(0.6, focus.y - 0.4);
  wisps.setFocus(focus);
  wisps.update(dt, elapsed);

  hud.update(headPosition, headQuaternion, hudData(), xrTime);
});

function hudData(): HudData {
  const span = poseBuffer.newestTime - poseBuffer.oldestTime;
  return {
    state: machine.state,
    leftTracked: hands.left.tracked,
    rightTracked: hands.right.tracked,
    leftIsHand: hands.left.isHand,
    rightIsHand: hands.right.isHand,
    leftPinches: pressCount.left,
    rightPinches: pressCount.right,
    leftPinchDistance: hands.left.pinchDistance,
    rightPinchDistance: hands.right.pinchDistance,
    toggle,
    fps,
    bufferSeconds: span / 1000,
    micRms,
    micGate,
    transcript: transcriptLine,
    note,
  };
}

/* ------------------------------------------------------- scene library --- */

let savedScenes: SavedSceneSummary[] = [];

/**
 * The landing page doubles as the scene library. Authoring happens only in VR
 * (§10) — this lists what exists and opens it, and does nothing else.
 */
function renderSceneList(): void {
  scenesEl.hidden = savedScenes.length === 0;
  sceneListEl.replaceChildren();

  for (const scene of savedScenes) {
    const item = document.createElement("li");
    const open = document.createElement("button");
    open.className = "scene";
    // textContent, not innerHTML: scene names are model-authored text and this
    // is the one place they reach the DOM.
    const title = document.createElement("span");
    title.className = "scene-name";
    title.textContent = scene.name;
    const meta = document.createElement("span");
    meta.className = "scene-meta";
    meta.textContent = `${scene.objectCount} object${scene.objectCount === 1 ? "" : "s"} · ${relativeTime(scene.savedAt)}`;

    open.append(title, meta);
    open.addEventListener("click", () => {
      void enterWithScene(scene);
    });
    item.append(open);
    sceneListEl.append(item);
  }
}

function relativeTime(at: number): string {
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

async function refreshSceneList(): Promise<void> {
  try {
    savedScenes = await listScenes();
    renderSceneList();
  } catch {
    // Server down: the library simply isn't offered. M0 runs standalone.
    scenesEl.hidden = true;
  }
}

/** Replay a saved scene, then enter. The log is loaded before the session so
 * the void is never briefly empty in front of the user. */
async function enterWithScene(scene: SavedSceneSummary): Promise<void> {
  statusEl.textContent = `loading “${scene.name}”…`;
  try {
    const saved = await loadScene(scene.id);
    log.load(saved.events);
    objectCounter = 0;
    await enterXR();
  } catch (err) {
    statusEl.textContent = `could not load: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function enterXR(): Promise<void> {
  // The XR entry click is the only reliable user gesture we get, so the audio
  // context is unlocked here or never.
  const ctx = earcons.unlock();
  clock.align(ctx);
  try {
    await runtime.enter();
  } catch (err) {
    statusEl.textContent = `session failed: ${String(err)}`;
  }
}

async function boot(): Promise<void> {
  const supported = await isSupported();
  if (!supported) {
    button.textContent = "WebXR unavailable";
    statusEl.textContent =
      "Open this page in the Quest Browser over localhost (adb reverse tcp:5173 tcp:5173).";
    return;
  }

  button.disabled = false;
  button.textContent = "Enter the void";

  void health()
    .then((h) => {
      claudeAvailable = h.claude;
      const stt = h.sttProvider === "mock" ? "mock" : h.stt ? "ready" : "not configured";
      statusEl.textContent = h.ok
        ? `server up · stt ${stt} · claude ${h.claude ? "ready" : "not configured"}`
        : "server unreachable — M0 runs standalone";
      if (h.ok) void refreshSceneList();
    })
    .catch(() => {
      statusEl.textContent = "server unreachable — M0 runs standalone";
    });

  button.addEventListener("click", () => {
    void enterXR();
  });

  runtime.onSessionChange((present) => {
    overlay.style.display = present ? "none" : "";
    // Release the device on exit so the headset's recording indicator goes out
    // with the session rather than lingering on the flat page.
    if (!present) capture.release();
  });

  log.append({
    type: "scene_created",
    sceneId: "session",
    name: "Untitled",
    t: Date.now(),
    source: "system",
  });

  // Dev-only. Constant-folded away in production builds, so the bridge and its
  // module never reach a shipped bundle.
  if (import.meta.env.DEV) {
    void import("./debug/bridge.js").then(({ installDebugBridge }) => {
      installDebugBridge({
        now: () => lastXrTime,
        machine,
        buffer: poseBuffer,
        resolveOptions,
        snapshot: hudData,
        scene: () => log.scene(),
        events: () => log.all(),
        arm: (text, durationMs) => {
          armedUtterance = { text, durationMs };
        },
        disarm: () => {
          armedUtterance = null;
        },
        lastUtterance: () => lastResolved,
        lastSpeech: () => lastSpeech,
        presenting: () => runtime.isPresenting(),
        // Opens the mic if it isn't already, so the gate can be tuned without
        // having to hold a pinch through the whole measurement.
        voice: () => {
          if (!capture.ready) void capture.prepare();
          return capture.sample();
        },
        setHandsVisible: (v) => {
          handModels.visible = v;
        },
        handsVisible: () => handModels.visible,
      });
    });
  }
}

void boot();
