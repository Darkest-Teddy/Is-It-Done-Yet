import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRACK_OPTIONS, emptyTracker, ingest, liveTracks,
  type Sighting, type TrackerState, type TrackOptions,
} from './tracking.js';
import { vec3 } from './types.js';

const OPTS: TrackOptions = DEFAULT_TRACK_OPTIONS;

const see = (label: string, x: number, confidence = 0.9): Sighting =>
  ({ label, position: vec3(x, 0, 0), confidence });

/** Feeds the same frame n times. */
function repeat(state: TrackerState, sightings: Sighting[], n: number,
  opts: TrackOptions = OPTS): TrackerState {
  let s = state;
  for (let i = 0; i < n; i++) s = ingest(s, sightings, opts);
  return s;
}

describe('ingest', () => {
  it('does not show a track until it has been seen enough times', () => {
    let s = ingest(emptyTracker(), [see('jar', 0)]);
    expect(liveTracks(s)).toHaveLength(0);
    s = ingest(s, [see('jar', 0)]);
    expect(liveTracks(s)).toHaveLength(0);
    s = ingest(s, [see('jar', 0)]);
    expect(liveTracks(s)).toHaveLength(1);
  });

  it('ignores a detection the model is not confident about', () => {
    const s = repeat(emptyTracker(), [see('jar', 0, 0.4)], 5);
    expect(s.tracks).toHaveLength(0);
  });

  /**
   * The asymmetry, and note it leans the OPPOSITE way to the cut detector in track.ts. There a
   * false positive is written permanently into a score, so detection is slow to confirm. Here
   * nothing is scored and the failure is a label that blinks, so disappearing is the slow half.
   */
  it('keeps a confirmed track alive through a gap that would never have spawned it', () => {
    let s = repeat(emptyTracker(), [see('jar', 0)], 3);
    expect(liveTracks(s)).toHaveLength(1);

    // Four missed frames -- more than the three it took to appear -- and it is still shown.
    s = repeat(s, [], 4);
    expect(liveTracks(s)).toHaveLength(1);

    s = ingest(s, []);
    expect(liveTracks(s)).toHaveLength(0);
  });

  it('associates a moving object to its existing track rather than spawning a second', () => {
    let s = repeat(emptyTracker(), [see('jar', 0)], 3);
    const id = s.tracks[0]!.id;
    // Inside the 8cm association radius.
    s = ingest(s, [see('jar', 0.05)]);
    expect(s.tracks).toHaveLength(1);
    expect(s.tracks[0]!.id).toBe(id);
  });

  it('spawns a second track when the same label appears too far away to be the same object', () => {
    let s = repeat(emptyTracker(), [see('jar', 0)], 3);
    s = ingest(s, [see('jar', 0), see('jar', 1)]);
    expect(s.tracks).toHaveLength(2);
  });

  it('never lets two tracks claim the same sighting', () => {
    let s = repeat(emptyTracker(), [see('jar', 0), see('jar', 1)], 3);
    expect(s.tracks).toHaveLength(2);
    // One sighting, two tracks in range of nothing else: exactly one keeps its streak.
    s = ingest(s, [see('jar', 0.02)]);
    const streaks = s.tracks.map((t) => t.missStreak).sort();
    expect(streaks).toEqual([0, 1]);
  });

  it('smooths position rather than snapping to the newest reading', () => {
    let s = repeat(emptyTracker(), [see('jar', 0)], 3);
    s = ingest(s, [see('jar', 0.04)]);
    // EMA at alpha 0.3, so 30% of the way, not all of it.
    expect(s.tracks[0]!.position.x).toBeCloseTo(0.012, 6);
  });

  it('does not treat a different label at the same place as the same object', () => {
    let s = repeat(emptyTracker(), [see('jar', 0)], 3);
    s = ingest(s, [see('tin', 0)]);
    expect(s.tracks).toHaveLength(2);
  });

  it('assigns each new track a distinct id', () => {
    const s = ingest(emptyTracker(), [see('jar', 0), see('tin', 1)]);
    expect(new Set(s.tracks.map((t) => t.id)).size).toBe(2);
  });

  it('does not mutate the state it was given', () => {
    const before = repeat(emptyTracker(), [see('jar', 0)], 3);
    const snapshot = JSON.stringify(before);
    ingest(before, [see('jar', 0.05)]);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('drops a live track whose confidence decays under the lower threshold', () => {
    let s = repeat(emptyTracker(), [see('jar', 0, 0.95)], 4);
    expect(liveTracks(s)).toHaveLength(1);
    // Sightings under confSpawn do not associate, so the track simply starves.
    s = repeat(s, [see('jar', 0, 0.1)], 5);
    expect(liveTracks(s)).toHaveLength(0);
  });
});
