/**
 * One cooking session: the loop that turns frames into coaching, and remembers what happened.
 *
 * Deliberately knows nothing about IWSDK, Three.js, the DOM or OpenCV. It takes already-
 * segmented blobs and returns state, so the same session drives the laptop debug app and the
 * headset with no duplicated logic -- and so it can be tested by handing it fixtures, with no
 * camera, no WASM and no renderer.
 *
 * It owns the only mutable state in the system: the deficit log and the set of confirmed steps.
 * Everything else is recomputed from the current frame, which is why a cook can undo a mistake
 * by simply fixing the board.
 */

import { boardState, type BoardState, type Piece } from '../core/board.js';
import {
  DEFAULT_DIFF_OPTIONS,
  diff,
  isServable,
  topDeficit,
  type Deficit,
  type DiffOptions,
} from '../core/deficit.js';
import type { Recipe } from '../core/recipe.js';
import { processState, type Process } from '../core/steps.js';
import {
  emptyLog,
  finalize,
  observe,
  unresolved,
  type DeficitLog,
  type DeficitSpan,
} from '../core/timeline.js';
import {
  DEFAULT_NAG_POLICY,
  emptyNag,
  faultKey,
  nextInterruption,
  recordInterruption,
  recordSpoke,
  type Interruption,
  type NagPolicy,
  type NagState,
} from '../core/voice/nag.js';
import {
  emptyPraise,
  emptyWatch,
  forgetPraise,
  nextPraise,
  observePraise,
  recordPraise,
  type Praise,
  type PraiseState,
  type PraiseWatch,
} from '../core/voice/praise.js';
import { piecesFrom } from '../vision/pieces.js';
import type { Blob } from '../vision/segment.js';

export interface CoachState {
  readonly board: BoardState;
  readonly deficits: readonly Deficit[];
  readonly process: Process;
  /** The single thing worth saying out loud, or null when the board is correct. */
  readonly top: Deficit | null;
  readonly servable: boolean;
}

export interface SessionOptions {
  /** Pixels per millimetre. Null until the board has been calibrated. */
  readonly pxPerMm: number | null;
  readonly diff: Omit<DiffOptions, 'confirmedSteps'>;
}

export const DEFAULT_SESSION_OPTIONS: SessionOptions = {
  pxPerMm: null,
  diff: {
    maxThicknessCvPct: DEFAULT_DIFF_OPTIONS.maxThicknessCvPct,
    minPiecesForMixCheck: DEFAULT_DIFF_OPTIONS.minPiecesForMixCheck,
  },
};

export class CoachSession {
  private log: DeficitLog = emptyLog();
  private nag: NagState = emptyNag();
  private watch: PraiseWatch = emptyWatch();
  private praised: PraiseState = emptyPraise();
  private readonly confirmed = new Set<string>();
  private startedMs: number | null = null;
  private lastMs = 0;
  private state: CoachState | null = null;

  constructor(
    public readonly recipe: Recipe,
    private options: SessionOptions = DEFAULT_SESSION_OPTIONS,
  ) {}

  /**
   * Folds one observation into the session.
   *
   * `nowMs` is passed in rather than read from a clock so a recorded session can be replayed
   * and produce identical spans -- which is what makes the report testable without a camera,
   * and what would let a demo be rehearsed from a capture if the venue lighting defeats us.
   */
  ingest(blobs: readonly Blob[], nowMs: number): CoachState {
    return this.ingestPieces(piecesFrom(blobs), nowMs);
  }

  /**
   * The same fold, one step further along the pipeline.
   *
   * Exists because the front-of-house app has already named its blobs by the time it reaches
   * here -- `src/menu/vision.ts` segments and identifies in one pass for the on-screen tags --
   * and re-running `piecesFrom` over blobs it has already thrown away is not possible. Naming
   * twice would also be two chances to disagree about what is on the board, which is the kind
   * of split that produces a tag saying "cucumber" beside a chef insisting there is none.
   */
  ingestPieces(pieces: readonly Piece[], nowMs: number): CoachState {
    if (this.startedMs === null) this.startedMs = nowMs;
    this.lastMs = nowMs;

    const board = boardState(pieces, this.options.pxPerMm);
    const deficits = diff(board, this.recipe, {
      ...this.options.diff,
      confirmedSteps: this.confirmed,
    });

    this.log = observe(this.log, nowMs, deficits);

    this.state = {
      board,
      deficits,
      process: processState(this.recipe, deficits, this.confirmed),
      top: topDeficit(deficits),
      servable: isServable(deficits),
    };
    return this.state;
  }

  /**
   * The one thing worth saying out loud UNPROMPTED right now, or null -- which is the usual
   * answer, and is the answer this method is designed to give most of the time.
   *
   * The session is where this belongs because the session already owns the deficit log, and the
   * log is what makes the difference between a flicker and a fault. Everything else --
   * persistence, severity floor, cooldown, not repeating a correction the cook is visibly
   * acting on, the confidence gate that keeps a blind frame from becoming a false accusation --
   * is in `core/voice/nag.ts`, pure and tested against a list of timestamps.
   *
   * Calling this has a side effect ON PURPOSE: a returned interruption is recorded as spoken.
   * The alternative is a caller that has to remember to record it, and the one time somebody
   * forgets, the chef repeats itself every frame in front of a judge.
   *
   * @param confidence from `guidance.observationConfidence`. Pass it honestly; passing 1
   *   unconditionally defeats the only thing standing between this feature and accusing a cook
   *   of forgetting ingredients that are sitting in front of them.
   */
  interruption(
    nowMs: number,
    confidence: number,
    policy: NagPolicy = DEFAULT_NAG_POLICY,
  ): Interruption | null {
    // PERSISTED *AND* STILL TRUE THIS INSTANT. Both halves are needed and neither is enough.
    //
    // `timeline` holds a span open through a grace period after the problem disappears, which
    // is right for the report -- it is what stops one dropped frame turning "you never added
    // the tomato" into forty separate two-second problems. It is wrong for speaking, because
    // inside that grace window a span that is already fixed still reads as open and has by then
    // easily outlasted the persistence threshold. Left unguarded, the chef announces a fault
    // the cook corrected half a second earlier, which is the false-accusation failure wearing a
    // different hat: they look at the board, see it is fine, and stop believing the next one.
    //
    // Caught by `session.test.ts`, not by inspection.
    const present = new Set((this.state?.deficits ?? []).map(faultKey));
    const live = finalize(this.log).filter((span) => present.has(faultKey(span)));

    const hit = nextInterruption(live, this.nag, nowMs, confidence, policy);
    if (hit !== null) this.nag = recordInterruption(this.nag, hit, nowMs);
    return hit;
  }

  /**
   * The one thing worth being PLEASED about right now, or null -- which is, again, the usual
   * answer and the one this method is designed to give most of the time.
   *
   * The mirror of `interruption`, and deliberately built as one. It shares the deficit log, the
   * nag state's clock and the policy; it differs only in being rarer. Everything that decides
   * anything is in `core/voice/praise.ts`, pure, so "the chef congratulated me for nothing" is
   * a bug reproducible from a list of timestamps rather than only from a kitchen.
   *
   * Calling this has the same deliberate side effect as `interruption`: a returned praise is
   * recorded as spoken, in the praise state AND on the shared clock, so the next correction
   * also waits. A caller that had to remember to do that would forget once, in front of a
   * judge, and the chef would congratulate them every frame.
   *
   * ORDER MATTERS AT THE CALL SITE. Ask `interruption` first and only ask this when it returns
   * null: if something is wrong right now, the useful sentence is the correction, and a cook
   * hearing "much steadier" while the tomato is still missing learns that the chef is not
   * actually watching.
   *
   * @param evenness the round's live evenness, 0..1, or null when too little was measured. The
   *   session cannot compute it -- thicknesses are uncalibrated here (DECISIONS.md entry 25) --
   *   so it is passed in rather than guessed at.
   */
  praise(
    nowMs: number,
    confidence: number,
    evenness: number | null,
    policy: NagPolicy = DEFAULT_NAG_POLICY,
    intensity = 1,
  ): Praise | null {
    this.watch = observePraise(
      this.watch,
      {
        spans: finalize(this.log),
        spokenKeys: new Set(Object.keys(this.nag.spokenAtMs)),
        evenness,
        doneCount: this.state?.process.doneCount ?? 0,
        stepCount: this.state?.process.totalCount ?? 0,
        troubled: this.state !== null && !this.state.servable,
      },
      nowMs,
      policy,
    );

    const hit = nextPraise(
      this.watch.pending,
      this.praised,
      this.nag.lastAtMs,
      nowMs,
      confidence,
      { policy, intensity },
    );
    if (hit !== null) {
      this.praised = recordPraise(this.praised, hit, nowMs);
      this.watch = forgetPraise(this.watch, hit.key);
      this.nag = recordSpoke(this.nag, nowMs);
    }
    return hit;
  }

  /** How many times the chef has interrupted, for a status line and for the debrief. */
  get interruptionCount(): number {
    return this.nag.count;
  }

  /** How many times the chef has said something went right. For the debrief. */
  get praiseCount(): number {
    return this.praised.count;
  }

  /** Marks a step the camera cannot check as done. Idempotent. */
  confirm(stepId: string): void {
    this.confirmed.add(stepId);
  }

  /** Undoes a confirmation -- a cook who confirmed the wrong step should not be stuck with it. */
  unconfirm(stepId: string): void {
    this.confirmed.delete(stepId);
  }

  isConfirmed(stepId: string): boolean {
    return this.confirmed.has(stepId);
  }

  /** Recalibration mid-session is expected: the camera gets nudged. */
  setCalibration(pxPerMm: number | null): void {
    this.options = { ...this.options, pxPerMm };
  }

  /** Null before the first frame has been ingested. */
  get current(): CoachState | null {
    return this.state;
  }

  get spans(): readonly DeficitSpan[] {
    return finalize(this.log);
  }

  /** What was still wrong when the cook served. The headline of any honest report. */
  get unresolved(): readonly DeficitSpan[] {
    return unresolved(this.log);
  }

  get elapsedMs(): number {
    return this.startedMs === null ? 0 : this.lastMs - this.startedMs;
  }
}
