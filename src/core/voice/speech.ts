/**
 * Which voice says a line, and what happens when the one that should have said it cannot.
 *
 * `src/audio/chef.ts` was written around a bank of lines generated once at load and played from
 * an exact-text `Map`. That is the right shape for barks -- the whole point of pre-generating
 * them is that a reaction to a cut arrives with the cut -- but it can only ever speak sentences
 * somebody wrote in advance, and the in-cooking chef does not: Qwen3 phrases the answer at
 * runtime, and `localGuidance` assembles its own from deficit text. Neither is in the Map.
 *
 * On a laptop that miss is invisible, because `speechSynthesis` catches it. On the headset it is
 * total silence: DECISIONS.md entry 19 measured `speechSynthesis` as **absent** from Quest
 * Browser rather than merely unreliable, so the chef there is "ElevenLabs or subtitles, with
 * nothing in between" -- and a line that was never pre-generated is not in ElevenLabs either.
 * Every model-written sentence was therefore silent on the only device that matters.
 *
 * So there is a fourth tier: synthesise novel text on demand. This file is the part of that
 * decision which does not need a speaker, a network or a clock, which is most of it -- what
 * counts as the same line twice, what is worth paying to synthesise, which tier owns a given
 * line, and when a relay has failed often enough to stop being asked.
 *
 * WHY THE HEALTH COUNTER IS HERE AND NOT INLINE. The on-demand tier is load-bearing for headset
 * voice, which means its failure mode is the feature. `chef.ts` already had the right instinct
 * for the bank -- one failure and it stops asking, rather than stalling load behind thirty
 * timeouts -- but "stop after the first hiccup" is too brittle for a tier that has to last a
 * whole session, and "keep trying forever" spends two seconds of silence per line on a dead
 * relay. The rule in `afterFailure` is the compromise, and it is here so it can be argued with
 * in a test rather than inferred from a counter buried in a closure.
 *
 * Pure -- no DOM, no fetch, no clock, and `remember` touches only the Map it is handed.
 */

/**
 * Who actually speaks a line.
 *
 * Ordered by how long the cook waits: `bank` and `cache` are already decoded and start this
 * frame, `relay` is a round trip, `browser` is instant but does not exist on the headset, and
 * `silent` means the panel text is the whole answer.
 */
export type SpeechTier = 'bank' | 'cache' | 'relay' | 'browser' | 'silent';

export interface SpeechCapabilities {
  /** The line was pre-generated at load and is decoded and ready. Exact text match. */
  readonly inBank: boolean;
  /** The line has been synthesised on demand already this session. */
  readonly inCache: boolean;
  /** A relay is configured, has not been given up on, and there is somewhere to play it. */
  readonly canSynthesise: boolean;
  /** `speechSynthesis` exists. False on Quest Browser -- see the header. */
  readonly hasBrowserVoice: boolean;
}

/**
 * The longest line worth paying to synthesise.
 *
 * `guidance.ts` clips spoken lines to 200 characters, so anything approaching this ceiling is
 * not a spoken line -- it is a paragraph that reached the speaker by mistake. ElevenLabs bills
 * per character, and a demo has one card behind it. TUNED, not sourced: twice the clip the
 * guidance layer already applies, so a legitimate sentence can never be refused by it.
 */
export const SPEECH_MAX_SYNTH_CHARS = 400;

/**
 * What counts as the same line twice.
 *
 * Whitespace is collapsed because the same sentence assembled two ways -- a template with an
 * empty slot in it, a model reply with a stray newline -- is one clip and should be paid for
 * once. Case and punctuation are NOT normalised: they are prosody. "Stop." and "stop" are the
 * same string to a cache and two different readings to a voice, and the cheaper of those two
 * mistakes is paying twice.
 */
export function speechKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** Whether this text is a sentence worth spending a synthesis call on. See the constant. */
export function isWorthSynthesising(text: string): boolean {
  const key = speechKey(text);
  return key !== '' && key.length <= SPEECH_MAX_SYNTH_CHARS;
}

/**
 * Which tier owns this line.
 *
 * The order is the argument. Anything already decoded plays now, because the pre-generated bank
 * exists precisely so a reaction is not a round trip. Otherwise the relay is preferred over the
 * browser voice even though the browser voice is instant, because on the headset there is no
 * browser voice at all and on a laptop the ElevenLabs chef is the one the demo is built around;
 * the acknowledgement in `openingMove` is what covers the wait, and it is covered on both.
 *
 * Note that this never returns `relay` for text it would refuse to send. A caller that asked
 * for the tier and then guarded the length separately would be two rules to keep in step.
 */
export function chooseTier(text: string, caps: SpeechCapabilities): SpeechTier {
  if (speechKey(text) === '') return 'silent';
  if (caps.inBank) return 'bank';
  if (caps.inCache) return 'cache';
  if (caps.canSynthesise && isWorthSynthesising(text)) return 'relay';
  return caps.hasBrowserVoice ? 'browser' : 'silent';
}

/**
 * What speaks the line when the relay was asked and did not deliver.
 *
 * Deliberately not "try the relay again". The caller has already spent its timeout; spending a
 * second one before falling back would double the silence in exchange for a retry against a
 * thing that just failed.
 */
export function fallbackTier(caps: SpeechCapabilities): 'browser' | 'silent' {
  return caps.hasBrowserVoice ? 'browser' : 'silent';
}

// ---------------------------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------------------------

/**
 * How many on-demand clips are held.
 *
 * A session asks a handful of questions and the chef repeats itself more than it looks like --
 * the same deficit produces the same instruction every time it is raised, and the
 * acknowledgement is one fixed string. Thirty-two covers a session's worth of distinct lines.
 * The cap is there because decoded audio is raw PCM in memory and this runs on a headset, not
 * because anybody expects to reach it.
 */
export const MAX_REMEMBERED_CLIPS = 32;

/**
 * Stores a clip, evicting the oldest first once the cap is reached.
 *
 * Insertion order, not least-recently-used. A Map iterates in insertion order for free, LRU
 * needs a touch on every read, and at this size the difference is unmeasurable. Re-storing an
 * existing key refreshes its value without moving it, which is what `Map.set` already does.
 */
export function remember<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
  max = MAX_REMEMBERED_CLIPS,
): void {
  if (max <= 0) return;
  cache.set(key, value);
  while (cache.size > max) {
    const oldest = cache.keys().next();
    if (oldest.done === true) return;
    cache.delete(oldest.value);
  }
}

// ---------------------------------------------------------------------------------------------
// When to stop asking
// ---------------------------------------------------------------------------------------------

export interface RelayHealth {
  /** Consecutive failures. Reset by any success. */
  readonly strikes: number;
  /** Once true, the tier is not asked again for the life of the page. */
  readonly disabled: boolean;
}

export const FRESH_RELAY: RelayHealth = { strikes: 0, disabled: false };

/** Consecutive transport failures tolerated before the tier is abandoned. */
export const MAX_RELAY_STRIKES = 2;

/**
 * HTTP statuses that mean "this server will never do this", as opposed to "not right now".
 *
 * The relay answers 503 when no ElevenLabs key is configured on it, exactly as the guidance
 * relay answers 503 with no `QWEN_BASE_URL`. That is a fact about the deployment, not weather,
 * and retrying it costs a timeout per line for the rest of the session in exchange for nothing.
 *
 * 404 is in the list for the deployment this repo has actually had: a static host with no
 * server behind it at all, where the route does not exist and never will within this page's
 * lifetime. 401 and 429 are deliberately NOT here -- the relay reports both as a plain 502
 * because they are the upstream's business, not the browser's.
 */
const TERMINAL_STATUSES: readonly number[] = [404, 501, 503];

/**
 * Folds one failure in. `status` is the HTTP status, or null for a timeout or a dead socket.
 *
 * Two strikes rather than one, and that is a change of posture from the bank's rule. The bank
 * gives up after a single failure because it is a load-time batch of thirty requests and the
 * first one failing says the next twenty-nine will too. This tier is asked once per answer over
 * a whole session, so a single timeout on venue wifi is weather, and killing headset voice for
 * the rest of a demo over one dropped packet is a worse outcome than one repeated attempt.
 */
export function afterFailure(health: RelayHealth, status: number | null = null): RelayHealth {
  if (health.disabled) return health;
  if (status !== null && TERMINAL_STATUSES.includes(status)) {
    return { strikes: health.strikes + 1, disabled: true };
  }
  const strikes = health.strikes + 1;
  return { strikes, disabled: strikes >= MAX_RELAY_STRIKES };
}

/** Folds one success in. A working request clears the record; it cannot revive a disabled tier. */
export function afterSuccess(health: RelayHealth): RelayHealth {
  return health.disabled ? health : FRESH_RELAY;
}
