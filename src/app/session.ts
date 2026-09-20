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

import { boardState, type BoardState } from '../core/board.js';
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
    if (this.startedMs === null) this.startedMs = nowMs;
    this.lastMs = nowMs;

    const board = boardState(piecesFrom(blobs), this.options.pxPerMm);
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
