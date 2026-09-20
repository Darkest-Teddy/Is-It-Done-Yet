import { describe, expect, it } from 'vitest';

import type { Piece } from '../core/board.js';
import type { Recipe } from '../core/recipe.js';
import { observationConfidence } from '../core/voice/guidance.js';
import { FULL_SERVICE_POLICY, mutedPolicy, type NagPolicy } from '../core/voice/nag.js';
import { CoachSession } from './session.js';

/**
 * The autonomous half, end to end through the layers it actually runs through:
 * pieces -> `boardState` -> `diff` -> `timeline` -> `nag`.
 *
 * Every layer is separately tested; what these cover is the wiring, which is where the chef
 * either interrupts correctly or turns into a smoke alarm. Deterministic, with `nowMs` passed
 * in, so an over-talkative chef is diagnosable from a terminal rather than from a headset.
 */

const RECIPE: Recipe = {
  id: 'test-salad',
  name: 'Test Salad',
  description: 'Two things in a bowl.',
  difficulty: 'easy',
  averageMinutes: 5,
  icon: '🥗',
  tags: [],
  requires: [
    { ingredient: 'tomato', count: { min: 1, max: 3 } },
    { ingredient: 'cucumber', count: { min: 1, max: 3 } },
  ],
  steps: [
    { id: 'tomato', instruction: 'Slice a tomato', verifiable: 'vision', satisfies: ['tomato'] },
    { id: 'cucumber', instruction: 'Slice a cucumber', verifiable: 'vision', satisfies: ['cucumber'] },
  ],
  minMixRatio: 0,
};

const piece = (ingredient: string, n: number): Piece => ({
  ingredient,
  confidence: 0.9,
  areaPx: 900,
  centroid: { x: 100 + n * 30, y: 100 },
  minorPx: 20,
});

/** A board with tomato on it and no cucumber. One real, blocking, measurable fault. */
const TOMATO_ONLY: Piece[] = [piece('tomato', 0), piece('tomato', 1), piece('tomato', 2)];

const SURE = 0.9;

describe('CoachSession.interruption', () => {
  it('stays quiet while the fault is younger than the persistence window', () => {
    const session = new CoachSession(RECIPE);
    session.ingestPieces(TOMATO_ONLY, 0);
    expect(session.interruption(1000, SURE, FULL_SERVICE_POLICY)).toBeNull();
  });

  it('speaks up once the fault has stood, and names the measured thing', () => {
    const session = new CoachSession(RECIPE);
    for (let t = 0; t <= 5000; t += 500) session.ingestPieces(TOMATO_ONLY, t);

    const hit = session.interruption(5000, SURE, FULL_SERVICE_POLICY);
    expect(hit).not.toBeNull();
    expect(hit?.instruction).toContain('cucumber');
    expect(hit?.severity).toBe('blocking');
    expect(session.interruptionCount).toBe(1);
  });

  /** The cook is reaching for the cucumber. The fault is still open. Do not say it again. */
  it('does not repeat itself while the cook is acting on it', () => {
    const session = new CoachSession(RECIPE);
    for (let t = 0; t <= 5000; t += 500) session.ingestPieces(TOMATO_ONLY, t);
    expect(session.interruption(5000, SURE, FULL_SERVICE_POLICY)).not.toBeNull();

    for (let t = 5500; t <= 40_000; t += 500) {
      session.ingestPieces(TOMATO_ONLY, t);
      expect(session.interruption(t, SURE, FULL_SERVICE_POLICY), `at ${t}ms`).toBeNull();
    }
    expect(session.interruptionCount).toBe(1);
  });

  it('never mentions a fault the cook has fixed', () => {
    const session = new CoachSession(RECIPE);
    for (let t = 0; t <= 2000; t += 500) session.ingestPieces(TOMATO_ONLY, t);

    const fixed = [...TOMATO_ONLY, piece('cucumber', 0), piece('cucumber', 1)];
    for (let t = 2500; t <= 20_000; t += 500) {
      session.ingestPieces(fixed, t);
      expect(session.interruption(t, SURE, FULL_SERVICE_POLICY), `at ${t}ms`).toBeNull();
    }
  });

  /**
   * THE FAILURE THIS WHOLE GATE EXISTS FOR. An empty board makes `diff` report every
   * requirement missing at blocking severity, so a hand over the lens would otherwise become
   * the chef announcing two forgotten ingredients that are sitting in front of the cook.
   */
  it('says nothing at all when the camera saw an empty board', () => {
    const session = new CoachSession(RECIPE);
    for (let t = 0; t <= 20_000; t += 500) {
      session.ingestPieces([], t);
      const confidence = observationConfidence({
        cameraLive: true, pieceCount: 0, meanPieceConfidence: 0, ageMs: 0,
      });
      expect(confidence).toBe(0);
      expect(session.interruption(t, confidence, FULL_SERVICE_POLICY), `at ${t}ms`).toBeNull();
    }
    // The faults are genuinely all there -- it is the speaking that is refused, not the seeing.
    expect(session.current?.deficits.length).toBeGreaterThan(0);
  });

  it('is completely silent when the cook has muted it, however bad the board', () => {
    const session = new CoachSession(RECIPE);
    for (let t = 0; t <= 60_000; t += 500) {
      session.ingestPieces(TOMATO_ONLY, t);
      expect(session.interruption(t, 1, mutedPolicy()), `at ${t}ms`).toBeNull();
    }
    expect(session.interruptionCount).toBe(0);
  });

  /** One thing at a time, across a whole simulated round rather than in a single call. */
  it('interrupts at most a handful of times across ninety seconds of a wrong board', () => {
    const session = new CoachSession(RECIPE);
    let spoken = 0;
    for (let t = 0; t <= 90_000; t += 200) {
      session.ingestPieces(TOMATO_ONLY, t);
      if (session.interruption(t, SURE, FULL_SERVICE_POLICY) !== null) spoken += 1;
    }
    // 450 analysed frames, one standing fault. Anything above single digits is a smoke alarm.
    expect(spoken).toBeGreaterThan(0);
    expect(spoken).toBeLessThanOrEqual(3);
  });
});

describe('CoachSession.ingestPieces', () => {
  it('produces the same state the blob path would, one step further along', () => {
    const session = new CoachSession(RECIPE);
    const state = session.ingestPieces(TOMATO_ONLY, 0);
    expect(state.board.pieceCount).toBe(3);
    expect(state.deficits.some((d) => d.ingredient === 'cucumber')).toBe(true);
    expect(state.servable).toBe(false);
  });
});


/**
 * The other half of the autonomous watch: the chef noticing something went right.
 *
 * Driven exactly as `src/menu/guidance.ts` drives it -- ingest every frame, ask for a
 * correction first, ask for praise only when there is none -- because the bug this feature is
 * most likely to have is not in either function but in the order and the cadence they are
 * called at, and a test that calls `praise` once by hand would not see it.
 */
describe('CoachSession.praise', () => {
  interface Spoken { readonly atMs: number; readonly what: string }

  /** Tomato only until 5.5s, then the cucumber arrives and the dish is correct. */
  function runRound(opts: {
    readonly policy: NagPolicy;
    readonly confidence: number;
    /** False models a chef that never corrected anything -- SILENT, or simply lucky. */
    readonly complain: boolean;
  }): { readonly spoken: readonly Spoken[]; readonly session: CoachSession } {
    const session = new CoachSession(RECIPE);
    const spoken: Spoken[] = [];

    for (let t = 0; t <= 30_000; t += 500) {
      const pieces = t < 5500 ? TOMATO_ONLY : [...TOMATO_ONLY, piece('cucumber', 0)];
      session.ingestPieces(pieces, t);

      if (opts.complain) {
        const hit = session.interruption(t, opts.confidence, opts.policy);
        if (hit !== null) {
          spoken.push({ atMs: t, what: `correction:${hit.key}` });
          continue;
        }
      }
      const well = session.praise(t, opts.confidence, null, opts.policy);
      if (well !== null) spoken.push({ atMs: t, what: `praise:${well.kind}` });
    }
    return { spoken, session };
  }

  const FULL = { policy: FULL_SERVICE_POLICY, confidence: SURE, complain: true };

  it('corrects, then is pleased once the cook has fixed it', () => {
    const { spoken } = runRound(FULL);
    expect(spoken.map((s) => s.what)).toEqual([
      'correction:ingredient-missing:cucumber',
      'praise:resolved',
    ]);
  });

  it('waits out the chef\'s own cooldown rather than replying to itself', () => {
    const { spoken } = runRound(FULL);
    const correction = spoken[0]!;
    const praise = spoken[1]!;
    expect(praise.atMs - correction.atMs).toBeGreaterThanOrEqual(FULL_SERVICE_POLICY.cooldownMs);
  });

  it('says one thing and then stops, however much went right', () => {
    const { spoken, session } = runRound(FULL);
    // The steps also completed cleanly in this round. That is a second piece of good news and
    // it is deliberately never spoken: it goes stale inside the cooldown that follows the
    // first, which is the whole of the rate limit doing its job.
    expect(spoken.filter((s) => s.what.startsWith('praise'))).toHaveLength(1);
    expect(session.praiseCount).toBe(1);
  });

  it('SAYS NOTHING about a fault it never mentioned, which is the occlusion guard', () => {
    // A hand across the lens opens every requirement as missing and closes them all when it
    // moves. Read naively that is a cook heroically fixing four things at once.
    const { spoken } = runRound({ ...FULL, complain: false });
    expect(spoken.map((s) => s.what)).not.toContain('praise:resolved');
  });

  it('congratulates nobody while it cannot see the board', () => {
    const blind = observationConfidence({
      cameraLive: true, pieceCount: 0, meanPieceConfidence: 0.9, ageMs: 0,
    });
    expect(runRound({ ...FULL, confidence: blind }).spoken).toEqual([]);
  });

  it('is silent when the chef is, because SILENT has to mean silent', () => {
    const { spoken, session } = runRound({ ...FULL, policy: mutedPolicy() });
    expect(spoken).toEqual([]);
    expect(session.praiseCount).toBe(0);
  });
});
