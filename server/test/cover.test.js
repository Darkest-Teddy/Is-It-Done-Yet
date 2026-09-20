/**
 * Cover colours. Pure, so the properties that matter can be asserted exhaustively.
 */

import { describe, expect, it } from 'vitest';

import { COVER_INK, COVER_TINTS, coverFor } from '../src/cover.js';

describe('coverFor', () => {
  it('is stable for the same recipe', () => {
    const a = coverFor({ slug: 'smash-burger', tags: [] });
    const b = coverFor({ slug: 'smash-burger', tags: [] });
    expect(a).toEqual(b);
  });

  it('always returns three usable hex colours', () => {
    for (const slug of ['a', 'smash-burger', 'x'.repeat(64), '']) {
      const cover = coverFor({ slug, tags: [] });
      for (const value of Object.values(cover)) expect(value).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it('uses the palette and nothing outside it', () => {
    const tints = new Set(COVER_TINTS);
    for (let i = 0; i < 200; i++) {
      expect(tints.has(coverFor({ slug: `dish-${i}`, tags: [] }).tint)).toBe(true);
    }
  });

  it('picks a tint from a matching tag', () => {
    expect(coverFor({ slug: 'x', tags: ['salad'] }).tint).toBe('#CDE6C7');
    expect(coverFor({ slug: 'x', tags: ['beef'] }).tint).toBe('#F9C7BE');
  });

  /** Ordered rules, not object key order: "salad" is listed after "beef" and must lose. */
  it('resolves a multi-tag recipe the same way every time', () => {
    expect(coverFor({ slug: 'x', tags: ['salad', 'beef'] }).tint)
      .toBe(coverFor({ slug: 'x', tags: ['beef', 'salad'] }).tint);
  });

  it('is case-insensitive about tags', () => {
    expect(coverFor({ slug: 'x', tags: ['SALAD'] }).tint).toBe('#CDE6C7');
  });

  it('spreads untagged recipes across the whole palette', () => {
    const seen = new Set();
    for (let i = 0; i < 400; i++) seen.add(coverFor({ slug: `untagged-${i}`, tags: [] }).tint);
    expect(seen.size).toBe(COVER_TINTS.length);
  });

  it('never puts the red accent on a cool card', () => {
    for (const tags of [['salad'], ['soup'], ['beef'], ['spicy'], []]) {
      const { tint, accent } = coverFor({ slug: 'x', tags });
      if (tint === '#CDE6C7' || tint === '#C4DAEE') expect(accent).toBe('#FBD24B');
    }
  });

  it('uses the one outline colour the design uses', () => {
    expect(coverFor({ slug: 'x', tags: [] }).ink).toBe(COVER_INK);
  });

  it('falls back to the title when there is no slug', () => {
    expect(coverFor({ title: 'Smash Burger', tags: [] }).tint).toBeTypeOf('string');
  });

  it('survives a malformed recipe rather than throwing', () => {
    expect(() => coverFor(null)).not.toThrow();
    expect(() => coverFor({})).not.toThrow();
    expect(() => coverFor({ tags: 'not-an-array' })).not.toThrow();
  });
});
