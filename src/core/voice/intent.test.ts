import { describe, expect, it } from 'vitest';
import { firstNumber, hasWake, normalize, parseIntent, stripWake } from './intent.js';

/** Parses with the wake phrase already supplied, which is how nearly every case reads better. */
const said = (text: string) => parseIntent(`hey chef ${text}`);

describe('normalize', () => {
  it('lowercases, strips punctuation and collapses whitespace', () => {
    expect(normalize('  Hey CHEF,   how am I doing?! ')).toBe('hey chef how am i doing');
  });

  it('removes apostrophes rather than trying to spell every engine variant', () => {
    expect(normalize("what's the target")).toBe('whats the target');
    expect(normalize('what’s the target')).toBe('whats the target');
  });

  it('keeps a decimal point between digits but drops a sentence-ending one', () => {
    expect(normalize('make it 4.5mm.')).toBe('make it 4.5 mm');
  });

  /** "5mm" and "5 mm" come back from different engines for the same utterance. */
  it('splits a unit off the number it is stuck to', () => {
    expect(normalize('5mm')).toBe('5 mm');
    expect(normalize('cut at 12MM')).toBe('cut at 12 mm');
  });
});

describe('wake phrases', () => {
  it('recognises the addressed forms', () => {
    for (const w of ['hey chef', 'ok chef', 'okay ai', 'hey ai', 'hey mise', 'chef']) {
      expect(hasWake(normalize(`${w} how am i doing`))).toBe(true);
    }
  });

  it('strips the longest matching phrase, leaving no dangling word', () => {
    expect(stripWake('hey chef how am i doing')).toBe('how am i doing');
    expect(stripWake('chef how am i doing')).toBe('how am i doing');
  });

  it('leaves an unaddressed utterance alone', () => {
    expect(hasWake(normalize('so then I told him'))).toBe(false);
    expect(stripWake('so then i told him')).toBe('so then i told him');
  });

  /**
   * The failure this prevents is loud and on camera: a judge chatting to a friend beside the
   * booth should not be able to change the recipe.
   */
  it('ignores an unaddressed utterance entirely', () => {
    expect(parseIntent('make it five millimetres')).toBeNull();
  });

  it('acts on an unaddressed utterance when the caller opts out of the wake requirement', () => {
    expect(parseIntent('make it five millimetres', { requireWake: false }))
      .toEqual({ kind: 'setTarget', mm: 5 });
  });
});

describe('firstNumber', () => {
  it('reads digits and spelled numbers alike', () => {
    expect(firstNumber('make it 5 mm')).toBe(5);
    expect(firstNumber('make it five mm')).toBe(5);
    expect(firstNumber('make it twelve mm')).toBe(12);
  });

  it('reads the decimal an engine spells out', () => {
    expect(firstNumber('make it four point five')).toBe(4.5);
    expect(firstNumber('make it 4 point 5')).toBe(4.5);
  });

  it('returns null when there is no number', () => {
    expect(firstNumber('make it thinner')).toBeNull();
  });

  it('does not treat a trailing "point" as a decimal', () => {
    expect(firstNumber('give me five point')).toBe(5);
  });
});

describe('parseIntent', () => {
  it('answers the question the project is named after', () => {
    expect(said('is it done yet')).toEqual({ kind: 'progress' });
  });

  it('reads the session back for the ways people ask', () => {
    for (const phrase of [
      'how am i doing', 'hows it going', 'whats my score',
      'how did i do', 'how thick were they', 'am i done',
    ]) {
      expect(said(phrase), phrase).toEqual({ kind: 'progress' });
    }
  });

  it('reads the target back when the question is prospective', () => {
    for (const phrase of [
      'how thick should i cut', 'whats the target', 'what am i aiming for', 'what thickness',
    ]) {
      expect(said(phrase), phrase).toEqual({ kind: 'target' });
    }
  });

  /**
   * "How thick" appears in both a question and a command. The number is the discriminator, so
   * this pair is the one most likely to regress if the rule order is ever shuffled.
   */
  it('separates asking about thickness from setting it', () => {
    expect(said('how thick should i cut')).toEqual({ kind: 'target' });
    expect(said('cut them at six millimetres')).toEqual({ kind: 'setTarget', mm: 6 });
  });

  it('sets the target from every phrasing that carries a number', () => {
    expect(said('make it 5mm')).toEqual({ kind: 'setTarget', mm: 5 });
    expect(said('set the target to four')).toEqual({ kind: 'setTarget', mm: 4 });
    expect(said('aim for two point five')).toEqual({ kind: 'setTarget', mm: 2.5 });
    expect(said('ten millimeters')).toEqual({ kind: 'setTarget', mm: 10 });
  });

  /**
   * A setTarget shape with no number in it. Inventing a thickness would be the exact failure
   * `unknown` exists to prevent, so this must fall through rather than guess.
   */
  it('does not invent a number for "make it thinner"', () => {
    expect(said('make it thinner')).toEqual({ kind: 'unknown', text: 'make it thinner' });
  });

  it('takes the user’s own phrasing as a request for a recipe', () => {
    expect(said('can you cook this up')).toEqual({ kind: 'suggest' });
  });

  it('suggests for the other open-ended phrasings', () => {
    for (const phrase of [
      'what should i make', 'what can i cook', 'what do you suggest',
      'give me another ticket', 'whats next', 'surprise me',
    ]) {
      expect(said(phrase), phrase).toEqual({ kind: 'suggest' });
    }
  });

  it('treats being addressed with nothing after it as an offer to help', () => {
    expect(parseIntent('hey chef')).toEqual({ kind: 'suggest' });
  });

  it('switches tickets by spoken recipe name or id', () => {
    expect(said('give me the tzatziki')).toEqual({ kind: 'setRecipe', id: 'tzatziki' });
    expect(said('lets do quick pickles')).toEqual({ kind: 'setRecipe', id: 'pickles' });
    expect(said('greek salad please')).toEqual({ kind: 'setRecipe', id: 'greek' });
  });

  it('moves the intensity slider to both ends', () => {
    expect(said('go easy on me')).toEqual({ kind: 'setIntensity', intensity: 0 });
    expect(said('calm down')).toEqual({ kind: 'setIntensity', intensity: 0 });
    expect(said('full service')).toEqual({ kind: 'setIntensity', intensity: 1 });
    expect(said('shout at me')).toEqual({ kind: 'setIntensity', intensity: 1 });
  });

  it('always hears a request for quiet, even wrapped in other words', () => {
    expect(said('alright alright shut up')).toEqual({ kind: 'stop' });
    expect(said('quiet please')).toEqual({ kind: 'stop' });
  });

  it('resets and repeats', () => {
    expect(said('start over')).toEqual({ kind: 'reset' });
    expect(said('say that again')).toEqual({ kind: 'repeat' });
  });

  /**
   * The escalation path. `unknown` carries the cleaned text because that is what gets handed
   * to the model, and handing it the raw string would send the wake phrase along with it.
   */
  it('returns unknown with wake-stripped text for anything unmatched', () => {
    expect(said('why is the sky blue')).toEqual({ kind: 'unknown', text: 'why is the sky blue' });
  });

  it('returns null for silence', () => {
    expect(parseIntent('')).toBeNull();
    expect(parseIntent('   ')).toBeNull();
  });
});
