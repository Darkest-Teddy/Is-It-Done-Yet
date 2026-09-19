/**
 * Consensus over repeated OCR reads of the same text.
 *
 * Object detection flickers in CONFIDENCE; OCR flickers in CONTENT. The same label read on six
 * consecutive frames comes back as six slightly different strings, and picking any one of them
 * is picking at random. Text has a property that helps, though, and it is worth stating plainly:
 * a printed label does not change. Every read is a noisy sample of one fixed answer, so the
 * right move is to accumulate evidence rather than to trust the latest frame.
 *
 * This is the same shape as `tracking.ts`, one level up: hysteresis for strings.
 *
 * Two thresholds decide when to commit, deliberately mirroring `identify()` in
 * `src/core/ingredients.ts`. A winner needs absolute support AND a margin over the runner-up,
 * because two plausible readings that are close together mean the reads genuinely do not
 * separate them -- and a label that flips between two candidates frame to frame reads to a
 * player as the system being broken, rather than as the system being unsure.
 */

export interface VoteOptions {
  /** Total confidence a reading needs before it may be shown at all. */
  readonly minWeight: number;
  /** How far ahead of the runner-up the winner must be. 1.5 means fifty percent more support. */
  readonly minMargin: number;
  /** Readings below this are not even counted. Bad OCR is confidently wrong surprisingly often. */
  readonly minConfidence: number;
}

export const DEFAULT_VOTE_OPTIONS: VoteOptions = {
  minWeight: 1.2,
  minMargin: 1.5,
  minConfidence: 0.4,
};

interface Bucket {
  /** Folded key, for grouping only. Never displayed. */
  readonly key: string;
  readonly weight: number;
  /** Raw spellings seen, with accumulated weight, so the display can pick the best-supported. */
  readonly spellings: ReadonlyMap<string, number>;
}

export interface VoteState {
  readonly buckets: readonly Bucket[];
  readonly reads: number;
}

export const emptyVote = (): VoteState => ({ buckets: [], reads: 0 });

/**
 * Collapses the differences OCR invents, and nothing else.
 *
 * Scene text OCR does not make random mistakes; it makes a small set of specific ones, because
 * the glyph pairs it confuses are the ones that genuinely look alike at low resolution. Folding
 * exactly those pairs means six reads of "MILK 2%" that came back as "MlLK 2%", "M1LK 2%" and
 * "MILK Z%" all land in one bucket and reinforce each other, instead of splitting the vote four
 * ways and never reaching a margin.
 *
 * The fold is only ever used as a GROUPING KEY. What gets displayed is the best-supported raw
 * spelling, so the user never sees "M1LK 2" -- the destruction here is not lossy where it
 * matters, because the original strings are all still held.
 */
export function fold(text: string): string {
  return text
    .toUpperCase()
    .replace(/[OQD]/g, '0')
    .replace(/[ILT|]/g, '1')
    .replace(/S/g, '5')
    .replace(/[BR]/g, '8')
    .replace(/Z/g, '2')
    .replace(/[G6]/g, '6')
    .replace(/[^A-Z0-9]/g, '');
}

/** Trims and collapses internal whitespace. Display hygiene, applied before anything else. */
export const tidy = (text: string): string => text.trim().replace(/\s+/g, ' ');

export function castVote(
  state: VoteState,
  text: string,
  confidence: number,
  opts: VoteOptions = DEFAULT_VOTE_OPTIONS,
): VoteState {
  const clean = tidy(text);
  if (clean === '' || !Number.isFinite(confidence) || confidence < opts.minConfidence) {
    return state;
  }
  const key = fold(clean);
  if (key === '') return state;

  const buckets = [...state.buckets];
  const index = buckets.findIndex((b) => b.key === key);

  if (index === -1) {
    buckets.push({ key, weight: confidence, spellings: new Map([[clean, confidence]]) });
  } else {
    const bucket = buckets[index]!;
    const spellings = new Map(bucket.spellings);
    spellings.set(clean, (spellings.get(clean) ?? 0) + confidence);
    buckets[index] = { key, weight: bucket.weight + confidence, spellings };
  }

  return { buckets, reads: state.reads + 1 };
}

export interface Verdict {
  readonly text: string;
  /** Total confidence behind the winning reading. */
  readonly weight: number;
  /** How far ahead of the runner-up it is. Infinite when there is no runner-up. */
  readonly margin: number;
  readonly reads: number;
}

/**
 * The agreed reading, or null while the reads still disagree.
 *
 * Null is a real answer and should be rendered as one -- an ellipsis, a dimmed placeholder,
 * anything that says "still looking". Showing the current best guess while it is still moving
 * is what produces a label that visibly rewrites itself, which is the exact failure this whole
 * module exists to avoid.
 */
export function verdict(
  state: VoteState, opts: VoteOptions = DEFAULT_VOTE_OPTIONS,
): Verdict | null {
  if (state.buckets.length === 0) return null;

  const ranked = [...state.buckets].sort((a, b) => b.weight - a.weight);
  const best = ranked[0]!;
  if (best.weight < opts.minWeight) return null;

  const runnerUp = ranked[1];
  const margin = runnerUp === undefined || runnerUp.weight === 0
    ? Number.POSITIVE_INFINITY
    : best.weight / runnerUp.weight;
  if (margin < opts.minMargin) return null;

  // Within the winning bucket, show the spelling with the most support behind it. Ties break on
  // the longer string, which is almost always the one that did not drop a character.
  let text = '';
  let bestSpellingWeight = -1;
  for (const [spelling, weight] of best.spellings) {
    if (weight > bestSpellingWeight
      || (weight === bestSpellingWeight && spelling.length > text.length)) {
      text = spelling;
      bestSpellingWeight = weight;
    }
  }

  return { text, weight: best.weight, margin, reads: state.reads };
}
