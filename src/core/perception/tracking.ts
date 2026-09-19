import { type Vec3, vec3 } from './types.js';

/**
 * Confirmation and hysteresis over raw per-frame detections.
 *
 * Master spec 10.2, and its own assessment of it: twenty lines, disproportionate payoff, build
 * this before anything cosmetic. Raw detections flicker -- a model that is 62% sure this frame
 * is 58% sure the next -- and flicker is the single thing that makes a computer-vision demo
 * read as broken. A ring that blinks is worse than no ring, because a judge cannot tell whether
 * the system saw the object or not, and stops believing any of it.
 *
 * The cure is asymmetry, and note that it runs the OPPOSITE way to the cut detector in
 * `track.ts`. There, a false positive is written permanently into a score, so detection is slow
 * to confirm and cheap to miss. Here nothing is scored: a label that appears a third of a
 * second late costs nothing, while one that vanishes and returns is the failure. So appearing
 * is slow and DISAPPEARING IS SLOWER. Both are asymmetric; they lean opposite ways because the
 * costs do.
 */

export interface TrackOptions {
  /** Consecutive hits before a candidate becomes visible. */
  readonly spawnConfirmFrames: number;
  /** Consecutive misses before a live track is dropped. */
  readonly despawnMissFrames: number;
  /** Confidence a detection needs to count as a hit at all. */
  readonly confSpawn: number;
  /** Confidence a live track is allowed to fall to before it is dropped. */
  readonly confDespawn: number;
  /** Same label within this distance in world space is the same object. */
  readonly assocRadiusM: number;
  /** Position smoothing. 0 is frozen, 1 is no smoothing at all. */
  readonly emaAlpha: number;
}

/** Master spec 10.2, verbatim. */
export const DEFAULT_TRACK_OPTIONS: TrackOptions = {
  spawnConfirmFrames: 3,
  despawnMissFrames: 5,
  confSpawn: 0.6,
  confDespawn: 0.35,
  assocRadiusM: 0.08,
  emaAlpha: 0.3,
};

export interface Tracked {
  readonly id: string;
  readonly label: string;
  readonly position: Vec3;
  readonly confidence: number;
  readonly hitStreak: number;
  readonly missStreak: number;
  /** False until `spawnConfirmFrames` is met. Only live tracks should be rendered. */
  readonly live: boolean;
}

/** One frame's associated input: a label, where it is, and how sure the provider was. */
export interface Sighting {
  readonly label: string;
  readonly position: Vec3;
  readonly confidence: number;
}

export interface TrackerState {
  readonly tracks: readonly Tracked[];
  readonly nextId: number;
}

export const emptyTracker = (): TrackerState => ({ tracks: [], nextId: 1 });

const distance = (a: Vec3, b: Vec3): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const ema = (prev: Vec3, next: Vec3, alpha: number): Vec3 => vec3(
  prev.x + (next.x - prev.x) * alpha,
  prev.y + (next.y - prev.y) * alpha,
  prev.z + (next.z - prev.z) * alpha,
);

/**
 * Folds one frame of sightings into the tracker.
 *
 * Association is nearest-first within the radius, and each existing track may claim at most one
 * sighting per frame. Greedy rather than optimal (no Hungarian assignment) because at the
 * densities this runs at -- a handful of objects on a board, tens of centimetres apart, against
 * an 8cm radius -- the two agree, and the optimal version is fifty lines that would need their
 * own tests to be worth trusting.
 */
export function ingest(
  state: TrackerState,
  sightings: readonly Sighting[],
  opts: TrackOptions = DEFAULT_TRACK_OPTIONS,
): TrackerState {
  const claimed = new Set<number>();
  const updated: Tracked[] = [];
  let nextId = state.nextId;

  for (const track of state.tracks) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < sightings.length; i++) {
      if (claimed.has(i)) continue;
      const s = sightings[i]!;
      if (s.label !== track.label) continue;
      if (s.confidence < opts.confSpawn) continue;
      const d = distance(track.position, s.position);
      if (d <= opts.assocRadiusM && d < bestDistance) {
        bestDistance = d;
        bestIndex = i;
      }
    }

    if (bestIndex === -1) {
      const missStreak = track.missStreak + 1;
      // A live track survives its own confidence decaying; it is dropped on absence, or on
      // falling under the lower threshold. Two thresholds, so the band between them is where a
      // wobbling detector lives without the display noticing.
      const dropped = missStreak >= opts.despawnMissFrames
        || track.confidence < opts.confDespawn;
      if (!dropped) {
        updated.push({ ...track, missStreak, hitStreak: 0 });
      }
      continue;
    }

    claimed.add(bestIndex);
    const s = sightings[bestIndex]!;
    const hitStreak = track.hitStreak + 1;
    updated.push({
      ...track,
      position: ema(track.position, s.position, opts.emaAlpha),
      confidence: track.confidence + (s.confidence - track.confidence) * opts.emaAlpha,
      hitStreak,
      missStreak: 0,
      live: track.live || hitStreak >= opts.spawnConfirmFrames,
    });
  }

  for (let i = 0; i < sightings.length; i++) {
    if (claimed.has(i)) continue;
    const s = sightings[i]!;
    if (s.confidence < opts.confSpawn) continue;
    updated.push({
      id: `t${nextId++}`,
      label: s.label,
      position: s.position,
      confidence: s.confidence,
      hitStreak: 1,
      missStreak: 0,
      live: opts.spawnConfirmFrames <= 1,
    });
  }

  return { tracks: updated, nextId };
}

/** What should actually be drawn. Candidates still proving themselves are not shown. */
export const liveTracks = (state: TrackerState): readonly Tracked[] =>
  state.tracks.filter((t) => t.live);
