/**
 * The boundary between what the camera saw and what the coach reasons about.
 *
 * `segment` produces blobs with no idea what they are; `identify` names them; `boardState`
 * aggregates. This file is the one place those three meet, and it is deliberately thin -- all
 * the judgement lives in `src/core`, which is testable without OpenCV.
 *
 * Blobs that cannot be confidently named are dropped rather than guessed at. `identify`
 * already refuses ambiguous matches, and passing an unnamed blob through as some best-effort
 * label would put a flickering ingredient in the tally, which reads to the cook as the board
 * changing when it has not.
 */

import type { Piece } from '../core/board.js';
import { identify, type IngredientProfile, PROFILES } from '../core/ingredients.js';
import type { Blob } from './segment.js';

export interface PieceOptions {
  readonly minConfidence: number;
  readonly minMargin: number;
  readonly profiles: readonly IngredientProfile[];
}

export const DEFAULT_PIECE_OPTIONS: PieceOptions = {
  minConfidence: 0.35,
  minMargin: 1.5,
  profiles: PROFILES,
};

/** Names each blob, dropping the ones no profile claims clearly. */
export function piecesFrom(
  blobs: readonly Blob[],
  opts: PieceOptions = DEFAULT_PIECE_OPTIONS,
): Piece[] {
  const pieces: Piece[] = [];

  for (const blob of blobs) {
    const named = identify(blob.features, opts.minConfidence, opts.minMargin, opts.profiles);
    if (named === null) continue;

    pieces.push({
      ingredient: named.name,
      confidence: named.confidence,
      areaPx: blob.areaPx,
      centroid: blob.centroid,
      // The oriented rect's minor axis is the slice thickness: for a half-moon of cucumber the
      // major axis is its diameter and the minor is how thick it was cut. Using the bounding
      // box instead would make thickness depend on how the slice happens to lie on the board.
      minorPx: blob.rect.minorPx,
    });
  }

  return pieces;
}

/**
 * Pixels per millimetre, from a reference of known real width.
 *
 * Everything in millimetres downstream depends on this one number, so it is taken explicitly
 * rather than guessed from the frame. Returns null for nonsense input instead of an Infinity
 * or a NaN that would propagate silently into every thickness on the board -- `boardState`
 * treats null as "uncalibrated" and reports no millimetres at all, which is the honest output.
 *
 * Calibrate against something rigid and always in shot: the board's own edge, or a printed
 * marker taped to it. Re-run it whenever the camera moves.
 */
export function calibrate(referencePx: number, referenceMm: number): number | null {
  if (!Number.isFinite(referencePx) || !Number.isFinite(referenceMm)) return null;
  if (referencePx <= 0 || referenceMm <= 0) return null;
  return referencePx / referenceMm;
}
