import { type Pose, type Quat, type StampedPose, vec3 } from './types.js';

/**
 * A ring buffer of timestamped head poses, and the lookup that makes unprojection correct.
 *
 * The reason this exists is a latency mismatch that has no other fix. The headset knows where
 * your head is at 90Hz. A detection takes anywhere from 200ms to two seconds to come back. By
 * the time it arrives the pose it was taken under is long gone, and the current pose is wrong
 * by however far you moved -- which, at a table, is easily 20cm and half a turn.
 *
 * So poses are recorded every frame and looked up by the capture timestamp. Master spec 10.1
 * step 4 says to do exactly this and calls it the most commonly botched step.
 *
 * A second and quieter reason: the frame you captured is itself slightly old. `captureFrame`
 * copies whatever the video element currently shows, which is the most recent DECODED frame,
 * not the one being taken right now. On Quest that is a frame or two -- 10 to 30ms. Getting
 * the capture timestamp from `requestVideoFrameCallback`'s `mediaTime` rather than from
 * `performance.now()` at capture removes that, and this buffer will interpolate to whatever
 * instant it is handed.
 */

const RING_DEFAULT = 180;

export class PoseRing {
  private readonly buffer: StampedPose[] = [];
  private next = 0;

  /** 180 entries at 90Hz is two seconds, which covers a slow cloud round trip with margin. */
  constructor(private readonly capacity: number = RING_DEFAULT) {}

  /** Call once per render frame. Cheap enough that it never needs to be conditional. */
  push(pose: StampedPose): void {
    if (this.buffer.length < this.capacity) {
      this.buffer.push(pose);
      return;
    }
    this.buffer[this.next] = pose;
    this.next = (this.next + 1) % this.capacity;
  }

  get size(): number {
    return this.buffer.length;
  }

  /** Oldest first. Used by the lookup and by tests; the ring order is not meaningful outside. */
  private ordered(): readonly StampedPose[] {
    if (this.buffer.length < this.capacity) return this.buffer;
    return [...this.buffer.slice(this.next), ...this.buffer.slice(0, this.next)];
  }

  /**
   * The pose at time `t`, interpolated between the two samples that bracket it.
   *
   * Returns null when the buffer is empty or when `t` falls outside what it still holds. That
   * second case is the important one and it is deliberately not clamped: a detection that took
   * longer than the buffer is deep means the pose it was taken under has been overwritten, and
   * placing it against the oldest pose we happen to still have would be a confident guess
   * dressed as a measurement. Dropping the detection loses one ring on the table. Clamping
   * puts a ring in the wrong place and gives no sign it did.
   */
  at(t: number): Pose | null {
    const poses = this.ordered();
    if (poses.length === 0 || !Number.isFinite(t)) return null;

    const first = poses[0]!;
    const last = poses[poses.length - 1]!;
    if (t < first.t || t > last.t) return null;

    // Linear scan backwards. The lookup is for a recent timestamp and runs about once a second,
    // so a binary search would be optimising the wrong thing and adding an off-by-one to own.
    for (let i = poses.length - 1; i > 0; i--) {
      const b = poses[i]!;
      const a = poses[i - 1]!;
      if (t >= a.t && t <= b.t) {
        const span = b.t - a.t;
        return span <= 0 ? strip(a) : interpolate(a, b, (t - a.t) / span);
      }
    }
    return strip(first);
  }

  /** The most recent pose, for the cases that genuinely want "now". */
  latest(): Pose | null {
    const poses = this.ordered();
    const last = poses[poses.length - 1];
    return last === undefined ? null : strip(last);
  }

  clear(): void {
    this.buffer.length = 0;
    this.next = 0;
  }
}

const strip = (p: StampedPose): Pose => ({ position: p.position, orientation: p.orientation });

function interpolate(a: StampedPose, b: StampedPose, u: number): Pose {
  return {
    position: vec3(
      a.position.x + (b.position.x - a.position.x) * u,
      a.position.y + (b.position.y - a.position.y) * u,
      a.position.z + (b.position.z - a.position.z) * u,
    ),
    orientation: slerp(a.orientation, b.orientation, u),
  };
}

/**
 * Spherical interpolation, with the shortest-arc fix.
 *
 * A quaternion and its negation are the same rotation, so two samples a millisecond apart can
 * still arrive with opposite signs. Interpolating between them without flipping one takes the
 * long way round the sphere: the head appears to spin almost all the way about and come back,
 * inside a single frame. It shows up as an occasional wildly misplaced detection and nothing
 * else, which is close to impossible to attribute without knowing to look for it.
 */
export function slerp(a: Quat, b: Quat, u: number): Quat {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let end = b;
  if (cos < 0) {
    cos = -cos;
    end = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
  }

  // Near-parallel: sin goes to zero and the division below loses all its precision. Straight
  // lerp plus a renormalise is accurate to well past what any of this is measured against.
  if (cos > 0.9995) {
    return normalizeQuat({
      x: a.x + (end.x - a.x) * u,
      y: a.y + (end.y - a.y) * u,
      z: a.z + (end.z - a.z) * u,
      w: a.w + (end.w - a.w) * u,
    });
  }

  const theta = Math.acos(Math.min(1, cos));
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - u) * theta) / sin;
  const wb = Math.sin(u * theta) / sin;
  return normalizeQuat({
    x: a.x * wa + end.x * wb,
    y: a.y * wa + end.y * wb,
    z: a.z * wa + end.z * wb,
    w: a.w * wa + end.w * wb,
  });
}

export function normalizeQuat(q: Quat): Quat {
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (!(len > 1e-12)) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}
