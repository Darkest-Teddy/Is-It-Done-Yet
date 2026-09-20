import { allLines, type Bark } from '../core/barks.js';
import {
  afterFailure,
  afterSuccess,
  chooseTier,
  fallbackTier,
  FRESH_RELAY,
  remember,
  speechKey,
  type RelayHealth,
  type SpeechCapabilities,
  type SpeechTier,
} from '../core/voice/speech.js';

/**
 * Says the line.
 *
 * Four tiers, in this order, and the order is the whole design:
 *
 *   1. A pre-generated ElevenLabs bank, decoded to AudioBuffers at load and played instantly.
 *   2. An on-demand ElevenLabs clip for text nobody wrote in advance, cached after the first.
 *   3. The browser's own speech synthesiser.
 *   4. Silence, with the line still on screen.
 *
 * Master spec rule #9 -- every network call gets a timeout and a fallback -- and rule #12,
 * which says to pick whatever survives a live demo on bad wifi. Venue wifi at a 1500-person
 * event is saturated, so the voice has to degrade rather than hang.
 *
 * TIER 1 IS FOR BARKS AND TIER 2 IS FOR ANSWERS, and that split is the point of having both.
 * Generation happens once at load rather than per cut, for the reason master spec 9.3 gives: a
 * round trip after every slice puts the chef a second behind the knife, and a late reaction
 * reads as the game being broken. But the bank is keyed by exact line text, so it can only ever
 * speak sentences written in advance -- and the in-cooking chef answers in text Qwen3 phrased a
 * moment ago. Every one of those missed the Map.
 *
 * WHY THAT WAS SILENT RATHER THAN MERELY WORSE. Tier 3 catches a Map miss on a laptop, which is
 * why this went unnoticed for as long as it did. DECISIONS.md entry 19 measured Quest Browser:
 * `speechSynthesis` is *absent* there, not unreliable, so the headset falls from tier 1 straight
 * to tier 4 and every model-written answer was a subtitle. Tier 2 exists for that device.
 *
 * BOTH TIERS NOW GO THROUGH THE RELAY. This changed in DECISIONS.md entry 34 and the reason is
 * a measurement rather than a preference. `.env.example` has always warned that a `VITE_`-
 * prefixed key is inlined into the client bundle and readable by anyone who opens the page,
 * and this repo publishes a built app; entry 28 nevertheless left the bank on a browser key on
 * the argument that it runs once, at load, on a booth laptop we own. Entry 32 then measured
 * what that actually meant: `VITE_ELEVENLABS_KEY` and `VITE_ELEVENLABS_VOICE` do not exist in
 * `.env` at all, so the bank was unconfigured everywhere, and the menu app never passed them
 * in the first place -- so tier 1 had never once fired outside a test. Generating the bank
 * through `server/speech.mjs` costs one extra hop at load and makes the pre-generated tier
 * real on the headset, where it is the only tier that arrives with the cut.
 *
 * The browser-key path is still accepted, because a laptop at a booth with no server running
 * is a real situation and it is thirty lines to keep. It is the fallback, not the default, and
 * nothing in this repo configures it.
 */

export type AudioSource = AudioContext | null | (() => AudioContext | null);

export interface ChefOptions {
  /** Tier 1 only. Nothing is pre-generated without one; the other three tiers are unaffected. */
  readonly apiKey?: string;
  readonly voiceId?: string;
  /** Per-request ceiling for the bank. A slow bank is abandoned, not waited for. */
  readonly timeoutMs?: number;
  /**
   * Tier 2: where `server/speech.mjs` is mounted. Undefined or empty disables the tier
   * entirely, which is the state of a checkout with nothing configured and is not an error.
   */
  readonly speechRelay?: string;
  /** Per-request ceiling for one on-demand line. Shorter than the bank's -- see below. */
  readonly speechTimeoutMs?: number;
  /**
   * Generate the whole bark bank through the relay at load. Tier 1, without a browser key.
   *
   * OFF BY DEFAULT, and the default is the interesting half. A relay-configured chef that
   * pre-generated on its own would fire thirty-two requests the moment the page mounted, and
   * would have to build an `AudioContext` to decode them into -- both of which entry 28
   * deliberately avoided, and both of which it verified by counting requests rather than by
   * assuming. The menu app therefore keeps its on-demand-only posture and nothing about it
   * changes; `main.ts`, the laptop app that reacts to every cut, asks for the bank explicitly.
   */
  readonly preloadBank?: boolean;
}

export interface Chef {
  say(bark: Bark): void;
  /** Synthesises a line ahead of time without speaking it. See `prime`'s own note. */
  prime(line: string): void;
  /** Resolves once the bank is ready or has been given up on. Never rejects. */
  readonly ready: Promise<void>;
  /** Which tier is actually speaking, for the status line and for the README to be honest. */
  readonly tier: () => 'elevenlabs' | 'browser' | 'silent';
  /** What spoke the most recent line, or null if nothing has been said. For diagnosis. */
  readonly lastTier: () => SpeechTier | null;
}

const ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech';

/** Where `server/speech.mjs` is mounted, in both the dev server and the static server. */
export const DEFAULT_SPEECH_RELAY_PATH = '/api/speech';

/**
 * Ceiling on one on-demand line, and shorter than the bank's on purpose.
 *
 * The bank is a load-time batch nobody is waiting on. This is a person who has asked a question
 * and has already heard "Let me look" -- `openingMove` in `core/voice/guidance.ts` says that
 * line from the instant the button is pressed precisely so this wait is covered. Four seconds
 * is about as long as that cover lasts before the silence after it reads as a crash. TUNED.
 */
export const DEFAULT_SPEECH_TIMEOUT_MS = 4000;

/**
 * Reads the tier-2 relay path out of the environment, or null.
 *
 * OPT-IN, matching `configFromEnv` in `src/ai/qwen.ts`. Defaulting it on would mean a checkout
 * with nothing configured POSTs to a route that is not mounted before falling back, and "with
 * no key everything behaves exactly as it did" is the property this tier must not break.
 */
export function speechRelayFromEnv(
  env: Record<string, string | undefined> = import.meta.env as unknown as Record<
    string,
    string | undefined
  >,
): string | null {
  const relay = env['VITE_SPEECH_RELAY'];
  return relay === undefined || relay === '' ? null : relay;
}

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

export function createChef(audio: AudioSource, options: ChefOptions = {}): Chef {
  const bank = new Map<string, AudioBuffer>();
  /** Tier 2's clips, keyed by `speechKey` rather than by raw text. See `core/voice/speech.ts`. */
  const clips = new Map<string, AudioBuffer>();
  /** One request per line, however many callers want it. `prime` and `say` routinely race. */
  const inFlight = new Map<string, Promise<AudioBuffer | null>>();

  const relayPath = options.speechRelay === '' ? undefined : options.speechRelay;
  const relayTimeoutMs = options.speechTimeoutMs ?? DEFAULT_SPEECH_TIMEOUT_MS;
  let health: RelayHealth = FRESH_RELAY;

  let usedBrowserVoice = false;
  let spoken: SpeechTier | null = null;

  /**
   * The AudioContext, resolved at most once and possibly late.
   *
   * A factory is accepted as well as an instance because a context constructed before the first
   * user gesture is born suspended, and a chef built at page load would be exactly that. The
   * guidance panel passes a factory so the context is created on the click that asks for an
   * answer; `main.ts` passes the one the chop synthesiser already owns.
   */
  let context: AudioContext | null = null;
  let resolved = false;
  const ctxOf = (): AudioContext | null => {
    if (!resolved) {
      resolved = true;
      try {
        context = typeof audio === 'function' ? audio() : audio;
      } catch {
        context = null;
      }
    }
    return context;
  };

  /**
   * The clip currently playing, so the next line can cut it off.
   *
   * Tier 3 has always done this -- `speechSynthesis.cancel()` below -- because barks arrive
   * faster than they are spoken. Tiers 1 and 2 need it for a sharper reason: the guidance panel
   * says "Let me look" and then replaces it with the real answer a second or two later, and
   * without this the two overlap and the chef talks over itself.
   */
  let playing: AudioBufferSourceNode | null = null;

  const playClip = (buffer: AudioBuffer | undefined): boolean => {
    const ctx = ctxOf();
    if (buffer === undefined || ctx === null) return false;
    try {
      // Suspended is the normal state until a gesture. Resuming is async and is not waited on:
      // `start()` on a suspended context queues rather than fails.
      if (ctx.state === 'suspended') void ctx.resume();
      try {
        playing?.stop();
      } catch { /* already finished; stopping a stopped node throws and means nothing */ }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => {
        if (playing === source) playing = null;
      };
      source.start();
      playing = source;
      return true;
    } catch {
      return false;
    }
  };

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
      spoken = 'browser';
      return true;
    } catch {
      return false;
    }
  };

  // -------------------------------------------------------------------------------- tier 1

  /**
   * One line of the bank, from whichever door is configured.
   *
   * The relay is preferred: it holds the key server-side and it is the same handler the
   * on-demand tier uses, so the two tiers are two renderings of one voice rather than two
   * configurations that have to be kept in step. A browser key is only reached when no relay
   * is set, which is the booth-laptop case and nothing this repo configures.
   */
  const fetchBankLine = async (line: string, timeoutMs: number): Promise<ArrayBuffer | null> => {
    const { apiKey, voiceId } = options;
    const response = relayPath !== undefined && options.preloadBank === true
      ? await withTimeout(fetch(relayPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: line }),
      }), timeoutMs)
      : apiKey === undefined || voiceId === undefined
        ? null
        : await withTimeout(fetch(`${ENDPOINT}/${voiceId}`, {
          method: 'POST',
          headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: line, model_id: 'eleven_turbo_v2_5' }),
        }), timeoutMs);

    if (response === null || !response.ok) return null;
    return response.arrayBuffer();
  };

  const generate = async (): Promise<void> => {
    const { apiKey, voiceId, timeoutMs = 4000 } = options;
    const viaRelay = relayPath !== undefined && options.preloadBank === true;
    const viaKey = apiKey !== undefined && voiceId !== undefined;
    if (!viaRelay && !viaKey) return;
    const ctx = ctxOf();
    if (ctx === null) return;

    // Sequential on purpose. Firing thirty requests at once on saturated wifi is how you get
    // thirty timeouts instead of the first ten succeeding, and the early lines are the ones
    // needed first.
    for (const line of allLines()) {
      try {
        const audio = await fetchBankLine(line, timeoutMs);
        if (audio === null) return;
        bank.set(line, await ctx.decodeAudioData(audio));
      } catch {
        // One failure means the network is not going to cooperate. Stop asking and let the
        // browser voice carry the session rather than stalling load behind thirty timeouts.
        return;
      }
    }
  };

  const ready = generate().catch(() => undefined);

  // -------------------------------------------------------------------------------- tier 2

  /**
   * One round trip to the relay, decoded. Null on anything at all going wrong.
   *
   * The relay hands back audio bytes rather than JSON, so this is the same
   * `decodeAudioData(await response.arrayBuffer())` the bank has always used -- the path that
   * is known to work on the headset, reused rather than re-invented. Streaming would mean Media
   * Source Extensions on a browser that is already awkward, and would buy nothing: the wait is
   * already covered by the acknowledgement the panel speaks from a clip it already has.
   */
  const fetchClip = async (text: string): Promise<AudioBuffer | null> => {
    const ctx = ctxOf();
    if (relayPath === undefined || ctx === null || health.disabled) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), relayTimeoutMs);
    try {
      const response = await fetch(relayPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        // 404 and 503 mean this deployment has no voice, and `afterFailure` retires the tier on
        // the spot rather than spending a timeout per line for the rest of the session.
        health = afterFailure(health, response.status);
        console.warn(`[chef] speech relay ${response.status}`);
        return null;
      }
      const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
      health = afterSuccess(health);
      return buffer;
    } catch (error) {
      health = afterFailure(health, null);
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.warn('[chef] speech relay failed', error);
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  /** Deduplicated, cached, and never awaited by a caller. Rule #10. */
  const clipFor = (key: string): Promise<AudioBuffer | null> => {
    const running = inFlight.get(key);
    if (running !== undefined) return running;

    const work = fetchClip(key)
      .then((buffer) => {
        // Stored even when the answer it belonged to has been superseded. It has been paid for,
        // and the chef repeats itself more than it looks like -- the same deficit produces the
        // same instruction every time it is raised.
        if (buffer !== null) remember(clips, key, buffer);
        return buffer;
      })
      .finally(() => inFlight.delete(key));

    inFlight.set(key, work);
    return work;
  };

  /**
   * Counts the requests, so a reply that lands after the cook has moved on does not speak.
   *
   * Same guard, and the same reason, as `askToken` in `src/menu/guidance.ts`: the panel replaces
   * all three channels when a better answer arrives, and audio for the previous one arriving
   * afterwards would be the chef contradicting its own subtitle.
   */
  let sayToken = 0;

  const synthesise = (line: string, key: string): void => {
    const token = ++sayToken;
    void clipFor(key).then((buffer) => {
      if (token !== sayToken) return;
      if (buffer === null || !playClip(buffer)) speakInBrowser(line);
    });
  };

  // -------------------------------------------------------------------------------- choosing

  const capabilities = (line: string): SpeechCapabilities => ({
    inBank: bank.has(line),
    inCache: clips.has(speechKey(line)),
    canSynthesise: relayPath !== undefined && !health.disabled && ctxOf() !== null,
    hasBrowserVoice: typeof speechSynthesis !== 'undefined',
  });

  /**
   * The single entry point, so tier order lives in one place.
   *
   * The decision itself is `chooseTier`, which is pure and tested. What is left here is the
   * doing of it, plus one thing the pure function cannot know: whether a clip it believed was
   * ready actually played. A decoded buffer that refuses to start means the audio device went
   * away mid-session, and the line falls to `fallbackTier` rather than being lost.
   */
  const speak = (line: string): void => {
    const caps = capabilities(line);
    const key = speechKey(line);

    switch (chooseTier(line, caps)) {
      case 'bank':
        if (playClip(bank.get(line))) {
          spoken = 'bank';
          return;
        }
        break;
      case 'cache':
        if (playClip(clips.get(key))) {
          spoken = 'cache';
          return;
        }
        break;
      case 'relay':
        spoken = 'relay';
        synthesise(line, key);
        return;
      case 'browser':
        speakInBrowser(line);
        return;
      case 'silent':
        if (key !== '') spoken = 'silent';
        return;
    }

    if (fallbackTier(caps) === 'browser') speakInBrowser(line);
    else spoken = 'silent';
  };

  return {
    ready,
    tier: () =>
      bank.size > 0 || clips.size > 0 ? 'elevenlabs' : usedBrowserVoice ? 'browser' : 'silent',
    lastTier: () => spoken,

    say(bark: Bark) {
      speak(bark.line);
    },

    /**
     * Fetches a line into the tier-2 cache without speaking it.
     *
     * For the handful of lines that are fixed, known in advance, and NOT in the bark bank --
     * `ACKNOWLEDGEMENT` is the only one today. It is said the instant the cook presses Unsure,
     * which is the moment the whole feature is judged on, and a four-second round trip there
     * would be four seconds of nothing. One request at mount buys an instant acknowledgement for
     * the rest of the session.
     */
    prime(line: string) {
      const key = speechKey(line);
      if (key === '' || bank.has(line) || clips.has(key)) return;
      if (relayPath === undefined || health.disabled || ctxOf() === null) return;
      void clipFor(key);
    },
  };
}
