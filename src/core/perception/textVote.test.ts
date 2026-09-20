import { describe, expect, it } from 'vitest';
import {
  castPage, castVote, DEFAULT_VOTE_OPTIONS, emptyPage, emptyVote, fold, pageVerdict, tidy,
  verdict, type PageVoteState, type ReadLine, type VoteState,
} from './textVote.js';

const vote = (reads: readonly (readonly [string, number])[]): VoteState => {
  let s = emptyVote();
  for (const [text, confidence] of reads) s = castVote(s, text, confidence);
  return s;
};

describe('tidy', () => {
  it('trims and collapses whitespace without touching the characters', () => {
    expect(tidy('  MILK   2%  ')).toBe('MILK 2%');
  });
});

describe('fold', () => {
  it('collapses the glyph pairs OCR actually confuses', () => {
    expect(fold('MILK')).toBe(fold('M1LK'));
    expect(fold('MILK')).toBe(fold('MlLK'));
    expect(fold('S0DA')).toBe(fold('SODA'));
    expect(fold('B8')).toBe(fold('88'));
  });

  it('ignores case, spacing and punctuation, which carry no OCR signal', () => {
    expect(fold('milk 2%')).toBe(fold('MILK2'));
  });

  it('keeps genuinely different words apart', () => {
    expect(fold('MILK')).not.toBe(fold('MINT'));
  });
});

describe('castVote', () => {
  it('ignores an empty or whitespace-only read', () => {
    expect(castVote(emptyVote(), '   ', 0.9).reads).toBe(0);
  });

  it('ignores a read below the confidence floor', () => {
    expect(castVote(emptyVote(), 'MILK', 0.1).reads).toBe(0);
  });

  it('ignores a read that folds away to nothing', () => {
    expect(castVote(emptyVote(), '---', 0.9).reads).toBe(0);
  });

  it('ignores a non-finite confidence rather than poisoning the weight', () => {
    expect(castVote(emptyVote(), 'MILK', Number.NaN).reads).toBe(0);
  });
});

describe('verdict', () => {
  it('is null before there is enough support to commit', () => {
    expect(verdict(emptyVote())).toBeNull();
    expect(verdict(vote([['MILK', 0.5]]))).toBeNull();
  });

  it('commits once one reading has enough weight behind it', () => {
    expect(verdict(vote([['MILK', 0.7], ['MILK', 0.8]]))!.text).toBe('MILK');
  });

  /**
   * The point of the whole module. Six reads of one label come back as six slightly different
   * strings; folding them into one bucket is what lets them reinforce each other instead of
   * splitting the vote six ways and never reaching a margin.
   */
  it('accumulates near-misses into one reading instead of splitting the vote', () => {
    const v = verdict(vote([
      ['MILK 2%', 0.8], ['MlLK 2%', 0.7], ['M1LK 2%', 0.6], ['MILK Z%', 0.5],
    ]))!;
    expect(v.text).toBe('MILK 2%');
    expect(v.weight).toBeCloseTo(2.6, 6);
  });

  it('shows the best-supported raw spelling, never the folded key', () => {
    const v = verdict(vote([['MILK', 0.9], ['MILK', 0.9], ['M1LK', 0.5]]))!;
    expect(v.text).toBe('MILK');
  });

  /**
   * Same discipline as identify() in ingredients.ts: two candidates that are close together
   * mean the reads genuinely do not separate them, and a label that flips between two spellings
   * frame to frame reads as the system being broken rather than as the system being unsure.
   */
  it('refuses to commit while two readings are close', () => {
    expect(verdict(vote([['MILK', 0.9], ['MILK', 0.8], ['MINT', 0.9], ['MINT', 0.7]])))
      .toBeNull();
  });

  it('commits once the winner pulls clear of the runner-up', () => {
    const v = verdict(vote([
      ['MILK', 0.9], ['MILK', 0.9], ['MILK', 0.9], ['MINT', 0.6],
    ]))!;
    expect(v.text).toBe('MILK');
    expect(v.margin).toBeGreaterThanOrEqual(DEFAULT_VOTE_OPTIONS.minMargin);
  });

  it('reports an infinite margin when nothing competes with the winner', () => {
    expect(verdict(vote([['MILK', 0.9], ['MILK', 0.9]]))!.margin)
      .toBe(Number.POSITIVE_INFINITY);
  });

  it('counts the reads it was built from, so the overlay can show its working', () => {
    expect(verdict(vote([['MILK', 0.9], ['MILK', 0.9], ['MILK', 0.9]]))!.reads).toBe(3);
  });

  it('breaks a spelling tie toward the longer string, which dropped fewer characters', () => {
    const v = verdict(vote([['MILK 2%', 0.9], ['MILK 2', 0.9], ['MILK 2%', 0.01]]))!;
    expect(v.text).toBe('MILK 2%');
  });
});

// -----------------------------------------------------------------------------------------
// A page, which is a different question from a line
// -----------------------------------------------------------------------------------------

const CARD = [
  'TONIGHT',
  'Tomato Mozzarella Salad',
  '4 tomatoes',
  '1 ball mozzarella',
  'basil',
  'olive oil',
];

const readOf = (lines: readonly string[], confidence = 0.85): ReadLine[] =>
  lines.map((text) => ({ text, confidence }));

const threeReads = (reads: readonly (readonly string[])[]): PageVoteState =>
  reads.reduce<PageVoteState>((state, lines) => castPage(state, readOf(lines)), emptyPage());

describe('pageVerdict', () => {
  /**
   * The regression that this whole half of the file exists for.
   *
   * DECISIONS.md entry 32: casting every line of a card into ONE `VoteState` gave six buckets
   * of near-equal weight, a margin of about 1.00 against a `minMargin` of 1.5, and **none of
   * sixteen cards accepted, including character-perfect reads**. The old shape is asserted here
   * alongside the new one, because the fix is only interesting next to what it replaced.
   */
  it('accepts a card three perfect reads agree on, which the one-ballot vote could not', () => {
    const pooled = CARD.concat(CARD, CARD)
      .reduce((state, text) => castVote(state, text, 0.85), emptyVote());
    expect(verdict(pooled), 'the old shape: six lines competing as rival readings').toBeNull();

    const page = pageVerdict(threeReads([CARD, CARD, CARD]));
    expect(page).not.toBeNull();
    expect(page!.text.split('\n')).toEqual([...CARD]);
    expect(page!.expected).toBe(6);
    expect(page!.reads).toBe(3);
  });

  it('still votes WITHIN a line, so OCR noise is outvoted rather than shown', () => {
    const page = pageVerdict(threeReads([
      ['4 tomatoes', 'basil'],
      ['4 tomatuea', 'basil'],
      ['4 tomatoes', 'basil'],
    ]));
    // "tomatoes" and "tomatuea" fold to the same key, so they reinforce rather than split, and
    // the better-supported raw spelling is the one shown.
    expect(page!.text.split('\n')[0]).toBe('4 tomatoes');
  });

  it('refuses the whole card when an expected line never settles', () => {
    // Three genuinely different readings of line two, each seen once: no margin, no verdict.
    const page = pageVerdict(threeReads([
      ['4 tomatoes', 'olive oil'],
      ['4 tomatoes', 'WHAT EVEN'],
      ['4 tomatoes', 'zzz qqq xx'],
    ]));
    expect(page).toBeNull();
  });

  it('does not let a line one read invented veto a card the others agreed on', () => {
    const page = pageVerdict(threeReads([
      ['4 tomatoes', 'basil'],
      ['4 tomatoes', 'basil', 'a shadow on the fold'],
      ['4 tomatoes', 'basil'],
    ]));
    expect(page).not.toBeNull();
    expect(page!.text.split('\n')).toEqual(['4 tomatoes', 'basil']);
  });

  it('pairs lines by fold key, so a dropped line does not shift every line below it', () => {
    const page = pageVerdict(threeReads([
      ['TONIGHT', '4 tomatoes', 'basil'],
      ['4 tomatoes', 'basil'],
      ['TONIGHT', '4 tomatoes', 'basil'],
    ]));
    expect(page!.text.split('\n')).toEqual(['TONIGHT', '4 tomatoes', 'basil']);
  });

  it('counts a read that produced nothing usable, rather than pretending it did not happen', () => {
    const state = castPage(castPage(emptyPage(), readOf(['basil'])), []);
    expect(state.reads).toBe(2);
    expect(state.lines).toHaveLength(1);
  });

  it('is null before anything has been read', () => {
    expect(pageVerdict(emptyPage())).toBeNull();
    expect(pageVerdict(castPage(emptyPage(), []))).toBeNull();
  });

  it('drops lines below the confidence floor without giving them a slot', () => {
    const state = castPage(emptyPage(), [
      { text: 'basil', confidence: 0.85 },
      { text: 'garbage', confidence: 0.1 },
    ]);
    expect(state.lines).toHaveLength(1);
  });

  /**
   * The property entry 32 measured as faultless and which must survive: 20 of 20 single lines
   * accepted and correct, 10 of 10 garbage rejected, zero false accepts.
   */
  it('behaves exactly as the single-line vote does on a single-line card', () => {
    const page = pageVerdict(threeReads([['MILK 2%'], ['MlLK 2%'], ['MILK 2%']]));
    const line = verdict(
      [['MILK 2%'], ['MlLK 2%'], ['MILK 2%']]
        .reduce((state, [text]) => castVote(state, text!, 0.85), emptyVote()),
    );
    expect(page!.text).toBe(line!.text);
    expect(page!.lines).toHaveLength(1);
  });
});
