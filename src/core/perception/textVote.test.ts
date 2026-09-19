import { describe, expect, it } from 'vitest';
import {
  castVote, DEFAULT_VOTE_OPTIONS, emptyVote, fold, tidy, verdict, type VoteState,
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
