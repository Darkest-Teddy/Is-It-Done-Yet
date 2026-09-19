import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRACK_OPTIONS, emptyTrack, median, observe,
  type TrackBlob, type TrackOptions, type TrackResult, type TrackState,
} from './track.js';

/**
 * Scale is chosen so pixels read as millimetres: a 42mm cucumber 42px across gives 1 mm/px.
 * Every length below can therefore be read as the millimetre figure it stands for.
 */
const OPTS: TrackOptions = { ...DEFAULT_TRACK_OPTIONS, settleFrames: 3, refractoryFrames: 0 };

const stub = (lengthPx: number, diameterPx = 42): TrackBlob =>
  ({ majorPx: lengthPx, minorPx: diameterPx, areaPx: lengthPx * diameterPx, hueDeg: 95 });

/** A disc seen edge-on: long side is the cucumber's diameter, short side is the thickness. */
const slice = (thicknessPx: number, diameterPx = 42): TrackBlob =>
  ({ majorPx: diameterPx, minorPx: thicknessPx, areaPx: diameterPx * thicknessPx, hueDeg: 95 });

/** Feeds the same frame until it settles, returning the last result. */
function hold(
  state: TrackState, blobs: readonly TrackBlob[], frames = OPTS.settleFrames,
  opts: TrackOptions = OPTS,
): TrackResult {
  let result: TrackResult = { ...observe(state, blobs, opts) };
  for (let i = 1; i < frames; i++) result = observe(result.state, blobs, opts);
  return result;
}

describe('median', () => {
  it('is the middle value for odd counts and the mean of the two middles for even', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('ignores a spike that would drag a mean, which is the whole reason it is here', () => {
    // Four good frames and one where a hand clipped the end of the stub.
    expect(median([180, 180, 120, 180, 180])).toBe(180);
  });

  it('is NaN for an empty window rather than 0, which would read as a zero-length stub', () => {
    expect(median([])).toBeNaN();
  });
});

describe('observe', () => {
  it('reports no-stub on an empty frame and keeps the baseline for when it returns', () => {
    const first = hold(emptyTrack(), [stub(180)]);
    expect(first.state.baseline).not.toBeNull();

    const gone = observe(first.state, []);
    expect(gone.rejection).toBe('no-stub');
    expect(gone.stubLengthMm).toBeNull();
    // The window is dropped so pre- and post-occlusion frames cannot be blended...
    expect(gone.state.window).toHaveLength(0);
    // ...but the baseline is what the next settled reading is measured against, so it survives.
    expect(gone.state.baseline).toEqual(first.state.baseline);
  });

  it('settles before it will commit to anything', () => {
    const one = observe(emptyTrack(), [stub(180)], OPTS);
    expect(one.rejection).toBe('settling');
    expect(one.state.baseline).toBeNull();

    const two = observe(one.state, [stub(180)], OPTS);
    expect(two.rejection).toBe('settling');

    const three = observe(two.state, [stub(180)], OPTS);
    expect(three.rejection).toBe('baseline-set');
    expect(three.state.originalLengthMm).toBeCloseTo(180, 6);
  });

  it('refuses to settle while the stub is still moving', () => {
    // Spread well past settleBandMm, so no median is trustworthy yet.
    let r = observe(emptyTrack(), [stub(180)], OPTS);
    r = observe(r.state, [stub(174)], OPTS);
    r = observe(r.state, [stub(168)], OPTS);
    expect(r.rejection).toBe('settling');
    expect(r.state.baseline).toBeNull();
  });

  it('records a cut as the drop in stub length', () => {
    const base = hold(emptyTrack(), [stub(180)]);
    const after = hold(base.state, [stub(174), slice(6)]);

    expect(after.rejection).toBeNull();
    expect(after.cut).not.toBeNull();
    expect(after.cut!.thicknessMm).toBeCloseTo(6, 6);
    expect(after.cut!.method).toBe('stub-delta');
    expect(after.state.recordedMm).toBeCloseTo(6, 6);
  });

  it('does not record the same cut twice while the stub sits still', () => {
    const base = hold(emptyTrack(), [stub(180)]);
    const cut = hold(base.state, [stub(174), slice(6)]);
    expect(cut.cut).not.toBeNull();

    const still = hold(cut.state, [stub(174), slice(6)]);
    expect(still.cut).toBeNull();
    expect(still.rejection).toBe('below-threshold');
  });

  it('holds off for the refractory window after a cut', () => {
    const opts: TrackOptions = { ...OPTS, refractoryFrames: 2 };
    const base = hold(emptyTrack(), [stub(180)], opts.settleFrames, opts);
    const cut = hold(base.state, [stub(174)], opts.settleFrames, opts);
    expect(cut.cut).not.toBeNull();

    const next = observe(cut.state, [stub(168)], opts);
    expect(next.rejection).toBe('refractory');
    expect(next.cut).toBeNull();
  });

  it('ignores a change too small to be a cut', () => {
    const base = hold(emptyTrack(), [stub(180)]);
    const nudged = hold(base.state, [stub(179.5)]);
    expect(nudged.cut).toBeNull();
    expect(nudged.rejection).toBe('below-threshold');
  });

  /**
   * The occlusion case, and the reason settling alone is not enough.
   *
   * A hand resting still across one end of the stub produces a perfectly settled SHORT reading.
   * If that reading becomes the baseline, the recovery that follows looks like the stub growing
   * back. Treating an increase as a baseline correction rather than as a cut is what makes the
   * hand a no-op instead of a phantom 30mm slice.
   */
  it('treats a stub that got longer as a bad baseline, never as a cut', () => {
    const occluded = hold(emptyTrack(), [stub(150)]);
    expect(occluded.state.baseline!.lengthPx).toBeCloseTo(150, 6);

    const recovered = hold(occluded.state, [stub(180)]);
    expect(recovered.cut).toBeNull();
    expect(recovered.rejection).toBe('below-threshold');
    expect(recovered.state.baseline!.lengthPx).toBeCloseTo(180, 6);
    expect(recovered.state.recordedMm).toBe(0);

    // And the real cut that follows is measured against the corrected baseline, not the bad one.
    const cut = hold(recovered.state, [stub(174), slice(6)]);
    expect(cut.cut!.thicknessMm).toBeCloseTo(6, 6);
  });

  /**
   * The depth-drift case. This differences a 180mm number to extract a 6mm one, so a 1% scale
   * error is 1.8mm of phantom thickness -- a third of a slice invented out of nothing.
   *
   * A real cut removes length and leaves diameter alone. Moving toward the camera scales both.
   * Normalising by the diameter ratio is what tells them apart.
   */
  it('cancels a depth nudge that scaled the whole stub, rather than calling it a cut', () => {
    const base = hold(emptyTrack(), [stub(180, 42)]);
    // 2% closer: length and diameter both grow by 2%. Length alone would read as a -3.6mm cut.
    const closer = hold(base.state, [stub(183.6, 42.84)]);
    expect(closer.cut).toBeNull();
    expect(closer.rejection).toBe('below-threshold');
  });

  it('rejects a stub that moved too far to trust instead of reporting the difference', () => {
    const base = hold(emptyTrack(), [stub(180, 42)]);
    // 5% further away AND shorter: normalisation still leaves a 6mm drop that would read as a
    // perfectly ordinary slice. Past maxScaleResidual the honest answer is that we cannot tell
    // a cut from a shove, so nothing is recorded.
    const moved = hold(base.state, [stub(165, 39.9)]);
    expect(moved.cut).toBeNull();
    expect(moved.rejection).toBe('stub-moved');
  });

  it('flags an implausible thickness rather than recording it (master spec 7.3)', () => {
    const base = hold(emptyTrack(), [stub(180)]);
    const chunk = hold(base.state, [stub(140)]);
    expect(chunk.cut).toBeNull();
    expect(chunk.rejection).toBe('implausible-thickness');
  });

  it('refuses to record more cucumber than there ever was', () => {
    // A clean session always balances exactly -- what is recorded plus what is left IS the
    // original. The invariant only bites once readings have drifted out of agreement with each
    // other, so the slack is tightened here to provoke it rather than waiting for real drift.
    const opts: TrackOptions = { ...OPTS, budgetSlack: 0.99 };
    const base = hold(emptyTrack(), [stub(100)], opts.settleFrames, opts);
    const impossible = hold(base.state, [stub(94)], opts.settleFrames, opts);
    expect(impossible.cut).toBeNull();
    expect(impossible.rejection).toBe('over-budget');
  });

  describe('slice pose', () => {
    it('measures thickness off a disc seen edge-on', () => {
      const r = hold(emptyTrack(), [stub(180), slice(6), slice(7)]);
      expect(r.sliceCount).toBe(2);
      expect(r.sideProfileMm).toBeCloseTo(6.5, 6);
    });

    it('ignores a disc seen face-on, whose short side is the diameter and not a thickness', () => {
      const faceOn: TrackBlob = { majorPx: 42, minorPx: 41, areaPx: 1722, hueDeg: 95 };
      const r = hold(emptyTrack(), [stub(180), faceOn]);
      expect(r.sliceCount).toBe(0);
      expect(r.sideProfileMm).toBeNull();
    });

    it('ignores a leaning disc, whose long side is foreshortened below the diameter', () => {
      const leaning: TrackBlob = { majorPx: 30, minorPx: 6, areaPx: 180, hueDeg: 95 };
      const r = hold(emptyTrack(), [stub(180), leaning]);
      expect(r.sliceCount).toBe(0);
    });

    /** Scale-free on purpose: both tests are ratios against the stub in the same frame. */
    it('still recognises a slice when the camera moved and every pixel figure changed', () => {
      const r = hold(emptyTrack(), [stub(360, 84), slice(12, 84)]);
      expect(r.sliceCount).toBe(1);
      expect(r.sideProfileMm).toBeCloseTo(6, 6);
    });
  });

  it('marks a cut with no visible slice as low confidence rather than dropping it', () => {
    const base = hold(emptyTrack(), [stub(180)]);
    const unseen = hold(base.state, [stub(174)]);
    expect(unseen.cut).not.toBeNull();
    // feedback.ts turns anything under 0.5 into audibly hesitant feedback.
    expect(unseen.cut!.confidence).toBeLessThan(0.5);

    const base2 = hold(unseen.state, [stub(174), slice(6)]);
    const seen = hold(base2.state, [stub(168), slice(6), slice(6)]);
    expect(seen.cut!.confidence).toBeGreaterThan(0.5);
  });
});
