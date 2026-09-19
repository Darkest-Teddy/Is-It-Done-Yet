import { allLines, type Bark } from '../core/barks.js';

/**
 * Says the line.
 *
 * Three tiers, in this order, and the order is the whole design:
 *
 *   1. A pre-generated ElevenLabs bank, decoded to AudioBuffers at load and played instantly.
 *   2. The browser's own speech synthesiser.
 *   3. Silence, with the line still on screen.
 *
 * Master spec rule #9 -- every network call gets a timeout and a fallback -- and rule #12,
 * which says to pick whatever survives a live demo on bad wifi. Venue wifi at a 1500-person
 * event is saturated, so the voice has to degrade rather than hang. `speechSynthesis` is the
 * tier that makes that true: it is already in the browser, needs no key, no network and no
 * load time, and it will still be talking when nothing else is.
 *
 * Generation happens once at load rather than per cut, for the reason master spec 9.3 gives:
 * a round trip after every slice puts the chef a second behind the knife, and a late reaction
 * reads as the game being broken.
 */

export interface ChefOptions {
  /** Nothing is requested without one, and the browser voice is used instead. */
  readonly apiKey?: string;
  readonly voiceId?: string;
  /** Per-request ceiling. A slow bank is abandoned, not waited for. */
  readonly timeoutMs?: number;
}

export interface Chef {
  say(bark: Bark): void;
  /** Resolves once the bank is ready or has been given up on. Never rejects. */
  readonly ready: Promise<void>;
  /** Which tier is actually speaking, for the status line and for the README to be honest. */
  readonly tier: () => 'elevenlabs' | 'browser' | 'silent';
}

const ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech';

/** Rejects on timeout instead of hanging, so a stalled fetch cannot pin the bank forever. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const bell = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  try {
    return await Promise.race([work, bell]);
  } finally {
    clearTimeout(timer!);
  }
}

export function createChef(ctx: AudioContext | null, options: ChefOptions = {}): Chef {
  const bank = new Map<string, AudioBuffer>();
  let usedBrowserVoice = false;

  const speakInBrowser = (line: string): boolean => {
    try {
      if (typeof speechSynthesis === 'undefined') return false;
      // Cancel first: barks arrive faster than they are spoken, and a queue means the chef is
      // still working through slice three while the player is on slice six.
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(line);
      utterance.rate = 1.15;
      utterance.pitch = 0.85;
      speechSynthesis.speak(utterance);
      usedBrowserVoice = true;
      return true;
    } catch {
      return false;
    }
  };

  const generate = async (): Promise<void> => {
    const { apiKey, voiceId, timeoutMs = 4000 } = options;
    if (apiKey === undefined || voiceId === undefined || ctx === null) return;

    // Sequential on purpose. Firing thirty requests at once on saturated wifi is how you get
    // thirty timeouts instead of the first ten succeeding, and the early lines are the ones
    // needed first.
    for (const line of allLines()) {
      try {
        const response = await withTimeout(fetch(`${ENDPOINT}/${voiceId}`, {
          method: 'POST',
          headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: line, model_id: 'eleven_turbo_v2_5' }),
        }), timeoutMs);
        if (!response.ok) return;
        bank.set(line, await ctx.decodeAudioData(await response.arrayBuffer()));
      } catch {
        // One failure means the network is not going to cooperate. Stop asking and let the
        // browser voice carry the session rather than stalling load behind thirty timeouts.
        return;
      }
    }
  };

  const ready = generate().catch(() => undefined);

  return {
    ready,
    tier: () => (bank.size > 0 ? 'elevenlabs' : usedBrowserVoice ? 'browser' : 'silent'),

    say(bark: Bark) {
      const cached = bank.get(bark.line);
      if (cached !== undefined && ctx !== null) {
        try {
          const source = ctx.createBufferSource();
          source.buffer = cached;
          source.connect(ctx.destination);
          source.start();
          return;
        } catch { /* fall through to the browser voice */ }
      }
      speakInBrowser(bark.line);
    },
  };
}
