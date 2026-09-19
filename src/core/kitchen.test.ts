import { describe, expect, it } from 'vitest';
import type { DeficitKind } from './deficit.js';
import { bowlFrom, countOf, DEFAULT_RULES, faults, type CookAction, type KitchenRules } from './kitchen.js';

const RULES: KitchenRules = {
  ...DEFAULT_RULES,
  seasonings: [{ seasoning: 'salt', pinches: { min: 2, max: 5 } }],
  dressingMlPerPiece: { min: 1.5, max: 4 },
  toss: { seconds: { min: 6, max: 20 } },
  rest: { seconds: { min: 0, max: 120 } },
  mustWash: ['lettuce'],
  mustDry: ['lettuce'],
  bowlCapacityPieces: 40,
  servePromptlyWithinSec: 180,
  buildOrder: ['lettuce', 'cucumber', 'tomato'],
};

/** A session that does everything right, so each test can break exactly one thing. */
const goodRun = (): CookAction[] => [
  { kind: 'wash', ingredient: 'lettuce', atMs: 0 },
  { kind: 'dry', ingredient: 'lettuce', atMs: 500 },
  { kind: 'add', ingredient: 'lettuce', count: 6, atMs: 1000 },
  { kind: 'add', ingredient: 'cucumber', count: 6, atMs: 2000 },
  { kind: 'add', ingredient: 'tomato', count: 6, atMs: 3000 },
  { kind: 'season', seasoning: 'salt', amount: 3, atMs: 4000 },
  { kind: 'dress', ml: 40, atMs: 5000 },
  { kind: 'toss', seconds: 10, atMs: 6000 },
  { kind: 'taste', atMs: 7000 },
  { kind: 'serve', atMs: 8000 },
];

const run = (actions: CookAction[], nowMs = 9000): DeficitKind[] =>
  faults(bowlFrom(actions), RULES, nowMs).map((d) => d.kind);

/** Replaces the first action matching a predicate; drops it when `next` is null. */
const edit = (
  actions: CookAction[],
  match: (a: CookAction) => boolean,
  next: CookAction | null,
): CookAction[] =>
  actions.flatMap((a) => (match(a) ? (next === null ? [] : [next]) : [a]));

describe('bowlFrom', () => {
  it('sums repeated additions of the same ingredient', () => {
    const bowl = bowlFrom([
      { kind: 'add', ingredient: 'tomato', count: 2, atMs: 0 },
      { kind: 'add', ingredient: 'tomato', count: 3, atMs: 1 },
    ]);
    expect(countOf(bowl.contents, 'tomato')).toBe(5);
    expect(bowl.totalPieces).toBe(5);
  });

  it('records first-added order, not every addition', () => {
    const bowl = bowlFrom([
      { kind: 'add', ingredient: 'lettuce', count: 1, atMs: 0 },
      { kind: 'add', ingredient: 'tomato', count: 1, atMs: 1 },
      { kind: 'add', ingredient: 'lettuce', count: 1, atMs: 2 },
    ]);
    expect(bowl.order).toEqual(['lettuce', 'tomato']);
  });

  it('accumulates several tossing bouts, because cooks toss and check and toss again', () => {
    const bowl = bowlFrom([
      { kind: 'toss', seconds: 4, atMs: 0 },
      { kind: 'toss', seconds: 5, atMs: 100 },
    ]);
    expect(bowl.tossSeconds).toBe(9);
  });

  it('marks a delicate ingredient crushed only when tossing came after it', () => {
    const crushed = bowlFrom([
      { kind: 'add', ingredient: 'avocado', count: 1, atMs: 0, delicate: true },
      { kind: 'toss', seconds: 8, atMs: 100 },
    ]);
    expect(crushed.crushed).toEqual(['avocado']);

    const folded = bowlFrom([
      { kind: 'toss', seconds: 8, atMs: 0 },
      { kind: 'add', ingredient: 'avocado', count: 1, atMs: 100, delicate: true },
    ]);
    expect(folded.crushed).toEqual([]);
  });

  it('does not treat a robust ingredient as crushable', () => {
    const bowl = bowlFrom([
      { kind: 'add', ingredient: 'carrot', count: 1, atMs: 0 },
      { kind: 'toss', seconds: 8, atMs: 100 },
    ]);
    expect(bowl.crushed).toEqual([]);
  });
});

describe('faults', () => {
  it('finds nothing wrong with a clean run', () => {
    expect(run(goodRun())).toEqual([]);
  });

  it('reports nothing about an empty bowl beyond what is knowable', () => {
    // No pieces in: tossing, tasting and dressing cannot be judged yet.
    const early = run([{ kind: 'wash', ingredient: 'lettuce', atMs: 0 }], 100);
    expect(early).not.toContain('under-mixed');
    expect(early).not.toContain('not-tasted');
  });

  describe('seasoning', () => {
    it('flags no salt at all', () => {
      const found = run(edit(goodRun(), (a) => a.kind === 'season', null));
      expect(found).toContain('seasoning-low');
    });

    it('flags over-salting', () => {
      const found = run(edit(goodRun(), (a) => a.kind === 'season',
        { kind: 'season', seasoning: 'salt', amount: 9, atMs: 4000 }));
      expect(found).toContain('seasoning-high');
    });
  });

  describe('hygiene and prep', () => {
    it('blocks on unwashed produce', () => {
      const actions = edit(goodRun(), (a) => a.kind === 'wash', null);
      const found = faults(bowlFrom(actions), RULES, 9000);
      const unwashed = found.find((d) => d.kind === 'unwashed');
      expect(unwashed?.severity).toBe('blocking');
    });

    it('flags leaves that were never dried, because dressing will not cling', () => {
      expect(run(edit(goodRun(), (a) => a.kind === 'dry', null))).toContain('wet-greens');
    });

    it('does not demand washing an ingredient that is not in the bowl', () => {
      const found = run([
        { kind: 'add', ingredient: 'cucumber', count: 2, atMs: 0 },
        { kind: 'season', seasoning: 'salt', amount: 3, atMs: 1 },
        { kind: 'toss', seconds: 10, atMs: 2 },
        { kind: 'taste', atMs: 3 },
      ]);
      expect(found).not.toContain('unwashed');
      expect(found).not.toContain('wet-greens');
    });
  });

  describe('dressing', () => {
    it('judges dressing as a ratio, so a big bowl needs more', () => {
      const small = bowlFrom([
        { kind: 'add', ingredient: 'cucumber', count: 10, atMs: 0 },
        { kind: 'dress', ml: 25, atMs: 1 },
      ]);
      const big = bowlFrom([
        { kind: 'add', ingredient: 'cucumber', count: 30, atMs: 0 },
        { kind: 'dress', ml: 75, atMs: 1 },
      ]);
      // Same 2.5 ml/piece at very different sizes: both fine.
      const kinds = (b: typeof small) => faults(b, RULES, 100).map((d) => d.kind);
      expect(kinds(small)).not.toContain('over-dressed');
      expect(kinds(big)).not.toContain('over-dressed');
    });

    it('flags a drowned salad', () => {
      expect(run(edit(goodRun(), (a) => a.kind === 'dress',
        { kind: 'dress', ml: 300, atMs: 5000 }))).toContain('over-dressed');
    });

    it('flags dressing poured before everything was in', () => {
      const actions: CookAction[] = [
        ...goodRun().filter((a) => a.kind !== 'dress'),
        { kind: 'dress', ml: 40, atMs: 1500 }, // before tomato went in at 3000
      ];
      expect(run(actions)).toContain('dressed-too-early');
    });

    it('flags a dish dressed long ago and still not served', () => {
      const actions = goodRun().filter((a) => a.kind !== 'serve');
      expect(run(actions, 5000 + 400_000)).toContain('served-late');
    });

    it('does not flag serving late once it has actually been served', () => {
      expect(run(goodRun(), 5000 + 400_000)).not.toContain('served-late');
    });
  });

  describe('tossing', () => {
    it('flags an untossed bowl', () => {
      expect(run(edit(goodRun(), (a) => a.kind === 'toss', null))).toContain('under-mixed');
    });

    it('flags bruising from over-tossing, but only as a craft note', () => {
      const actions = edit(goodRun(), (a) => a.kind === 'toss',
        { kind: 'toss', seconds: 60, atMs: 6000 });
      const over = faults(bowlFrom(actions), RULES, 9000).find((d) => d.kind === 'over-mixed');
      expect(over?.severity).toBe('minor');
    });
  });

  describe('the faults no camera could ever catch', () => {
    it('flags never tasting', () => {
      expect(run(edit(goodRun(), (a) => a.kind === 'taste', null))).toContain('not-tasted');
    });

    it('flags delicate ingredients folded in too early', () => {
      const actions: CookAction[] = [
        ...goodRun().filter((a) => a.kind !== 'toss'),
        { kind: 'add', ingredient: 'avocado', count: 2, atMs: 3500, delicate: true },
        { kind: 'toss', seconds: 10, atMs: 6000 },
      ];
      expect(run(actions)).toContain('delicate-crushed');
    });
  });

  it('flags an overcrowded bowl', () => {
    const actions: CookAction[] = [
      ...goodRun(),
      { kind: 'add', ingredient: 'cucumber', count: 60, atMs: 3500 },
    ];
    expect(run(actions)).toContain('overcrowded');
  });

  it('flags building in the wrong order', () => {
    const actions: CookAction[] = [
      { kind: 'wash', ingredient: 'lettuce', atMs: 0 },
      { kind: 'dry', ingredient: 'lettuce', atMs: 1 },
      { kind: 'add', ingredient: 'tomato', count: 6, atMs: 1000 },
      { kind: 'add', ingredient: 'lettuce', count: 6, atMs: 2000 },
      { kind: 'season', seasoning: 'salt', amount: 3, atMs: 3000 },
      { kind: 'dress', ml: 30, atMs: 4000 },
      { kind: 'toss', seconds: 10, atMs: 5000 },
      { kind: 'taste', atMs: 6000 },
      { kind: 'serve', atMs: 7000 },
    ];
    expect(run(actions)).toContain('wrong-order');
  });

  describe('ranking', () => {
    it('puts a blocking hygiene fault ahead of a craft note', () => {
      const actions = [
        ...edit(goodRun(), (a) => a.kind === 'wash', null),
      ];
      const found = faults(bowlFrom(actions), RULES, 9000);
      expect(found[0]?.kind).toBe('unwashed');
    });

    it('surfaces several independent faults at once', () => {
      const found = run([
        { kind: 'add', ingredient: 'lettuce', count: 6, atMs: 1000 },
        { kind: 'add', ingredient: 'tomato', count: 6, atMs: 2000 },
      ]);
      // Unwashed, undried, unsalted, untossed, untasted — all true simultaneously.
      expect(found).toEqual(expect.arrayContaining([
        'unwashed', 'wet-greens', 'seasoning-low', 'under-mixed', 'not-tasted',
      ]));
    });
  });
});
