/**
 * plan.md §6.2 — persist the offset between AudioContext.currentTime and XRFrame
 * time at capture start. You will need it, and it drifts.
 *
 * XRFrame time (the `time` argument to setAnimationLoop) is a DOMHighResTimeStamp
 * in the same domain as performance.now(). AudioContext.currentTime is seconds
 * since the context started, in a *different* domain, resampled by the audio
 * hardware clock. The two diverge by milliseconds over a minute — enough to bind
 * a deictic word to the wrong hand position.
 */

export type ClockAlignment = {
  /** performance.now() ms at the moment of alignment. */
  xrTime: number;
  /** AudioContext.currentTime seconds at the same moment. */
  audioTime: number;
};

export class Clock {
  private alignment: ClockAlignment | null = null;

  /**
   * Call at capture start, and re-call for every utterance. Realigning per
   * utterance costs nothing and removes drift as a class of bug.
   */
  align(ctx: AudioContext): ClockAlignment {
    // `getOutputTimestamp` gives a genuinely paired reading of the two clocks.
    // Where it is unavailable (older WebViews) the naive pairing is off by one
    // render quantum — ~2.7ms at 48kHz, which is inside our error budget.
    const ts = ctx.getOutputTimestamp?.();
    const alignment: ClockAlignment =
      ts && ts.contextTime !== undefined && ts.performanceTime !== undefined
        ? { xrTime: ts.performanceTime, audioTime: ts.contextTime }
        : { xrTime: performance.now(), audioTime: ctx.currentTime };

    this.alignment = alignment;
    return alignment;
  }

  get current(): ClockAlignment | null {
    return this.alignment;
  }

  /**
   * Convert a word timestamp (seconds from utterance start, as returned by STT)
   * into XR frame time so it can index the pose ring buffer.
   */
  wordTimeToXrTime(secondsFromUtteranceStart: number, utteranceStartXrTime: number): number {
    return utteranceStartXrTime + secondsFromUtteranceStart * 1000;
  }

  /** Convert an absolute AudioContext time to XR frame time. */
  audioToXr(audioTime: number): number {
    if (!this.alignment) return performance.now();
    return this.alignment.xrTime + (audioTime - this.alignment.audioTime) * 1000;
  }
}

export const clock = new Clock();
