/**
 * Speech in, behind an interface, so the rest of the app never learns which door it came
 * through.
 *
 * This mirrors the `VisionProvider` shape the repo already uses for detection, for the same
 * reason: the platforms genuinely differ, and the difference must not leak into game logic.
 *
 * WHERE EACH PROVIDER WORKS. This table is the whole reason the abstraction exists.
 *
 * | Provider    | Desktop Chrome | Quest Browser | Offline |
 * |-------------|----------------|---------------|---------|
 * | `webspeech` | yes            | **no**        | no      |
 * | `typed`     | yes            | yes           | yes     |
 *
 * **Quest Browser does not implement the Web Speech API.** Meta never shipped
 * `SpeechRecognition` there, so the one-line path that works on a laptop is simply absent on
 * the headset. A headset build needs either raw `getUserMedia` audio posted to a cloud
 * transcriber, or -- in Unity -- Meta's own Voice SDK, which is built for exactly this and is
 * the better answer on that side. Neither belongs in this file; both plug in here.
 *
 * AND THE HONEST PART ABOUT "OFFLINE". `webkitSpeechRecognition` in Chrome is not local
 * recognition: it streams audio to Google and returns text. So the *intent* layer in
 * `src/core/voice` runs with the network unplugged and the *transcription* does not. Rule #12
 * asks for what survives a live demo on bad wifi, which is why `typed` exists and is not a
 * toy -- it is the tier that still works when the hall wifi collapses, exactly as
 * `speechSynthesis` is that tier for the chef's voice.
 */

/** One heard utterance. `final` marks a settled transcript rather than a running guess. */
export interface Heard {
  readonly text: string;
  readonly final: boolean;
}

export interface SpeechProvider {
  readonly name: 'webspeech' | 'typed';
  /** False when this door does not exist in the current browser. Never throws to find out. */
  readonly available: boolean;
  /** Idempotent. Starting an already-started provider is a no-op, not an error. */
  start(): void;
  stop(): void;
  readonly listening: () => boolean;
}

export interface SpeechOptions {
  readonly onHeard: (heard: Heard) => void;
  /** Surfaced to the status line. Never fatal -- speech failing must not take the page down. */
  readonly onError?: (message: string) => void;
  readonly lang?: string;
}

/** The vendor-prefixed constructor, without asserting it exists. */
interface RecognitionCtor {
  new (): SpeechRecognitionLike;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: { isFinal: boolean; 0: { transcript: string } };
  };
}

function recognitionCtor(): RecognitionCtor | null {
  const w = globalThis as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  // Feature detection, never a user-agent test. Quest Browser reports a Chrome-shaped UA and
  // does not have this constructor, so sniffing the string gets the answer exactly backwards.
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Desktop Chrome's recogniser.
 *
 * THE RESTART IS NOT OPTIONAL. Chrome ends a recognition session on its own after a few
 * seconds of silence, firing `onend` with no error. Without restarting, the chef listens for
 * about ten seconds after page load and is then deaf for the rest of the demo, silently and
 * with nothing in the console. Everyone hits this once.
 */
export function createWebSpeech(options: SpeechOptions): SpeechProvider {
  const Ctor = recognitionCtor();
  let recognition: SpeechRecognitionLike | null = null;
  let wanted = false;

  const build = (): SpeechRecognitionLike | null => {
    if (Ctor === null) return null;
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = options.lang ?? 'en-US';

    r.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result === undefined) continue;
        options.onHeard({ text: result[0].transcript, final: result.isFinal });
      }
    };

    r.onerror = (event) => {
      // `no-speech` and `aborted` are routine -- they fire on any quiet moment and on every
      // deliberate stop. Reporting them would fill the status line with non-events.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      options.onError?.(
        event.error === 'not-allowed'
          ? 'microphone permission denied'
          : `speech error: ${event.error}`,
      );
    };

    r.onend = () => {
      if (!wanted) return;
      // Restarting synchronously inside `onend` throws in some Chrome versions. A turn of the
      // event loop is enough and costs nothing perceptible.
      setTimeout(() => {
        if (!wanted || recognition === null) return;
        try {
          recognition.start();
        } catch {
          // Already running, which is harmless -- the session we were restarting came back.
        }
      }, 0);
    };

    return r;
  };

  return {
    name: 'webspeech',
    available: Ctor !== null,
    listening: () => wanted,

    start() {
      if (Ctor === null || wanted) return;
      wanted = true;
      recognition ??= build();
      try {
        recognition?.start();
      } catch (error) {
        wanted = false;
        options.onError?.(`could not start listening: ${(error as Error).message}`);
      }
    },

    stop() {
      wanted = false;
      try {
        recognition?.stop();
      } catch { /* stopping something already stopped is not a problem worth reporting */ }
    },
  };
}

/** A provider the caller pushes text into, rather than one that listens. */
export interface TypedProvider extends SpeechProvider {
  /** Hands one utterance to the same pipeline speech would have fed. */
  submit(text: string): void;
}

/**
 * The typed fallback, and the only tier that is genuinely offline.
 *
 * Not a degraded mode so much as a different input device. It is what runs in Quest Browser
 * today, what runs when the hall wifi collapses, and what lets the whole voice path be
 * rehearsed on a plane. It is also the accessible route for anyone who would rather not shout
 * "hey chef" across a crowded room, which at a judging table is most people.
 *
 * Text arrives already final -- there is no interim state when somebody presses Enter -- and
 * goes through the identical intent path, so what is proven here is what runs when the
 * microphone works.
 */
export function createTyped(options: SpeechOptions): TypedProvider {
  let on = false;
  return {
    name: 'typed',
    available: true,
    listening: () => on,
    start() { on = true; },
    stop() { on = false; },
    submit(text: string) {
      if (!on) return;
      options.onHeard({ text, final: true });
    },
  };
}

/**
 * Picks the best door available, with `typed` as the floor.
 *
 * The caller should show which one it got: a status line naming the active provider is what
 * stops "the chef cannot hear me" turning into twenty minutes of debugging a microphone that
 * was never the problem.
 */
export function bestProvider(options: SpeechOptions): SpeechProvider {
  const web = createWebSpeech(options);
  return web.available ? web : createTyped(options);
}
