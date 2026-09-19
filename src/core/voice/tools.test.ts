import { describe, expect, it } from 'vitest';
import { recipeById, RECIPES } from '../recipes.js';
import type { Score } from '../scoring.js';
import { parseIntent } from './intent.js';
import {
  type GameState, MAX_TARGET_MM, MIN_TARGET_MM, respond, speakableScore,
} from './tools.js';

const score = (count: number, meanMm = 6, sigmaMm = 1): Score => ({
  meanMm, sigmaMm, meanAngleDeg: null,
  accuracy: 0.8, uniformity: 0.7, angleScore: null, total: 0.75, count,
});

/** "Sandwich rounds": 6mm, ±2mm, 6 slices. */
const SANDWICH = recipeById('sandwich')!;

const state = (over: Partial<GameState> = {}): GameState => ({
  score: score(0), recipe: SANDWICH, intensity: 0.5, lastLine: null, ...over,
});

/** Pins `suggest`'s choice so the assertion is about behaviour, not luck. */
const firstOther = () => 0;

describe('speakableScore', () => {
  /**
   * The screen sentence uses "±", which synthesisers read inconsistently and sometimes drop
   * entirely -- turning "6mm ±2mm" into "6mm" and changing what was said.
   */
  it('spells out the tolerance rather than relying on a symbol', () => {
    const line = speakableScore(score(4, 6.1, 1.4), SANDWICH);
    expect(line).toContain('plus or minus');
    expect(line).not.toContain('±');
  });

  it('names the target when nothing has been cut', () => {
    expect(speakableScore(score(0), SANDWICH)).toContain('6 millimetres');
  });

  it('trims trailing zeroes so the chef does not say "six point zero"', () => {
    expect(speakableScore(score(2, 6.0, 1.0), SANDWICH)).toContain('6 millimetres average');
  });
});

describe('respond: reading state', () => {
  it('answers "is it done yet" with completion first, then quality', () => {
    const line = respond(parseIntent('hey chef is it done yet')!, state({ score: score(2) })).line;
    expect(line).toMatch(/^Not yet\. 4 more slices/);
    expect(line).toContain('plus or minus');
  });

  it('says yes once the ticket is filled', () => {
    const line = respond(parseIntent('hey chef is it done yet')!, state({ score: score(6) })).line;
    expect(line).toMatch(/^Yes\./);
  });

  it('counts the last slice in the singular', () => {
    const line = respond(parseIntent('hey chef am i done')!, state({ score: score(5) })).line;
    expect(line).toContain('1 more slice for');
  });

  it('reads the target back with its note', () => {
    const reply = respond(parseIntent('hey chef whats the target')!, state());
    expect(reply.line).toContain('6 millimetres');
    expect(reply.line).toContain(SANDWICH.note);
    expect(reply.effect).toBeNull();
  });
});

describe('respond: changing state', () => {
  it('asks for the target to change, and does not change it itself', () => {
    const before = { ...state() };
    const reply = respond(parseIntent('hey chef make it four millimetres')!, before);
    expect(reply.effect).toEqual({ kind: 'setTarget', mm: 4 });
    // The snapshot handed in is untouched: application is the caller's job.
    expect(before.recipe.targetThicknessMm).toBe(6);
  });

  /**
   * The most damaging failure on this path. A misheard "fifty" silently rescores the whole
   * session against a target nobody asked for, and nothing on screen says it was a mishearing.
   */
  it('refuses a target outside the plausible range rather than accepting it silently', () => {
    for (const mm of [0.5, 50, 100]) {
      const reply = respond({ kind: 'setTarget', mm }, state());
      expect(reply.effect, `${mm}mm`).toBeNull();
      expect(reply.line).toContain('not a slice');
    }
  });

  it('accepts the range boundaries', () => {
    expect(respond({ kind: 'setTarget', mm: MIN_TARGET_MM }, state()).effect)
      .toEqual({ kind: 'setTarget', mm: MIN_TARGET_MM });
    expect(respond({ kind: 'setTarget', mm: MAX_TARGET_MM }, state()).effect)
      .toEqual({ kind: 'setTarget', mm: MAX_TARGET_MM });
  });

  it('switches tickets and reads the new one out', () => {
    const reply = respond(parseIntent('hey chef give me the sunomono')!, state());
    expect(reply.effect).toEqual({ kind: 'setRecipe', id: 'sunomono' });
    expect(reply.line).toContain('Paper thin');
  });

  it('moves the intensity slider', () => {
    expect(respond(parseIntent('hey chef go easy on me')!, state()).effect)
      .toEqual({ kind: 'setIntensity', intensity: 0 });
    expect(respond(parseIntent('hey chef full service')!, state()).effect)
      .toEqual({ kind: 'setIntensity', intensity: 1 });
  });

  it('resets and stops', () => {
    expect(respond({ kind: 'reset' }, state()).effect).toEqual({ kind: 'reset' });
    expect(respond({ kind: 'stop' }, state()).effect).toEqual({ kind: 'stop' });
  });
});

describe('respond: suggesting', () => {
  /** With ten recipes, suggesting the one already in progress would happen a tenth of the time. */
  it('never suggests the ticket already in progress', () => {
    for (const recipe of RECIPES) {
      for (let i = 0; i < RECIPES.length; i++) {
        const reply = respond({ kind: 'suggest' }, state({ recipe }), () => i / RECIPES.length);
        expect(reply.effect, `${recipe.id} @ ${i}`).not.toEqual({
          kind: 'setRecipe', id: recipe.id,
        });
      }
    }
  });

  it('answers the user’s own phrasing with a real ticket', () => {
    const reply = respond(parseIntent('hey chef can you cook this up')!, state(), firstOther);
    expect(reply.effect?.kind).toBe('setRecipe');
    expect(reply.escalate).toBe(false);
  });
});

describe('respond: repeat and escalation', () => {
  it('repeats the last line', () => {
    expect(respond({ kind: 'repeat' }, state({ lastLine: 'Thinner!' })).line).toBe('Thinner!');
  });

  it('admits there is nothing to repeat', () => {
    expect(respond({ kind: 'repeat' }, state()).line).toContain('not said anything');
  });

  /**
   * `unknown` is the only branch worth a network round trip, and it still speaks immediately --
   * silence while a model thinks reads as the microphone being broken.
   */
  it('escalates only for unknown, and still says something meanwhile', () => {
    const reply = respond({ kind: 'unknown', text: 'why is the sky blue' }, state());
    expect(reply.escalate).toBe(true);
    expect(reply.line).not.toBe('');
    expect(reply.effect).toBeNull();
  });

  it('never escalates anything it understood', () => {
    for (const phrase of [
      'is it done yet', 'whats the target', 'make it four millimetres',
      'go easy on me', 'what should i make', 'start over', 'quiet',
    ]) {
      const intent = parseIntent(`hey chef ${phrase}`)!;
      expect(respond(intent, state(), firstOther).escalate, phrase).toBe(false);
    }
  });
});
