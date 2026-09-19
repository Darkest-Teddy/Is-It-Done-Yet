import { describe, expect, it } from 'vitest';
import type { Deficit } from './deficit.js';
import { deficitKey, emptyLog, finalize, observe, unresolved } from './timeline.js';

const deficit = (over: Partial<Deficit> = {}): Deficit => ({
  kind: 'count-short',
  ingredient: 'cucumber',
  observed: 1,
  required: { min: 2, max: 4 },
  severity: 'major',
  magnitude: 0.5,
  instruction: 'Add 1 more cucumber',
  ...over,
});

const GRACE = 1500;

/** Replays a session as [timeMs, deficits] pairs. */
const replay = (steps: readonly [number, Deficit[]][], grace = GRACE) =>
  steps.reduce((log, [t, ds]) => observe(log, t, ds), emptyLog(grace));

describe('deficitKey', () => {
  it('treats the same problem about the same ingredient as one problem', () => {
    expect(deficitKey(deficit({ observed: 1 }))).toBe(deficitKey(deficit({ observed: 3 })));
  });

  it('separates the same problem about different ingredients', () => {
    expect(deficitKey(deficit({ ingredient: 'cucumber' }))).not.toBe(
      deficitKey(deficit({ ingredient: 'tomato' })),
    );
  });

  it('separates different problems about the same ingredient', () => {
    expect(deficitKey(deficit({ kind: 'count-short' }))).not.toBe(
      deficitKey(deficit({ kind: 'cut-too-thick' })),
    );
  });
});

describe('observe', () => {
  it('opens a span the moment a problem appears', () => {
    const log = replay([[0, [deficit()]]]);
    const [span] = finalize(log);
    expect(span?.firstSeenMs).toBe(0);
    expect(span?.clearedMs).toBeNull();
  });

  it('keeps one span while a problem persists rather than opening more', () => {
    const log = replay([
      [0, [deficit()]],
      [500, [deficit()]],
      [1000, [deficit()]],
    ]);
    expect(finalize(log)).toHaveLength(1);
  });

  it('closes a span once the problem has stayed gone past the grace period', () => {
    const log = replay([
      [0, [deficit()]],
      [1000, []],
      [3000, []],
    ]);
    const [span] = finalize(log);
    // Closed at the moment it was last actually seen, not when we noticed it had gone --
    // otherwise every span is reported as lasting a grace period longer than it did.
    expect(span?.clearedMs).toBe(0);
  });

  it('does not close a span for a single dropped frame', () => {
    const log = replay([
      [0, [deficit()]],
      [500, []], // one bad segmentation frame
      [1000, [deficit()]],
    ]);
    const spans = finalize(log);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.clearedMs).toBeNull();
  });

  it('opens a fresh span when a fixed problem genuinely comes back', () => {
    const log = replay([
      [0, [deficit()]],
      [3000, []],
      [6000, [deficit()]],
    ]);
    const spans = finalize(log);
    expect(spans).toHaveLength(2);
    expect(spans[0]?.clearedMs).toBe(0);
    expect(spans[1]?.firstSeenMs).toBe(6000);
  });

  it('refreshes the instruction so the report quotes the latest measurement', () => {
    const log = replay([
      [0, [deficit({ instruction: 'Add 3 more cucumber' })]],
      [1000, [deficit({ instruction: 'Add 1 more cucumber' })]],
    ]);
    expect(finalize(log)[0]?.instruction).toBe('Add 1 more cucumber');
  });

  it('tracks several problems independently', () => {
    const log = replay([
      [0, [deficit({ ingredient: 'cucumber' }), deficit({ ingredient: 'tomato' })]],
      [3000, [deficit({ ingredient: 'tomato' })]],
    ]);
    const spans = finalize(log);
    expect(spans).toHaveLength(2);
    expect(spans.find((s) => s.ingredient === 'cucumber')?.clearedMs).toBe(0);
    expect(spans.find((s) => s.ingredient === 'tomato')?.clearedMs).toBeNull();
  });

  it('records nothing for a session that was never wrong', () => {
    expect(finalize(replay([[0, []], [1000, []]]))).toEqual([]);
  });
});

describe('finalize', () => {
  it('orders spans by when they first appeared', () => {
    const log = replay([
      [0, [deficit({ ingredient: 'cucumber' })]],
      [1000, [deficit({ ingredient: 'cucumber' }), deficit({ ingredient: 'tomato' })]],
    ]);
    expect(finalize(log).map((s) => s.ingredient)).toEqual(['cucumber', 'tomato']);
  });

  it('leaves a still-present problem open rather than closing it at the buzzer', () => {
    const log = replay([[0, [deficit()]], [5000, [deficit()]]]);
    expect(finalize(log)[0]?.clearedMs).toBeNull();
  });
});

describe('unresolved', () => {
  it('returns only what was still wrong when the cook served', () => {
    const log = replay([
      [0, [deficit({ ingredient: 'cucumber' }), deficit({ ingredient: 'tomato' })]],
      [3000, [deficit({ ingredient: 'tomato' })]],
    ]);
    expect(unresolved(log).map((s) => s.ingredient)).toEqual(['tomato']);
  });

  it('is empty when everything was fixed', () => {
    const log = replay([[0, [deficit()]], [3000, []]]);
    expect(unresolved(log)).toEqual([]);
  });
});
