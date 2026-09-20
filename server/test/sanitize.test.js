/** Pure name rules. No database, so these can be exhaustive and instant. */

import { describe, expect, it } from 'vitest';

import { cleanName, isBlocked, normalizeName, slugify } from '../src/sanitize.js';

describe('cleanName', () => {
  it('trims and collapses whitespace', () => {
    expect(cleanName('   Ada    Lovelace  ')).toBe('Ada Lovelace');
  });

  it('strips zero-width and bidi control characters', () => {
    expect(cleanName('A​d‮a')).toBe('Ada');
  });

  it('strips C0 control characters', () => {
    expect(cleanName('Ad\u0000a\u001F')).toBe('Ada');
  });

  it('drops characters outside the allowlist', () => {
    expect(cleanName('<script>alert(1)</script>')).toBe('scriptalert1script');
  });

  it('keeps dot, underscore and hyphen', () => {
    expect(cleanName('a.b_c-d')).toBe('a.b_c-d');
  });

  it('NFKC-normalises fullwidth text onto ASCII', () => {
    expect(cleanName('Ａｄａ')).toBe('Ada');
  });

  it('caps at 20 characters', () => {
    expect(cleanName('a'.repeat(50))).toHaveLength(20);
  });

  it('returns empty for a non-string', () => {
    expect(cleanName(undefined)).toBe('');
    expect(cleanName(42)).toBe('');
  });
});

describe('isBlocked', () => {
  it('catches a plain blocked word', () => {
    expect(isBlocked('shit')).toBe(true);
  });

  it('catches spaced and punctuated evasion', () => {
    expect(isBlocked('s h i t')).toBe(true);
    expect(isBlocked('s.h.i.t')).toBe(true);
  });

  it('catches digit substitution', () => {
    expect(isBlocked('sh1t')).toBe(true);
  });

  it('leaves ordinary names alone', () => {
    expect(isBlocked('Ada Lovelace')).toBe(false);
    expect(isBlocked('chef_42')).toBe(false);
  });
});

describe('normalizeName', () => {
  it('accepts a clean name', () => {
    expect(normalizeName('  Ada  ')).toEqual({ ok: true, name: 'Ada' });
  });

  it('rejects a name that sanitises to nothing', () => {
    expect(normalizeName('   ').ok).toBe(false);
    expect(normalizeName('​​').ok).toBe(false);
  });

  it('rejects a blocked name', () => {
    expect(normalizeName('fuck').ok).toBe(false);
  });

  it('gives blocked and empty the same message, so the filter is not a tutorial', () => {
    expect(normalizeName('fuck').reason).toBe(normalizeName('   ').reason);
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Cucumber  Raita!')).toBe('cucumber-raita');
  });

  it('returns null when nothing usable survives', () => {
    expect(slugify('!!!')).toBeNull();
  });
});
