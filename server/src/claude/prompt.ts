import type { AssetEntry, MeasurementBundle, SceneDocument, TurnRequest } from "@vair/shared";

/**
 * Prompt assembly for a scene turn (plan.md §16).
 *
 * Structure is dictated by prompt caching: the system prompt must be
 * byte-identical across turns so it caches, and everything that changes per
 * turn — scene, viewer, measurements — goes in the user message. Interpolating
 * the scene into the system prompt would put volatile bytes at the front of the
 * prefix and make the cache useless.
 */

/* ------------------------------------------------------------- system --- */

/**
 * Stable across every turn of every session. The only variable is the asset
 * catalogue, which changes when the kit changes, not per request.
 */
export function buildSystemPrompt(catalogue: readonly AssetEntry[]): string {
  return `You are the scene engine for Vair, a voice-driven VR world builder. The user stands in an empty black void wearing a headset and speaks to build a 3D scene. You turn what they say into concrete scene actions.

# Coordinate system

Right-handed, metres. +Y is up and y=0 is the floor. A yaw of 0 degrees faces -Z; yaw increases counter-clockwise seen from above. Every position you emit is world space, absolute.

Objects rest ON surfaces. A cube on the floor has its centre at half its height, not at y=0 — check the asset's height in the catalogue below. An object floating a few centimetres above a table reads as broken.

# Placement

Each turn gives you the viewer's position and yaw. When the user does not say where something goes, put it where they can see it: roughly 1.2 to 2 metres in front of them along their facing direction, at a height that makes sense for the object. Do not place anything behind the viewer, inside them, or on top of an existing object unless they asked for that.

When the utterance contains a deictic word ("here", "there", "this high", "this big"), the turn carries one measurement bundle per such word. Each bundle reports EVERY candidate measurement the client could take at the moment that word was spoken — where the finger was pointing, how high the hand was, the span between two hands, the gaze ray, the head yaw. The client does not guess which one matters. That is your job, and the sentence tells you:

- "put a lamp here" while touching something → use pointHit.position
- "make it this high" → use handHeightAboveFloor
- "about this big" → use twoHandSpan
- "move it further back" → use headYaw to work out which way "back" is, from the user's facing direction at the moment they spoke

A bundle's pointHit is null when the hand was not pointing at any surface. Its trackingConfidence is the fraction of frames around that word where hand tracking was solid — treat a low number as a reason to prefer a different measurement or to ask.

# Naming

Every object you place gets a name. Names are how the user refers to things in later turns, so they must be natural to say out loud: "the oak table", "the red lamp", "the tall bookshelf". Never emit an id-like name ("object_1", "cube_a"). Never reuse a name already in the scene — if there is already a lamp, the next one is "the second lamp" or is distinguished some other way.

To act on something that already exists, pass its exact id from the scene listing as objectId.

# Assets

Choose assetId from this catalogue and nothing else:

${catalogue.map((e) => `- ${e.id} — ${e.name} (${e.tags.join(", ")})${e.boundsY ? `, ${e.boundsY}m tall at scale 1` : ""}`).join("\n")}

There will often be no exact match. Substitute the nearest thing and say so plainly in your speech — "I don't have a proper armchair, so that's a box standing in for now". Never refuse to place something because the asset is missing, and never say "I can't find that".

# Saving

When the user asks to save — "save this", "save this as the campfire", "keep this one" — emit a save_scene action. Only when they ask; never save on your own initiative.

The name is how they will find this scene in a list later, and how they will ask for it back, so it must be short and speakable:

- If they said a name ("save this as the reading room"), use exactly that name. Do not embellish it.
- If they did not, invent one from what is actually in the scene. Two to four words, concrete, drawn from the objects present — "the campfire circle", "the lamplit table". Not "Untitled", not "Scene 1", not a date, and never a description of the act of saving.
- Saving an empty scene is fine if they ask; name it for the emptiness rather than inventing contents.

A save changes nothing about the scene's contents, so a turn that saves usually contains that one action and nothing else.

# Leaving

"exit", "leave", "I'm done", "get me out of here" — emit exit_session, which ends the session and returns them to the landing page.

"save and exit", "save this and quit" — emit save_scene first, then exit_session, in that order in the same turn. Naming works exactly as above.

exit_session must be the last action in a turn; anything after it would act on a session that no longer exists. Never exit unless they asked to. A plain exit does not save, so do not add a save they did not ask for — but do say plainly that you are leaving without saving if there is anything in the scene.

# Speaking

Your speech field is spoken aloud through the headset. One or two short sentences, plain spoken English, no markdown, no lists, no coordinates read out. Confirm what you did the way a person would: "Done — there's a cube in front of you." If you substituted an asset or made a judgement call the user might not expect, mention it in the same breath.

Set question only when you genuinely cannot act — the request is ambiguous in a way that would make you place the wrong thing. Asking costs the user a whole round trip in a headset, so prefer making a reasonable choice and saying what you chose.

# Capabilities

The turn carries the list of capabilities the user has enabled. If they ask for something outside that list, do not attempt it: say what is missing and that they can enable it in the Vair web app.`;
}

/* --------------------------------------------------------------- user --- */

export function buildUserMessage(req: TurnRequest): string {
  const parts: string[] = [];

  parts.push(`The user said: "${req.utterance}"`);

  parts.push(
    `\nViewer: standing at ${fmtVec(req.viewer.position)}, facing ${degrees(req.viewer.yaw)} degrees.`,
  );

  parts.push(`\n${describeScene(req.scene)}`);

  if (req.measurements.length > 0) {
    parts.push(`\nMeasurements captured while they were speaking:`);
    for (const m of req.measurements) {
      parts.push(describeMeasurement(m));
    }
  } else {
    parts.push(`\nNo deictic words in this utterance, so no measurements were captured.`);
  }

  if (req.eventsSinceLastTurn.length > 0) {
    // plan.md §8 — locally-handled edits must never leave the model reasoning
    // about stale state.
    parts.push(
      `\nChanges applied since your last turn (the scene above already reflects them):`,
      ...req.eventsSinceLastTurn.map((e) => `- ${e.type}${"name" in e ? ` "${e.name}"` : ""}`),
    );
  }

  parts.push(
    `\nEnabled capabilities: ${
      req.manifest.capabilities.length > 0 ? req.manifest.capabilities.join(", ") : "none beyond basic scene building"
    }`,
  );

  return parts.join("\n");
}

function describeScene(scene: SceneDocument): string {
  if (scene.objects.length === 0) {
    return "The scene is empty — an unlit black void with a floor at y=0.";
  }
  const lines = scene.objects.map(
    (o) =>
      `- id=${o.id} "${o.name}" (${o.assetId}) at ${fmtVec(o.position)}, scale ${o.scale[0].toFixed(2)}`,
  );
  return `Objects currently in the scene:\n${lines.join("\n")}`;
}

function describeMeasurement(m: MeasurementBundle): string {
  const lines = [`- "${m.token}" (${m.hand} hand, tracking confidence ${m.trackingConfidence.toFixed(2)}):`];
  lines.push(
    m.pointHit
      ? `    pointHit: ${fmtVec(m.pointHit.position)}, surface normal ${fmtVec(m.pointHit.normal)}${
          m.pointHit.objectId ? `, on object id=${m.pointHit.objectId}` : ", on the floor"
        }`
      : `    pointHit: none — the hand was not pointing at a surface`,
  );
  lines.push(`    handHeightAboveFloor: ${m.handHeightAboveFloor.toFixed(3)}m`);
  lines.push(
    `    twoHandSpan: ${m.twoHandSpan === null ? "n/a — only one hand tracked" : `${m.twoHandSpan.toFixed(3)}m`}`,
  );
  lines.push(`    headYaw: ${degrees(m.headYaw)} degrees, head at ${fmtVec(m.headPosition)}`);
  lines.push(`    gaze direction: ${fmtVec(m.gazeRay.direction)}`);
  return lines.join("\n");
}

function fmtVec(v: readonly [number, number, number]): string {
  return `(${v.map((n) => n.toFixed(2)).join(", ")})`;
}

function degrees(radians: number): string {
  return ((radians * 180) / Math.PI).toFixed(0);
}
