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

// ---------------------------------------------------------------------------------------------
// A PAGE, which is a different question from a line, and was being asked as though it were one
// ---------------------------------------------------------------------------------------------

/**
 * Consensus over repeated reads of a MULTI-LINE card.
 *
 * WHY THIS EXISTS, because the bug it fixes is the most instructive thing in this file.
 * `readCard` in `menu/guidance.ts` used to cast every line of a card as a separate vote into
 * ONE `VoteState`. Six lines across three reads therefore produced six buckets of near-equal
 * weight, `verdict()` computed `margin = best / runnerUp` of about 1.00, and `minMargin: 1.5`
 * rejected it. DECISIONS.md entry 32 measured the consequence: **none of sixteen cards were
 * accepted, including cards where all three reads were character-perfect**, and the cook was
 * told "Nothing legible. Hold the card closer and flatter." every single time.
 *
 * The vote was not wrong. It was being asked the wrong question. `verdict()` votes between
 * RIVAL TRANSCRIPTIONS OF ONE THING, and a margin is meaningful only because the candidates are
 * claims about the same text. Hand it a page and the lines compete as though they were
 * disagreeing readings of each other, and the more legible the card the more lines there are to
 * split the vote — the failure got WORSE as the input got better, which is why nobody caught it
 * by looking at a card that read badly.
 *
 * So a card is a SEQUENCE OF LINES, each of which gets its own ballot. Line-level behaviour is
 * untouched: entry 32 measured it as faultless on single lines (20 of 20 accepted and correct,
 * 10 of 10 garbage rejected, zero false accepts) and that property is the whole point of the
 * vote. Every line here goes through the same `castVote` and the same `verdict` with the same
 * thresholds.
 */
export interface PageVoteState {
  /** One ballot per line of the card, in reading order. */
  readonly lines: readonly VoteState[];
  /** How many whole-card reads have been folded in. */
  readonly reads: number;
}

export const emptyPage = (): PageVoteState => ({ lines: [], reads: 0 });

/** One line as an OCR engine hands it over. Mirrors the useful half of a `TextRegion`. */
export interface ReadLine {
  readonly text: string;
  readonly confidence: number;
}

/**
 * Folds ONE whole read of the card in.
 *
 * ASSOCIATION IS THE ONLY HARD PART, and it is the same problem `tracking.ts` solves one level
 * up: which of this read's lines is which of the last read's lines. Pairing them by index alone
 * breaks the moment a read drops a line — every line below it shifts up by one and votes
 * against its neighbour, which is a quieter version of the bug this function exists to fix.
 *
 * So: fold keys first, position second. An incoming line that folds to the same key as an
 * unclaimed slot belongs to that slot, whatever position either is in — `fold` already collapses
 * the confusions OCR actually makes, so this catches most lines on most cards. Whatever is left
 * is paired with whatever slots are left, in order, which is right when a line was misread badly
 * enough to change its key but still sits where it sat. Anything still unpaired is a line this
 * read saw and no earlier read did, and becomes a new slot at the end.
 *
 * Empty and sub-threshold lines are dropped by `castVote` itself, so they never take a slot.
 */
export function castPage(
  state: PageVoteState,
  read: readonly ReadLine[],
  opts: VoteOptions = DEFAULT_VOTE_OPTIONS,
): PageVoteState {
  const usable = read.filter((line) => {
    const clean = tidy(line.text);
    return clean !== ''
      && fold(clean) !== ''
      && Number.isFinite(line.confidence)
      && line.confidence >= opts.minConfidence;
  });
  if (usable.length === 0) {
    // A read that produced nothing usable still counts, because "two of three reads saw this
    // line" is the fact the verdict below is built on, and silently not counting a blank read
    // would make a line look better supported than it is.
    return { lines: state.lines, reads: state.reads + 1 };
  }

  const lines = [...state.lines];
  const claimed = new Set<number>();
  const pairing = new Map<number, number>();

  // Pass one: exact fold-key agreement with a slot's best-supported reading.
  usable.forEach((line, i) => {
    const key = fold(tidy(line.text));
    const slot = lines.findIndex((s, index) =>
      !claimed.has(index) && s.buckets.some((b) => b.key === key));
    if (slot !== -1) {
      claimed.add(slot);
      pairing.set(i, slot);
    }
  });

  // Pass two: whatever is left, paired in reading order with whatever slots are left.
  const spareSlots = lines.map((_, index) => index).filter((index) => !claimed.has(index));
  let spare = 0;
  usable.forEach((_, i) => {
    if (pairing.has(i)) return;
    const slot = spareSlots[spare];
    if (slot === undefined) return;
    spare += 1;
    claimed.add(slot);
    pairing.set(i, slot);
  });

  usable.forEach((line, i) => {
    const slot = pairing.get(i);
    if (slot === undefined) {
      lines.push(castVote(emptyVote(), line.text, line.confidence, opts));
      return;
    }
    lines[slot] = castVote(lines[slot]!, line.text, line.confidence, opts);
  });

  return { lines, reads: state.reads + 1 };
}

export interface PageVerdict {
  /** The agreed lines, joined by newlines, in reading order. */
  readonly text: string;
  readonly lines: readonly Verdict[];
  /** How many lines the reads expected to find. `lines.length` is how many they agreed on. */
  readonly expected: number;
  readonly reads: number;
}

/**
 * The agreed card, or null while the reads still disagree.
 *
 * TWO REFUSALS, AND THE SECOND ONE IS WHAT KEEPS THIS HONEST.
 *
 * A slot only counts as EXPECTED if a majority of reads saw it. A line one read of three
 * invented — a shadow, a fold in the paper, the edge of the table — is not evidence that the
 * card has a line there, and letting it veto an otherwise perfect card would reintroduce the
 * over-strictness this whole function exists to remove.
 *
 * Every expected slot must then reach a verdict. Entry 26's contract for this feature is that
 * it reports nothing the reads did not agree on, because a card reading "4 tomatoes" becoming
 * "4 tomatuea" is worse than no read at all — and a card missing the line with the quantity on
 * it is the same failure wearing a different hat. Partial text is not a partial answer here; it
 * is a confident wrong one. So a disagreed expected line fails the whole card, and null is
 * rendered as "nothing legible" exactly as it always was.
 */
export function pageVerdict(
  state: PageVoteState,
  opts: VoteOptions = DEFAULT_VOTE_OPTIONS,
): PageVerdict | null {
  if (state.reads === 0 || state.lines.length === 0) return null;

  const majority = Math.floor(state.reads / 2) + 1;
  const expected = state.lines.filter((line) => line.reads >= majority);
  if (expected.length === 0) return null;

  const agreed: Verdict[] = [];
  for (const line of expected) {
    const decided = verdict(line, opts);
    if (decided === null) return null;
    agreed.push(decided);
  }

  return {
    text: agreed.map((line) => line.text).join('\n'),
    lines: agreed,
    expected: expected.length,
    reads: state.reads,
  };
}
