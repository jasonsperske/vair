import type { InteractionState } from "../input/state-machine.js";

/**
 * plan.md §7 — haptics and audio lead.
 *
 * During "place the lamp here" the user is looking at the table, not at an
 * indicator. Visual state outside the FOV is no state at all, so every
 * transition that matters gets a distinct earcon.
 *
 * Plain WebAudio on purpose. Tone.js arrives in M5 for generative ambient; a
 * 40ms confirmation tone does not need a scheduler.
 */

type Earcon = { freq: number; toFreq?: number; ms: number; gain: number; type: OscillatorType };

const EARCONS: Partial<Record<InteractionState, Earcon>> = {
  LISTENING: { freq: 660, toFreq: 880, ms: 90, gain: 0.12, type: "sine" },
  TRANSCRIBING: { freq: 880, toFreq: 660, ms: 80, gain: 0.1, type: "sine" },
  NEEDS_INPUT: { freq: 520, toFreq: 620, ms: 160, gain: 0.12, type: "triangle" },
  FAILED: { freq: 300, toFreq: 190, ms: 220, gain: 0.14, type: "sawtooth" },
};

export class Earcons {
  private ctx: AudioContext | null = null;

  /**
   * Must be called from a user gesture. The XR session entry click is the only
   * reliable one we get, so it happens there.
   */
  unlock(): AudioContext {
    this.ctx ??= new AudioContext({ latencyHint: "interactive" });
    void this.ctx.resume();
    return this.ctx;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  play(state: InteractionState): void {
    const spec = EARCONS[state];
    if (!spec || !this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const seconds = spec.ms / 1000;

    osc.type = spec.type;
    osc.frequency.setValueAtTime(spec.freq, now);
    if (spec.toFreq) osc.frequency.exponentialRampToValueAtTime(spec.toFreq, now + seconds);

    // Ramped, never gated: a square-edged envelope clicks, and a click in the
    // headset reads as a bug even when nothing is wrong.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(spec.gain, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);

    osc.connect(gain).connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + seconds + 0.02);
  }
}

export const earcons = new Earcons();
