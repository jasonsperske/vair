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
import { DebugHud, type HudData } from "./debug/hud.js";
import { earcons } from "./audio/earcons.js";
import { health, streamTurn } from "./net/api.js";
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

const runtime = createRuntime();
const hands = new HandInput(runtime.renderer);
const wisps = new WispField();
const hud = new DebugHud();
const log = new EventLogStore();
const registry = new ObjectRegistry(runtime.root);
// Projects the event log onto the scene graph. Nothing else adds meshes.
new SceneView(registry, log);

runtime.root.add(wisps.points);
runtime.root.add(hud.mesh);
// Just enough light that placed primitives are not silhouettes. The void stays
// a void — no environment map, no sky (plan.md §2).
runtime.root.add(new HemisphereLight(0x4a5f9e, 0x080a12, 0.6));

/**
 * M1 has not been built: there is no microphone capture and no upload. Flip
 * this when it is. Until then the only way into the transcript path is an armed
 * mock utterance from the debug bridge.
 */
const CAPTURE_AVAILABLE = false;

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

    const ctx = earcons.context;
    if (ctx) clock.align(ctx);
  },

  onListenStop(reason, xrTime) {
    hands.pulse(machine.side, 0.3, 20);

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
        ? 'no capture yet (M1) — try window.vair.say("put a cube here")'
        : "voice capture not built yet (M1)";
      machine.failed(xrTime);
      return;
    }
    note = `committed via ${reason}`;
  },

  onCancel() {
    inFlight?.abort();
    inFlight = null;
    armedUtterance = null;
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

  if (claudeAvailable) {
    // Stays in THINKING until the turn resolves. Deliberately not awaited: the
    // frame loop must keep running while the request is in flight.
    void sendTurn(resolved);
  } else {
    // Return to IDLE rather than pretending a turn happened — a fake THINKING
    // state would make the latency numbers meaningless.
    note = `${note} · no model configured`;
    machine.done();
  }
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
        // Committed the instant it arrives — this is the progressive part.
        // Re-folding the scene per action means a later action can reference an
        // object placed by an earlier one in the same turn.
        if (applied === 0) machine.applying();
        const { events, dropped } = applyActions([action], log.scene(), {
          t: Date.now(),
          utterance: u.text,
          newObjectId,
        });
        for (const event of events) log.append(event);
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
  } catch (err) {
    if (controller.signal.aborted) return;
    note = err instanceof Error ? err.message : String(err);
    machine.failed(lastXrTime);
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

/** Stable, readable, and unique within the session. */
function newObjectId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  return `${slug || "object"}-${objectCounter++}`;
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

  if (hands.left.justPressed) machine.press("left", xrTime);
  if (hands.right.justPressed) machine.press("right", xrTime);
  machine.tick(xrTime);

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
    transcript: transcriptLine,
    note,
  };
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
    })
    .catch(() => {
      statusEl.textContent = "server unreachable — M0 runs standalone";
    });

  button.addEventListener("click", () => {
    // The XR entry click is the only reliable user gesture we get, so the audio
    // context is unlocked here or never.
    const ctx = earcons.unlock();
    clock.align(ctx);
    void runtime.enter().catch((err: unknown) => {
      statusEl.textContent = `session failed: ${String(err)}`;
    });
  });

  runtime.onSessionChange((present) => {
    overlay.style.display = present ? "none" : "";
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
      });
    });
  }
}

void boot();
