/**
 * Kitchen ranks, earned from a scored session.
 *
 * The scoring module already produces a number between 0 and 1, which is correct and
 * completely unmotivating. "0.73" tells a player nothing about whether that is good, whether
 * anyone does better, or what to aim at next. A rank ladder turns the same number into a thing
 * worth chasing, which is the difference between a measurement and a game.
 *
 * Deliberately named after real kitchen roles rather than bronze/silver/gold. The point of the
 * project is that cooking is a craft with a progression nobody explains, so the ladder should
 * be the one that actually exists in kitchens.
 *
 * Pure: a score in, a rank out. No storage, no clock, no rendering.
 */

import type { Score } from './scoring.js';

export interface Rank {
  readonly id: string;
  readonly title: string;
  /** Lowest total that earns this rank, inclusive. */
  readonly minTotal: number;
  readonly icon: string;
  /** Hex, for the badge. */
  readonly color: string;
  /** One line, shown under the title on the results screen. */
  readonly blurb: string;
}

/**
 * Six tiers, and the gaps widen on purpose.
 *
 * The first two are easy to reach, because a player who scores nothing on their first attempt
 * puts the knife down. The top two are deliberately hard: a booth leaderboard is only
 * interesting if the best row is rare, and a rank everyone gets on their second go is wallpaper.
 */
export const RANKS: readonly Rank[] = [
  { id: 'prep', title: 'Prep Hand', minTotal: 0, icon: '🔪', color: '#8b95a1',
    blurb: 'Everyone starts here. The blade is the easy part.' },
  { id: 'commis', title: 'Commis', minTotal: 0.4, icon: '🥄', color: '#6aa9e0',
    blurb: 'Consistent enough to be trusted with the mise.' },
  { id: 'line', title: 'Line Cook', minTotal: 0.6, icon: '🍳', color: '#8ee06a',
    blurb: 'Fast hands. Now make them repeatable.' },
  { id: 'sous', title: 'Sous Chef', minTotal: 0.75, icon: '⭐', color: '#e0b86a',
    blurb: 'Your slices could go on a plate tonight.' },
  { id: 'chef', title: 'Chef de Partie', minTotal: 0.88, icon: '🏅', color: '#e08a6a',
    blurb: 'Millimetre work, held over a whole session.' },
  { id: 'executive', title: 'Executive Chef', minTotal: 0.96, icon: '👑', color: '#e06a9a',
    blurb: 'Nobody at this table cuts better than you.' },
];

/** The rank a total earns. Never null: the bottom tier starts at zero. */
export function rankFor(total: number): Rank {
  const clamped = Math.min(1, Math.max(0, total));
  // Walk down so the highest qualifying tier wins.
  for (let i = RANKS.length - 1; i >= 0; i -= 1) {
    const rank = RANKS[i];
    if (rank !== undefined && clamped >= rank.minTotal) return rank;
  }
  return RANKS[0] as Rank;
}

export interface RankProgress {
  readonly current: Rank;
  /** Null at the top of the ladder. */
  readonly next: Rank | null;
  /** 0..1 through the current tier. 1 when there is no tier above. */
  readonly fraction: number;
  /** Total still needed for the next rank. Zero at the top. */
  readonly remaining: number;
}

/**
 * How far through the current tier, and what is next.
 *
 * Exists so the results screen can say "0.04 from Sous Chef" rather than just naming what you
 * already got. A ladder you cannot see the next rung of is a label, not a ladder.
 */
export function progressFor(total: number): RankProgress {
  const clamped = Math.min(1, Math.max(0, total));
  const current = rankFor(clamped);
  const index = RANKS.indexOf(current);
  const next = RANKS[index + 1] ?? null;

  if (next === null) return { current, next: null, fraction: 1, remaining: 0 };

  const span = next.minTotal - current.minTotal;
  return {
    current,
    next,
    fraction: span <= 0 ? 1 : Math.min(1, (clamped - current.minTotal) / span),
    remaining: Math.max(0, next.minTotal - clamped),
  };
}

/**
 * A short, specific line about the run, for the results screen.
 *
 * Names the weaker of accuracy and uniformity, because "get better" is not coaching and the two
 * are fixed by different things: accuracy by aiming at the line, uniformity by not rushing.
 */
export function critiqueOf(score: Score, targetMm: number): string {
  if (score.count === 0) return 'No cuts recorded.';

  const off = score.meanMm - targetMm;
  if (score.accuracy < score.uniformity) {
    return off > 0
      ? `Every slice is even, but they run ${off.toFixed(1)}mm thick. Aim smaller.`
      : `Every slice is even, but they run ${Math.abs(off).toFixed(1)}mm thin. Ease off.`;
  }
  return `Your average is on target. The scatter is the problem: ${score.sigmaMm.toFixed(1)}mm between slices.`;
}
