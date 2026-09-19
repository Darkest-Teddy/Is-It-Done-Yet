import type { CutFeedback } from '../core/feedback.js';

/**
 * The chop sound, synthesised.
 *
 * Master spec 7.2 scales the cut's feedback by its size and 12 maps chop pitch to accuracy.
 * Both come from one `CutFeedback`, which is the point of that type existing: the two channels
 * cannot be tuned apart into disagreeing with each other.
 *
 * Synthesised rather than sampled, and that is a reliability decision before it is an aesthetic
 * one. There is no file to fetch, so it cannot fail on venue wifi, cannot be missing from a
 * build, and adds nothing to load time. It also means pitch is continuous: a sample would have
 * to be pitch-shifted in fixed steps, and the whole idea is that the player hears the
 * difference between a 5mm and a 6mm slice.
 *
 * A short burst of filtered noise is what a knife through a cucumber actually is -- broadband,
 * fast decay, a formant somewhere in the middle. It does not need to be more than that.
 */

export interface ChopOptions {
  /** Pitch at zero accuracy. The bottom of the range the player learns to listen for. */
  readonly baseHz: number;
  /** How far the pitch climbs across the full accuracy range. */
  readonly pitchRangeHz: number;
  readonly burstMs: number;
  /** Resonance of the band-pass. Higher is more pitched, lower is more of a thud. */
  readonly bandpassQ: number;
}

export interface Chop {
  play(feedback: CutFeedback): void;
  /** Browsers start an AudioContext suspended until a gesture. Call this from a click. */
  resume(): Promise<void>;
  readonly state: AudioContextState;
  /** Shared with the chef, so one unblocking gesture serves both voices. */
  readonly context: AudioContext;
}

/**
 * One noise buffer, made once and reused.
 *
 * Half a second of white noise is 22k floats. Generating it per cut would be an audible hitch
 * on the frame the player most wants to feel responsive.
 */
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  const frames = Math.floor(ctx.sampleRate * 0.5);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) channel[i] = Math.random() * 2 - 1;
  return buffer;
}

/**
 * Returns null when the browser has no Web Audio at all, rather than throwing.
 *
 * Audio is garnish on a measurement tool. Nothing here is allowed to take the page down.
 */
export function createChop(options: () => ChopOptions): Chop | null {
  const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : undefined;
  if (Ctor === undefined) return null;

  let ctx: AudioContext;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }

  const noise = noiseBuffer(ctx);

  return {
    context: ctx,
    get state() { return ctx.state; },

    async resume() {
      try {
        if (ctx.state === 'suspended') await ctx.resume();
      } catch { /* a refused resume is not worth reporting to the player */ }
    },

    play(feedback: CutFeedback) {
      try {
        const o = options();
        const now = ctx.currentTime;
        const seconds = Math.max(0.01, o.burstMs / 1000);

        const source = ctx.createBufferSource();
        source.buffer = noise;
        source.loop = true;

        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = o.baseHz + o.pitchRangeHz * feedback.accuracy;
        filter.Q.value = o.bandpassQ;

        const gain = ctx.createGain();
        // A thicker slice is a bigger cut and a louder one. An uncertain reading is quieter --
        // the feedback still happens, because silence would read as "no cut detected" and send
        // the player hunting for a problem that is not there, but it does not assert itself.
        const peak = (0.05 + 0.35 * feedback.intensity) * (feedback.kind === 'uncertain' ? 0.4 : 1);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(peak, now + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);

        source.connect(filter).connect(gain).connect(ctx.destination);
        source.start(now);
        source.stop(now + seconds + 0.02);
      } catch { /* one missed chop must never interrupt the measurement loop */ }
    },
  };
}
