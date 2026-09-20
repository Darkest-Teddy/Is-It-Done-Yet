/**
 * The coach layer: what happens to a model's answer between the upstream and the headset.
 *
 * Every fixture here is a string a model plausibly emits -- fenced JSON, a coerced number, an
 * invented rubric item, an outright refusal. The rule the file defends is that none of them can
 * reach the deterministic scorer as anything other than a valid observation or nothing at all.
 */

import { describe, expect, it } from 'vitest';

import { analyze, checkIngredients, extractJson, scanRecipe } from '../src/coach.js';
import { UNITS } from '../src/config.js';
import { fakeLlm } from './helpers.js';

const RUBRIC = ['onion diced evenly', 'pan is hot enough'];
const input = { imageDataUri: 'data:image/jpeg;base64,AAAA', recipeTitle: 'Test', stepText: 'Dice the onion', rubricItems: RUBRIC, hot: true, knife: true };

describe('extractJson', () => {
  it('parses plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON inside a markdown fence', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses JSON with prose in front of it', () => {
    expect(extractJson('Sure! Here you go:\n{"a":1}')).toEqual({ a: 1 });
  });

  it('returns null rather than throwing on garbage', () => {
    expect(extractJson('I cannot see the pan.')).toBe(null);
    expect(extractJson('{not json at all')).toBe(null);
    expect(extractJson('')).toBe(null);
  });
});

describe('analyze', () => {
  it('passes a well-formed answer through', async () => {
    const llm = fakeLlm([JSON.stringify({
      observations: [
        { item: RUBRIC[0], status: 'ok', evidence: 'even 4mm dice', confidence: 0.8 },
        { item: RUBRIC[1], status: 'warn', evidence: 'no shimmer yet', confidence: 0.6 },
      ],
      coachLine: 'Give it thirty more seconds.',
      unsure: false,
    })]);
    const result = await analyze(llm, input);
    expect(result.offline).toBe(false);
    expect(result.observations).toHaveLength(2);
    expect(result.coachLine).toBe('Give it thirty more seconds.');
    expect(result.unsure).toBe(false);
  });

  it('sends the image as an image_url part and the rubric as text', async () => {
    const llm = fakeLlm(['{"observations":[],"unsure":true}']);
    await analyze(llm, input);
    const parts = llm.calls[0].messages[1].content;
    expect(parts.find((p) => p.type === 'image_url').image_url.url).toBe(input.imageDataUri);
    expect(parts.find((p) => p.type === 'text').text).toMatch(/onion diced evenly/);
  });

  /**
   * The observation that would score against the wrong rule. A model that renames an item is
   * more dangerous than one that invents a new one, because the rename looks plausible.
   */
  it('drops an observation naming an item that was not asked about', async () => {
    const llm = fakeLlm([JSON.stringify({
      observations: [
        { item: RUBRIC[0], status: 'ok', evidence: 'fine', confidence: 0.9 },
        { item: 'the onion is diced evenly', status: 'bad', evidence: 'ragged', confidence: 0.9 },
      ],
      unsure: false,
    })]);
    const result = await analyze(llm, input);
    expect(result.observations.map((o) => o.item)).toEqual([RUBRIC[0]]);
  });

  it('coerces a stringified confidence rather than rejecting the answer', async () => {
    const llm = fakeLlm([JSON.stringify({
      observations: [{ item: RUBRIC[0], status: 'ok', evidence: 'fine', confidence: '0.75' }],
      unsure: false,
    })]);
    const result = await analyze(llm, input);
    expect(result.observations[0].confidence).toBeCloseTo(0.75);
  });

  it('raises unsure when most observations are unknown, whatever the model claimed', async () => {
    const llm = fakeLlm([JSON.stringify({
      observations: [
        { item: RUBRIC[0], status: 'unknown', evidence: 'out of frame', confidence: 0.2 },
        { item: RUBRIC[1], status: 'unknown', evidence: 'blurred', confidence: 0.2 },
      ],
      unsure: false,
    })]);
    expect((await analyze(llm, input)).unsure).toBe(true);
  });

  it('raises unsure when nothing survived', async () => {
    const llm = fakeLlm(['{"observations":[],"unsure":false}']);
    expect((await analyze(llm, input)).unsure).toBe(true);
  });

  it('rejects a status outside the four legal strings', async () => {
    const llm = fakeLlm([JSON.stringify({
      observations: [{ item: RUBRIC[0], status: 'OK!', evidence: 'fine', confidence: 0.9 }],
      unsure: false,
    })]);
    const result = await analyze(llm, input);
    expect(result).toMatchObject({ offline: true, reason: 'invalid_shape', observations: [] });
  });

  it('goes offline, not 500, when the upstream throws', async () => {
    const llm = fakeLlm([new Error('upstream 503')]);
    const result = await analyze(llm, input);
    expect(result).toMatchObject({ offline: true, unsure: true, reason: 'upstream_unavailable', observations: [] });
  });

  it('goes offline when the model answers in prose', async () => {
    const llm = fakeLlm(["I can't see a pan in this photo."]);
    expect(await analyze(llm, input)).toMatchObject({ offline: true, reason: 'unparseable' });
  });

  it('normalises an empty coachLine to null', async () => {
    const llm = fakeLlm([JSON.stringify({ observations: [{ item: RUBRIC[0], status: 'ok', evidence: '', confidence: 1 }], coachLine: '', unsure: false })]);
    expect((await analyze(llm, input)).coachLine).toBe(null);
  });

  it('tells the model it cannot measure temperature', async () => {
    const llm = fakeLlm(['{"observations":[],"unsure":true}']);
    await analyze(llm, input);
    expect(llm.calls[0].messages[0].content).toMatch(/cannot measure temperature/i);
  });
});

describe('scanRecipe', () => {
  const draft = {
    title: 'Tomato Salad',
    servings: 2,
    tags: ['salad'],
    ingredients: [{ name: 'tomato', quantity: 3, unit: 'piece' }],
    steps: [{ order: 0, text: 'Slice the tomatoes', hot: false, knife: true }],
    confidence: 0.9,
    unreadable: [],
  };

  it('returns a draft, and does not claim to have saved anything', async () => {
    const result = await scanRecipe(fakeLlm([JSON.stringify(draft)]), { imageDataUri: 'data:image/png;base64,AA', units: UNITS });
    expect(result.ok).toBe(true);
    expect(result.draft.title).toBe('Tomato Salad');
    expect(result).not.toHaveProperty('id');
  });

  it('coerces a unit it does not recognise to "piece" rather than failing the whole card', async () => {
    const odd = { ...draft, ingredients: [{ name: 'flour', quantity: 2, unit: 'handfuls' }] };
    const result = await scanRecipe(fakeLlm([JSON.stringify(odd)]), { imageDataUri: 'data:image/png;base64,AA', units: UNITS });
    expect(result.ok).toBe(true);
    expect(result.draft.ingredients[0].unit).toBe('piece');
  });

  it('reports what the model could not read', async () => {
    const partial = { ...draft, unreadable: ['the quantity on line 3'] };
    const result = await scanRecipe(fakeLlm([JSON.stringify(partial)]), { imageDataUri: 'data:image/png;base64,AA', units: UNITS });
    expect(result.draft.unreadable).toEqual(['the quantity on line 3']);
  });

  it('rejects a card with no ingredients', async () => {
    const empty = { ...draft, ingredients: [] };
    const result = await scanRecipe(fakeLlm([JSON.stringify(empty)]), { imageDataUri: 'data:image/png;base64,AA', units: UNITS });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_shape' });
  });

  it('goes offline when the upstream fails', async () => {
    const result = await scanRecipe(fakeLlm([new Error('timeout')]), { imageDataUri: 'data:image/png;base64,AA', units: UNITS });
    expect(result).toMatchObject({ ok: false, offline: true });
  });
});

describe('checkIngredients', () => {
  const wanted = ['tomato', 'onion'];
  const args = { imageDataUri: 'data:image/jpeg;base64,AA', wanted };

  it('returns one entry per requested item', async () => {
    const llm = fakeLlm([JSON.stringify({
      found: [
        { name: 'tomato', present: true, confidence: 0.9, evidence: 'three on the board' },
        { name: 'onion', present: false, confidence: 0.8, evidence: 'none visible' },
      ],
      unsure: false,
    })]);
    const result = await checkIngredients(llm, args);
    expect(result.found.map((f) => f.name)).toEqual(wanted);
    expect(result.offline).toBe(false);
  });

  it('drops an item nobody asked about', async () => {
    const llm = fakeLlm([JSON.stringify({
      found: [
        { name: 'tomato', present: true, confidence: 0.9, evidence: 'yes' },
        { name: 'garlic', present: true, confidence: 0.9, evidence: 'invented' },
      ],
      unsure: false,
    })]);
    expect((await checkIngredients(llm, args)).found.map((f) => f.name)).toEqual(['tomato']);
  });

  it('is unsure when nothing survived', async () => {
    expect((await checkIngredients(fakeLlm(['{"found":[],"unsure":false}']), args)).unsure).toBe(true);
  });

  it('goes offline when the upstream fails', async () => {
    const result = await checkIngredients(fakeLlm([new Error('429')]), args);
    expect(result).toMatchObject({ offline: true, unsure: true, found: [] });
  });
});
