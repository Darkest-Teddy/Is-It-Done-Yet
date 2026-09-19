import {
  type Box, type Intrinsics, type Plane, type Pose, type Quat, vec3, type Vec3,
} from './types.js';

/**
 * Pixel to world position, via the table.
 *
 * Master spec 10.1. The camera is strapped to your face and moves constantly, so a static
 * homography cannot work: the same pixel means a different world point every frame. The only
 * thing that makes a detection placeable is the head pose AT THE MOMENT THE FRAME WAS CAPTURED,
 * which is why this module takes a pose rather than reading one, and why `poseRing.ts` exists.
 *
 * Every function here is pure arithmetic on plain records. The coordinate pipeline is the part
 * of a mixed-reality app that is hardest to debug on a headset -- a sign error looks exactly
 * like a tracking problem -- so it is the part that most needs to be provable from a terminal.
 */

// --- quaternion helpers -----------------------------------------------------------------

/** Rotates a vector by a unit quaternion. The standard t = 2(q_v x v) form; no matrix needed. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return vec3(
    v.x + q.w * tx + (q.y * tz - q.z * ty),
    v.y + q.w * ty + (q.z * tx - q.x * tz),
    v.z + q.w * tz + (q.x * ty - q.y * tx),
  );
}

export function multiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/**
 * Composes two rigid transforms: the result applies `b` first, then `a`.
 *
 * Used once, to put the camera's head-local offset into world space. Writing it as a transform
 * composition rather than as ad-hoc vector addition is what keeps it correct when the head is
 * rotated, which is always.
 */
export function compose(a: Pose, b: Pose): Pose {
  return {
    position: add(a.position, rotate(a.orientation, b.position)),
    orientation: multiply(a.orientation, b.orientation),
  };
}

export const add = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => vec3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (v: Vec3, s: number): Vec3 => vec3(v.x * s, v.y * s, v.z * s);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const length = (v: Vec3): number => Math.sqrt(dot(v, v));

/** Returns null rather than NaN for a zero vector, so a degenerate input is a value not a poison. */
export function normalize(v: Vec3): Vec3 | null {
  const len = length(v);
  if (!(len > 1e-12) || !Number.isFinite(len)) return null;
  return scale(v, 1 / len);
}

// --- intrinsics -------------------------------------------------------------------------

/**
 * Focal length in pixels from a horizontal field of view.
 *
 * `fx = (width / 2) / tan(fovX / 2)`. Square pixels are assumed, so `fy === fx`; that holds for
 * every headset passthrough camera worth pointing at a table, and if it ever does not the
 * symptom is a placement error that grows toward the top and bottom of frame rather than
 * uniformly, which is distinctive enough to recognise.
 */
export function focalLengthPx(intrinsics: Intrinsics): number {
  const half = (intrinsics.fovXDeg * Math.PI) / 360;
  return intrinsics.widthPx / 2 / Math.tan(half);
}

/**
 * A pixel to a direction in CAMERA space.
 *
 * Camera space is the usual graphics convention: +x right, +y up, looking down -z. Image space
 * has y increasing DOWNWARD, so the y term is negated exactly once, here. Doing it twice, or
 * not at all, mirrors every placement about the horizon and is the single easiest sign error to
 * make in this file.
 */
export function pixelToCameraRay(intrinsics: Intrinsics, px: number, py: number): Vec3 | null {
  const f = focalLengthPx(intrinsics);
  if (!Number.isFinite(f) || f <= 0) return null;
  return normalize(vec3(
    (px - intrinsics.widthPx / 2) / f,
    -(py - intrinsics.heightPx / 2) / f,
    -1,
  ));
}

export interface Ray {
  readonly origin: Vec3;
  readonly direction: Vec3;
}

/**
 * A pixel to a world-space ray, given the head pose at the time the frame was captured.
 *
 * `headPose` must be the pose THEN, not now. Master spec 10.1 calls this the most commonly
 * botched step and it is right: using the current pose produces placements that are correct
 * while you hold still and swim when you turn, which reads as bad tracking rather than as a
 * stale pose, so people go and tune the wrong thing.
 */
export function pixelToWorldRay(
  intrinsics: Intrinsics, headPose: Pose, px: number, py: number,
): Ray | null {
  const local = pixelToCameraRay(intrinsics, px, py);
  if (local === null) return null;
  const cameraPose = compose(headPose, intrinsics.offset);
  const direction = normalize(rotate(cameraPose.orientation, local));
  if (direction === null) return null;
  return { origin: cameraPose.position, direction };
}

// --- plane intersection -----------------------------------------------------------------

/**
 * Where a ray meets a plane, or null.
 *
 * Null for three genuinely different reasons -- parallel, behind the camera, or degenerate --
 * and all three mean "do not place anything", so they collapse to one absent value rather than
 * to a position the caller has to know not to trust.
 */
export function intersectPlane(ray: Ray, plane: Plane): Vec3 | null {
  const denom = dot(plane.normal, ray.direction);
  if (Math.abs(denom) < 1e-9) return null;
  const t = dot(plane.normal, sub(plane.point, ray.origin)) / denom;
  if (!(t > 0) || !Number.isFinite(t)) return null;
  return add(ray.origin, scale(ray.direction, t));
}

/**
 * The whole pipeline: a detection box to a world position on the table.
 *
 * Master spec 10.1 step 1 takes the box's BOTTOM-CENTRE pixel, and the reason is worth keeping:
 * that is where the object meets the table, so it is the one point on the box that actually
 * lies in the plane being intersected. The centre of the box floats somewhere inside the
 * object and projects to a point beyond it, by roughly half the object's height -- which for a
 * jar on a table is several centimetres of consistent, forward-biased error.
 */
export function boxToWorld(
  intrinsics: Intrinsics, headPose: Pose, box: Box, plane: Plane,
): Vec3 | null {
  const px = (box.x + box.w / 2) * intrinsics.widthPx;
  const py = (box.y + box.h) * intrinsics.heightPx;
  const ray = pixelToWorldRay(intrinsics, headPose, px, py);
  return ray === null ? null : intersectPlane(ray, plane);
}
