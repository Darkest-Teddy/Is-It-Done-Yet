import { describe, expect, it } from 'vitest';
import { normalizeQuat, PoseRing, slerp } from './poseRing.js';
import { IDENTITY_QUAT, type Quat, vec3 } from './types.js';

const yaw = (deg: number): Quat => {
  const half = (deg * Math.PI) / 360;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
};

const stamped = (t: number, x: number, deg = 0) =>
  ({ t, position: vec3(x, 0, 0), orientation: yaw(deg) });

describe('PoseRing', () => {
  it('is empty before anything is recorded', () => {
    expect(new PoseRing().at(0)).toBeNull();
    expect(new PoseRing().latest()).toBeNull();
  });

  it('interpolates between the two samples that bracket the time asked for', () => {
    const ring = new PoseRing();
    ring.push(stamped(100, 0));
    ring.push(stamped(200, 1));
    expect(ring.at(150)!.position.x).toBeCloseTo(0.5, 9);
    expect(ring.at(125)!.position.x).toBeCloseTo(0.25, 9);
  });

  it('returns the exact sample when the time lands on one', () => {
    const ring = new PoseRing();
    ring.push(stamped(100, 0));
    ring.push(stamped(200, 1));
    expect(ring.at(200)!.position.x).toBeCloseTo(1, 9);
  });

  /**
   * The behaviour worth defending. A detection that outlived the buffer has no pose to be
   * placed against, and the oldest one still held is not an approximation of the right answer --
   * it is a different answer. Clamping would put a ring somewhere plausible and give no sign
   * it had guessed.
   */
  it('refuses a time outside what it still holds, rather than clamping to the nearest', () => {
    const ring = new PoseRing();
    ring.push(stamped(100, 0));
    ring.push(stamped(200, 1));
    expect(ring.at(50)).toBeNull();
    expect(ring.at(300)).toBeNull();
    expect(ring.at(Number.NaN)).toBeNull();
  });

  it('overwrites oldest first and keeps interpolating correctly across the wrap', () => {
    const ring = new PoseRing(3);
    for (let i = 0; i < 5; i++) ring.push(stamped(i * 100, i));
    expect(ring.size).toBe(3);
    // 0 and 100 have been overwritten; 200, 300, 400 remain.
    expect(ring.at(100)).toBeNull();
    expect(ring.at(250)!.position.x).toBeCloseTo(2.5, 9);
    expect(ring.latest()!.position.x).toBeCloseTo(4, 9);
  });

  it('interpolates orientation, not just position', () => {
    const ring = new PoseRing();
    ring.push(stamped(0, 0, 0));
    ring.push(stamped(100, 0, 90));
    const mid = ring.at(50)!.orientation;
    const expected = yaw(45);
    expect(mid.y).toBeCloseTo(expected.y, 6);
    expect(mid.w).toBeCloseTo(expected.w, 6);
  });

  it('survives two samples sharing a timestamp without dividing by zero', () => {
    const ring = new PoseRing();
    ring.push(stamped(100, 0));
    ring.push(stamped(100, 1));
    const pose = ring.at(100);
    expect(pose).not.toBeNull();
    expect(Number.isFinite(pose!.position.x)).toBe(true);
  });
});

describe('slerp', () => {
  it('returns the endpoints at 0 and 1', () => {
    expect(slerp(IDENTITY_QUAT, yaw(90), 0).w).toBeCloseTo(1, 9);
    expect(slerp(IDENTITY_QUAT, yaw(90), 1).y).toBeCloseTo(yaw(90).y, 9);
  });

  /**
   * A quaternion and its negation are the same rotation, so two samples a millisecond apart can
   * arrive with opposite signs. Without the shortest-arc flip the head appears to spin almost
   * all the way round and back inside one frame, which surfaces as a single wildly misplaced
   * detection and nothing else -- close to impossible to attribute without knowing to look.
   */
  it('takes the short way round when the two samples have opposite signs', () => {
    const a = yaw(10);
    const negated = { x: -a.x, y: -a.y, z: -a.z, w: -a.w };
    const mid = slerp(IDENTITY_QUAT, negated, 0.5);
    const short = slerp(IDENTITY_QUAT, a, 0.5);
    // Same rotation either way, so the halfway points must agree up to sign.
    const alignment = Math.abs(
      mid.x * short.x + mid.y * short.y + mid.z * short.z + mid.w * short.w,
    );
    expect(alignment).toBeCloseTo(1, 6);
  });

  it('stays unit length', () => {
    const q = slerp(IDENTITY_QUAT, yaw(120), 0.37);
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 9);
  });

  it('handles near-identical inputs without losing precision to a tiny sine', () => {
    const q = slerp(yaw(10), yaw(10.0001), 0.5);
    expect(Number.isFinite(q.w)).toBe(true);
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 9);
  });
});

describe('normalizeQuat', () => {
  it('falls back to identity for a zero quaternion rather than producing NaN', () => {
    expect(normalizeQuat({ x: 0, y: 0, z: 0, w: 0 })).toEqual(IDENTITY_QUAT);
  });
});
