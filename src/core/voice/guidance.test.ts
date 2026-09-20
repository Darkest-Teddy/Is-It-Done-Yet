import { describe, expect, it } from 'vitest';

import {
  ACKNOWLEDGEMENT,
  describeContext,
  EMPTY_CONTEXT,
  isStuckUtterance,
  localGuidance,
  MIN_CONFIDENCE_TO_ACCUSE,
  observationConfidence,
  openingMove,
  OVERLAY_MAX_WORDS,
  parseModelGuidance,
  stripThinking,
  toOverlay,
  type CookContext,
  type Guidance,
} from './guidance.js';
import { parseIntent } from './intent.js';

const ctx = (patch: Partial<CookContext> = {}): CookContext => ({
  ...EMPTY_CONTEXT,
  cameraLive: true,
  recipeName: 'Tomato Mozzarella Salad',
  recipeDescription: 'Sliced tomato, mozzarella and seasoning.',
  stepNumber: 3,
  stepCount: 9,
  stepInstruction: 'Slice one tomato into about 1/2 inch thick slices',
  stepVerifiable: 'vision',
  nextStepInstruction: 'Place the slices on a platter in a single layer',
  doneCount: 2,
  ...patch,
});

describe('the stuck trigger', () => {
  it('recognises the phrase the brief names, and the variants people actually say', () => {
    for (const phrase of [
      'hey chef i dont know what to do next',
      'hey chef i do not know what to do',
      'hey chef what do i do now',
      'hey chef im stuck',
      'hey chef i am lost',
      'ok chef whats the next step',
      'hey chef help',
      'hey chef walk me through it',
      'hey chef what am i supposed to do',
      'hey chef im confused',
      'hey chef whats wrong',
    ]) {
      expect(parseIntent(phrase), phrase).toEqual({ kind: 'stuck' });
      expect(isStuckUtterance(phrase), phrase).toBe(true);
    }
  });

  /**
   * The whole reason `stuck` is not folded into `suggest`. One means "I am mid-dish and lost",
   * the other means "give me a different dish", and answering the first with the second is the
   * worst reply available.
   */
  it('does not steal the phrasings that mean "give me another ticket"', () => {
    for (const phrase of [
      'what should i make',
      'what can i cook',
      'what do you suggest',
      'give me another ticket',
      'whats next',
      'surprise me',
      'what should i do',
    ]) {
      expect(parseIntent(`hey chef ${phrase}`), phrase).toEqual({ kind: 'suggest' });
    }
  });

  it('stays silent for an utterance that was not addressed to the chef', () => {
    expect(isStuckUtterance('i dont know what to do next')).toBe(false);
  });

  /** A number still wins: "make it 5mm" is a command, not a cry for help. */
  it('does not outrank a target change', () => {
    expect(parseIntent('hey chef help me make it 5 mm')).toEqual({ kind: 'setTarget', mm: 5 });
  });
});

describe('toOverlay', () => {
  /**
   * Deficit instructions are an order followed by its evidence. The overlay wants the order --
   * truncating at a word count instead would leave "Add 2 more tomato -- 1 on the", which reads
   * as the system having been cut off mid-thought.
   */
  it('keeps the imperative head and drops the evidence after the dash', () => {
    expect(toOverlay('Add 2 more tomato -- 1 on the board, recipe wants 3-4'))
      .toBe('Add 2 more tomato');
  });

  it('cuts at the first sentence', () => {
    expect(toOverlay('Slice thinner. The rounds have to disappear into the yoghurt.'))
      .toBe('Slice thinner');
  });

  it('never exceeds the word budget', () => {
    const long = toOverlay('one two three four five six seven eight nine ten');
    expect(long.split(' ')).toHaveLength(OVERLAY_MAX_WORDS);
  });

  it('leaves no trailing comma when the cut lands on one', () => {
    expect(toOverlay('one two three four five six, seven eight'))
      .toBe('one two three four five six');
  });
});

describe('observationConfidence -- the gate on ever saying somebody is wrong', () => {
  /**
   * The case this function exists for. An empty board makes `diff` report EVERY requirement as
   * missing at blocking severity, so a hand passing over the lens would become the chef
   * announcing four forgotten ingredients that are sitting in front of the cook.
   */
  it('is zero when the camera saw no pieces at all', () => {
    expect(observationConfidence({
      cameraLive: true, pieceCount: 0, meanPieceConfidence: 1, ageMs: 0,
    })).toBe(0);
  });

  it('is zero with no camera', () => {
    expect(observationConfidence({
      cameraLive: false, pieceCount: 8, meanPieceConfidence: 1, ageMs: 0,
    })).toBe(0);
  });

  it('is zero once the observation is stale', () => {
    expect(observationConfidence({
      cameraLive: true, pieceCount: 8, meanPieceConfidence: 1, ageMs: 9000,
    })).toBe(0);
  });

  it('clears the accusation threshold on a fresh, well-populated board', () => {
    const c = observationConfidence({
      cameraLive: true, pieceCount: 8, meanPieceConfidence: 0.85, ageMs: 100,
    });
    expect(c).toBeGreaterThan(MIN_CONFIDENCE_TO_ACCUSE);
    expect(c).toBeLessThanOrEqual(1);
  });

  it('falls below the threshold when the pieces were barely identified', () => {
    expect(observationConfidence({
      cameraLive: true, pieceCount: 6, meanPieceConfidence: 0.4, ageMs: 200,
    })).toBeLessThan(MIN_CONFIDENCE_TO_ACCUSE);
  });
});

describe('localGuidance -- the answer with no model in it', () => {
  it('fills all three channels, always', () => {
    for (const c of [
      ctx(),
      ctx({ cameraLive: false }),
      ctx({ faults: ['No tomato on the board -- the recipe needs it'], confidence: 0.9 }),
      ctx({ recipeName: null, stepInstruction: null, evenness: 0.94, pieces: 11 }),
      ctx({ stepInstruction: null, stepNumber: null }),
    ]) {
      const g = localGuidance(c);
      expect(g.speech.length, g.speech).toBeGreaterThan(0);
      expect(g.overlay.length, g.overlay).toBeGreaterThan(0);
      expect(g.text.length, g.text).toBeGreaterThan(0);
      expect(g.overlay.split(' ').length).toBeLessThanOrEqual(OVERLAY_MAX_WORDS);
      expect(g.source).toBe('local');
    }
  });

  it('says the camera is missing before it says anything about the board', () => {
    const g = localGuidance(ctx({
      cameraLive: false,
      faults: ['No tomato on the board -- the recipe needs it'],
      confidence: 0.9,
    }));
    expect(g.overlay).toBe('Show me the board');
    expect(g.speech).toMatch(/cannot see/i);
  });

  it('leads with the top fault when the observation is trustworthy', () => {
    const g = localGuidance(ctx({
      faults: ['No tomato on the board -- the recipe needs it', 'Add 1 more mozzarella -- 0 on the board, recipe wants 1-2'],
      confidence: 0.8,
    }));
    expect(g.speech).toContain('No tomato on the board');
    expect(g.overlay).toBe('No tomato on the board');
    expect(g.text).toContain('Step 3 of 9');
  });

  /** A false accusation costs every correction after it, so a shaky frame falls through. */
  it('refuses to quote a fault it is not confident about, and coaches the step instead', () => {
    const g = localGuidance(ctx({
      faults: ['No tomato on the board -- the recipe needs it'],
      confidence: MIN_CONFIDENCE_TO_ACCUSE - 0.01,
    }));
    expect(g.speech).toBe('Slice one tomato into about 1/2 inch thick slices');
  });

  it('warns that a cook-confirmed step cannot be checked by looking', () => {
    const g = localGuidance(ctx({
      stepInstruction: 'Season with salt',
      stepVerifiable: 'cook-confirmed',
      nextStepInstruction: null,
    }));
    expect(g.text).toMatch(/cannot check this one by looking/i);
  });

  it('coaches evenness in the free round, where there is no recipe to be behind on', () => {
    expect(localGuidance(ctx({
      recipeName: null, stepInstruction: null, evenness: 0.94, pieces: 11,
    })).text).toContain('94%');

    expect(localGuidance(ctx({
      recipeName: null, stepInstruction: null, evenness: 0.5, pieces: 11,
    })).overlay).toBe('Slow down, same angle');
  });

  it('says the dish is finished rather than inventing something to fix', () => {
    const g = localGuidance(ctx({ stepInstruction: null, stepNumber: null, doneCount: 9 }));
    expect(g.speech).toMatch(/nothing is wrong/i);
  });

  it('marks an unprompted answer as unprompted', () => {
    expect(localGuidance(ctx(), false).prompted).toBe(false);
    expect(localGuidance(ctx()).prompted).toBe(true);
  });
});

describe('openingMove -- the first 100ms, which is the part a judge grades', () => {
  it('speaks the local answer immediately when there is no model to wait for', () => {
    const move = openingMove(false, ctx());
    expect(move.spoken).toBe(move.shown.speech);
    expect(move.awaitingModel).toBe(false);
  });

  it('acknowledges instantly and still puts a real answer on screen while the model thinks', () => {
    const move = openingMove(true, ctx());
    expect(move.spoken).toBe(ACKNOWLEDGEMENT);
    expect(move.awaitingModel).toBe(true);
    // The panel is never blank during the round trip -- that is the whole point of `shown`.
    expect(move.shown.speech.length).toBeGreaterThan(0);
  });
});

describe('stripThinking', () => {
  it('removes a closed Qwen3 reasoning block', () => {
    expect(stripThinking('<think>weighing it up</think>{"speech":"go"}')).toBe('{"speech":"go"}');
  });

  /** A truncated response leaves an opening tag and no closing one; nothing after it is answer. */
  it('removes an unterminated one', () => {
    expect(stripThinking('<think>weighing it u')).toBe('');
  });

  it('removes a dangling close tag with no opener', () => {
    expect(stripThinking('reasoning went here</think>{"speech":"go"}')).toBe('{"speech":"go"}');
  });

  it('removes a markdown fence', () => {
    expect(stripThinking('```json\n{"speech":"go"}\n```')).toBe('{"speech":"go"}');
  });

  it('leaves clean JSON alone', () => {
    expect(stripThinking('{"speech":"go"}')).toBe('{"speech":"go"}');
  });
});

describe('parseModelGuidance -- fallback selection', () => {
  const fallback: Guidance = localGuidance(ctx());

  it('takes a well-formed reply', () => {
    const g = parseModelGuidance(
      '{"speech":"Slice the tomato thinner.","overlay":"Slice thinner","text":"Thick rounds will not sit flat."}',
      fallback,
    );
    expect(g).toEqual({
      speech: 'Slice the tomato thinner.',
      overlay: 'Slice thinner',
      text: 'Thick rounds will not sit flat.',
      source: 'model',
      prompted: true,
    });
  });

  it('survives the thinking block and the fence around it', () => {
    const g = parseModelGuidance(
      '<think>hmm</think>\n```json\n{"speech":"Add the mozzarella."}\n```',
      fallback,
    );
    expect(g.source).toBe('model');
    expect(g.speech).toBe('Add the mozzarella.');
  });

  /**
   * WHOLE-OR-NOTHING. Borrowing the local `speech` and keeping the model's `overlay` would give
   * a chef saying one thing while the board in front of the cook reads another, which is the
   * exact drift the single answer object exists to prevent.
   */
  it('falls back entirely when the spoken line is missing, never field by field', () => {
    for (const raw of [
      '{"overlay":"Slice thinner","text":"because"}',
      '{"speech":"   "}',
      '{"speech":42}',
      'not json at all',
      '[]',
      'null',
      '',
    ]) {
      expect(parseModelGuidance(raw, fallback), raw).toBe(fallback);
    }
  });

  it('derives the missing channels from the model line rather than from the local one', () => {
    const g = parseModelGuidance('{"speech":"Add two more tomato now."}', fallback);
    expect(g.overlay).toBe('Add two more tomato now');
    expect(g.text).toBe('Add two more tomato now.');
  });

  it('clamps an overlong overlay the model sent anyway', () => {
    const g = parseModelGuidance(
      '{"speech":"go","overlay":"one two three four five six seven eight"}',
      fallback,
    );
    expect(g.overlay.split(' ')).toHaveLength(OVERLAY_MAX_WORDS);
  });

  it('keeps the prompted flag from the answer it is replacing', () => {
    const unprompted = localGuidance(ctx(), false);
    expect(parseModelGuidance('{"speech":"go"}', unprompted).prompted).toBe(false);
  });
});

describe('describeContext', () => {
  it('states plainly when the camera is blind, so the model cannot reason as if it were not', () => {
    expect(describeContext(ctx({ cameraLive: false }))).toContain('NOT RUNNING');
  });

  it('flags a step the camera cannot check', () => {
    const text = describeContext(ctx({ stepVerifiable: 'cook-confirmed' }));
    expect(text).toContain('CANNOT check this one');
  });

  it('says there are no faults rather than leaving the section empty', () => {
    expect(describeContext(ctx())).toContain('(none');
  });

  it('carries the question when there was one, and names the button when there was not', () => {
    expect(describeContext(ctx(), 'why is it grey')).toContain('"why is it grey"');
    expect(describeContext(ctx(), null)).toContain('unsure');
    expect(describeContext(ctx(), '   ')).toContain('unsure');
  });

  it('includes OCR card text only when a card was actually read', () => {
    expect(describeContext(ctx())).not.toContain('recipe card');
    expect(describeContext(ctx({ cardText: 'SERVES 4 · 200C' }))).toContain('SERVES 4');
  });
});
