/**
 * `parseItems` and `visionConfig`, which are the two places `/api/vision` can be wrong in a way
 * nobody notices until a cook is standing at a counter.
 *
 * The parse is the interesting one. Everything it handles is a real habit of real models rather
 * than a hypothetical: fencing JSON that was asked for unfenced, emitting a `<think>` block
 * first, narrating before answering, returning a count of zero, inventing a category. None of
 * those is worth failing a scan over when the rest of the answer is good, so the parse clamps
 * instead of throwing -- and these tests are what stop that leniency quietly turning into
 * accepting nonsense.
 *
 * The clamps matter more than they look. `count` reaches `pantryFromScan`, which floors it at 1
 * anyway, but a zero arriving here would mean the model saw nothing and said something, and the
 * row should not exist. `confidence` decides whether the counter panel marks a row as a
 * question or a fact, so a fabricated 1.0 would present a guess as certain -- which is the
 * failure the whole confidence column exists to prevent.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { parseItems, visionConfig } from './vision.mjs';

const one = (raw) => {
  const items = parseItems(raw);
  assert.ok(items !== null, 'expected a parse, got null');
  assert.equal(items.length, 1);
  return items[0];
};

describe('parseItems', () => {
  it('reads the shape the prompt asks for', () => {
    const item = one('{"items":[{"ingredient":"tomato","count":3,"category":"vegetable","confidence":0.9}]}');
    assert.deepEqual(item, {
      ingredient: 'tomato', count: 3, category: 'vegetable', confidence: 0.9,
    });
  });

  it('accepts an empty list, which is a real answer and not a failure', () => {
    // A counter with no food on it must not read as a broken scan. `[]` and `null` mean
    // different things downstream: one disables nothing, the other shows an error.
    assert.deepEqual(parseItems('{"items":[]}'), []);
  });

  it('survives a code fence the prompt told it not to use', () => {
    assert.equal(one('```json\n{"items":[{"ingredient":"basil","count":1}]}\n```').ingredient, 'basil');
  });

  it('survives a <think> block before the answer', () => {
    const raw = '<think>Two red round things. Probably tomatoes.</think>'
      + '{"items":[{"ingredient":"tomato","count":2}]}';
    assert.equal(one(raw).count, 2);
  });

  it('finds the object when the model narrates first', () => {
    assert.equal(one('Here is what I can see: {"items":[{"ingredient":"egg","count":4}]}').count, 4);
  });

  it('lower-cases and trims the name, so the pantry matches on it', () => {
    // `pantry.ts` keys on a lower-case name. "  Mozzarella " arriving verbatim would fail to
    // match a recipe requiring "mozzarella" and read to the cook as a missing ingredient.
    assert.equal(one('{"items":[{"ingredient":"  Mozzarella "}]}').ingredient, 'mozzarella');
  });

  it('floors a count of zero at one', () => {
    assert.equal(one('{"items":[{"ingredient":"carrot","count":0}]}').count, 1);
  });

  it('rounds a fractional count', () => {
    // A model saying 2.5 tomatoes is expressing doubt, which belongs in confidence. A
    // fractional tomato would fail an integer requirement for no visible reason.
    assert.equal(one('{"items":[{"ingredient":"tomato","count":2.6}]}').count, 3);
  });

  it('clamps confidence into 0..1', () => {
    assert.equal(one('{"items":[{"ingredient":"salt","confidence":3}]}').confidence, 1);
    assert.equal(one('{"items":[{"ingredient":"salt","confidence":-2}]}').confidence, 0);
  });

  it('defaults a missing confidence to something honest rather than certain', () => {
    const item = one('{"items":[{"ingredient":"curd"}]}');
    assert.equal(item.confidence, 0.5);
    assert.ok(item.confidence < 0.75, 'must land below the confirmation threshold');
  });

  it('replaces an invented category rather than passing it through', () => {
    // `Category` is a closed union in `pantry.ts`. "cheese-like" would flow into the group
    // tinting and the fallback art picker and be wrong in both.
    assert.equal(one('{"items":[{"ingredient":"brie","category":"cheese-like"}]}').category, 'unknown');
  });

  it('drops an item with no usable name', () => {
    // Such a row cannot be shown, matched or corrected -- it would be an anonymous line in the
    // tally that the cook cannot act on.
    assert.deepEqual(parseItems('{"items":[{"count":2},{"ingredient":"leek"}]}').map((i) => i.ingredient), ['leek']);
  });

  it('returns null, not an empty list, when the reply is not JSON at all', () => {
    // The distinction is the whole point: null means "the model failed" and surfaces an error,
    // `[]` means "no food" and surfaces a calm note.
    assert.equal(parseItems('I am unable to help with that.'), null);
    assert.equal(parseItems(''), null);
    assert.equal(parseItems(undefined), null);
  });

  it('returns null when the JSON is well formed but the wrong shape', () => {
    assert.equal(parseItems('{"ingredients":["tomato"]}'), null);
    assert.equal(parseItems('{"items":"tomato"}'), null);
  });
});

describe('visionConfig', () => {
  it('is null with no key, which is how the client knows to disable the control', () => {
    assert.equal(visionConfig({}), null);
    assert.equal(visionConfig({ OPENROUTER_API_KEY: '   ' }), null);
  });

  it('treats a bare upstream NAME as a selector, not a URL', () => {
    // The bug this file was written after: `VISION_UPSTREAM=openrouter` is main's relay
    // convention for choosing an upstream. Read as a URL it produced a 502 that blamed the
    // model for a config string.
    const cfg = visionConfig({ OPENROUTER_API_KEY: 'k', VISION_UPSTREAM: 'openrouter' });
    assert.ok(cfg.upstream.startsWith('https://'), `expected a URL, got ${cfg.upstream}`);
  });

  it('lets an explicit URL override, so a local model can be pointed at', () => {
    const cfg = visionConfig({ OPENROUTER_API_KEY: 'k', VISION_UPSTREAM: 'http://localhost:11434/v1/chat/completions' });
    assert.equal(cfg.upstream, 'http://localhost:11434/v1/chat/completions');
  });

  it('trims the key, because a trailing newline from a .env is invisible and fatal', () => {
    assert.equal(visionConfig({ OPENROUTER_API_KEY: ' k \n' }).apiKey, 'k');
  });
});
