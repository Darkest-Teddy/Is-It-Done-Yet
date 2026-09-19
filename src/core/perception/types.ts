/**
 * Shared vocabulary for the perception layer.
 *
 * Everything here is plain data. No THREE.Vector3, no XRRigidTransform, no canvas. That is what
 * lets the whole coordinate pipeline -- the part that is genuinely hard to get right -- be
 * tested from a terminal with no headset, no camera and no network, exactly as `src/core` does
 * for the measurement pipeline.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Unit quaternion, xyzw order, matching WebXR's `XRRigidTransform.orientation`. */
export interface Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/**
 * A rigid transform. Position plus orientation, never a matrix.
 *
 * WebXR hands out poses in exactly this shape, and keeping it avoids ever writing a 4x4
 * inversion -- the inverse of a rigid transform is just the conjugate rotation applied to the
 * negated translation, which is three lines and cannot be subtly wrong about handedness.
 */
export interface Pose {
  readonly position: Vec3;
  readonly orientation: Quat;
}

/** A pose with the time it was true, in `performance.now()` milliseconds. */
export interface StampedPose extends Pose {
  readonly t: number;
}

/**
 * Pinhole description of the passthrough camera.
 *
 * `fovXDeg` is the HORIZONTAL field of view. It is a calibrated quantity, not a spec sheet
 * number: the value that matters is the one that makes a ray through a known pixel land on a
 * known point, and that is what the calibration step solves for.
 */
export interface Intrinsics {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly fovXDeg: number;
  /**
   * Where the camera sits relative to the head pose, in head-local space.
   *
   * The passthrough camera is NOT at your eye. It is a couple of centimetres out and forward,
   * and ignoring that puts every placement off by that much in a direction that changes as you
   * turn your head -- which reads as drift rather than as offset, and sends people looking for
   * a tracking bug that is not there.
   */
  readonly offset: Pose;
}

/** Normalised 0..1 box, origin top-left, matching every detection API worth using. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Detection {
  readonly label: string;
  /** 0..1 */
  readonly confidence: number;
  readonly box: Box;
  /** Present when the provider segmented rather than just boxed. Normalised, like `box`. */
  readonly polygon?: readonly (readonly [number, number])[];
}

/** A detection the provider believes carries readable text. */
export interface TextRegion {
  readonly box: Box;
  /** The read string, exactly as the engine returned it. Never pre-cleaned. */
  readonly text: string;
  /** 0..1 */
  readonly confidence: number;
  /**
   * Rotation of the text baseline from horizontal, degrees, when the engine reports one.
   *
   * Absent rather than zero when unknown. A deskew step that trusts a fabricated zero will
   * happily rotate readable text into unreadable text.
   */
  readonly angleDeg?: number;
}

/** One frame's worth of provider output, with the time the FRAME was captured. */
export interface Observation {
  readonly t: number;
  readonly detections: readonly Detection[];
  readonly textRegions: readonly TextRegion[];
}

/** An infinite plane, for the table the detections are projected onto. */
export interface Plane {
  readonly point: Vec3;
  /** Expected to be unit length. */
  readonly normal: Vec3;
}

export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const IDENTITY_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 };

export const IDENTITY_POSE: Pose = { position: vec3(0, 0, 0), orientation: IDENTITY_QUAT };
