import { describe, expect, it } from 'vitest';
import {
  boxToWorld, compose, dot, focalLengthPx, intersectPlane, normalize,
  pixelToCameraRay, pixelToWorldRay, rotate,
} from './unproject.js';
import { IDENTITY_POSE, IDENTITY_QUAT, type Intrinsics, type Plane, vec3 } from './types.js';

/** 90 degrees horizontal makes the focal length exactly half the width, which is checkable. */
const CAM: Intrinsics = {
  widthPx: 1280, heightPx: 960, fovXDeg: 90, offset: IDENTITY_POSE,
};

/** A table one metre below the origin, facing up. */
const TABLE: Plane = { point: vec3(0, -1, 0), normal: vec3(0, 1, 0) };

/** Rotation of `deg` about +Y, as a quaternion. */
const yaw = (deg: number) => {
  const half = (deg * Math.PI) / 360;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
};

describe('focalLengthPx', () => {
  it('is half the width at a 90 degree horizontal field of view', () => {
    expect(focalLengthPx(CAM)).toBeCloseTo(640, 9);
  });

  it('grows as the lens narrows', () => {
    expect(focalLengthPx({ ...CAM, fovXDeg: 60 })).toBeGreaterThan(focalLengthPx(CAM));
  });
});

describe('pixelToCameraRay', () => {
  it('looks straight down -z from the centre of the image', () => {
    const ray = pixelToCameraRay(CAM, 640, 480)!;
    expect(ray.x).toBeCloseTo(0, 9);
    expect(ray.y).toBeCloseTo(0, 9);
    expect(ray.z).toBeCloseTo(-1, 9);
  });

  it('sends the right edge of the image to +x, at half the field of view', () => {
    const ray = pixelToCameraRay(CAM, 1280, 480)!;
    // 45 degrees off axis, so x and -z are equal.
    expect(ray.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(ray.z).toBeCloseTo(-Math.SQRT1_2, 6);
  });

  /**
   * The sign error this file is most likely to grow. Image y increases DOWNWARD and camera y
   * increases upward, so a pixel near the top of frame must point UP. Getting this backwards
   * mirrors every placement about the horizon, which looks like a tracking fault rather than
   * an arithmetic one.
   */
  it('sends the TOP of the image upward, not downward', () => {
    expect(pixelToCameraRay(CAM, 640, 0)!.y).toBeGreaterThan(0);
    expect(pixelToCameraRay(CAM, 640, 960)!.y).toBeLessThan(0);
  });

  it('returns a unit vector', () => {
    const ray = pixelToCameraRay(CAM, 100, 800)!;
    expect(Math.hypot(ray.x, ray.y, ray.z)).toBeCloseTo(1, 9);
  });
});

describe('rotate and compose', () => {
  it('leaves a vector alone under the identity rotation', () => {
    expect(rotate(IDENTITY_QUAT, vec3(1, 2, 3))).toEqual(vec3(1, 2, 3));
  });

  it('turns +x into -z under a quarter turn about +y', () => {
    const r = rotate(yaw(90), vec3(1, 0, 0));
    expect(r.x).toBeCloseTo(0, 9);
    expect(r.z).toBeCloseTo(-1, 9);
  });

  /**
   * The property that matters for the camera offset: a head-local offset has to be ROTATED
   * into world space, not just added. Adding it is right only when the head faces forward,
   * which is the one case anybody tests by hand.
   */
  it('rotates a child offset into the parent frame rather than adding it', () => {
    const head = { position: vec3(0, 1.6, 0), orientation: yaw(90) };
    const offset = { position: vec3(0, 0, -0.05), orientation: IDENTITY_QUAT };
    const world = compose(head, offset);
    // Facing -x after a quarter turn about +y, so 5cm "forward" is 5cm along -x.
    expect(world.position.x).toBeCloseTo(-0.05, 9);
    expect(world.position.z).toBeCloseTo(0, 9);
  });
});

describe('intersectPlane', () => {
  it('finds the point below a downward ray', () => {
    const hit = intersectPlane(
      { origin: vec3(0, 1.6, 0), direction: vec3(0, -1, 0) }, TABLE,
    )!;
    expect(hit).toEqual(vec3(0, -1, 0));
  });

  it('is null for a ray parallel to the plane', () => {
    expect(intersectPlane(
      { origin: vec3(0, 1.6, 0), direction: vec3(1, 0, 0) }, TABLE,
    )).toBeNull();
  });

  /** Behind the camera is not a placement; it is a detection that should be dropped. */
  it('is null when the plane is behind the ray', () => {
    expect(intersectPlane(
      { origin: vec3(0, 1.6, 0), direction: vec3(0, 1, 0) }, TABLE,
    )).toBeNull();
  });
});

describe('pixelToWorldRay', () => {
  it('starts at the camera, not at the head, once an offset is set', () => {
    const cam: Intrinsics = {
      ...CAM,
      offset: { position: vec3(0.03, 0, -0.05), orientation: IDENTITY_QUAT },
    };
    const ray = pixelToWorldRay(cam, { position: vec3(0, 1.6, 0), orientation: IDENTITY_QUAT },
      640, 480)!;
    expect(ray.origin.x).toBeCloseTo(0.03, 9);
    expect(ray.origin.z).toBeCloseTo(-0.05, 9);
  });

  it('turns with the head', () => {
    const forward = pixelToWorldRay(CAM, IDENTITY_POSE, 640, 480)!;
    expect(forward.direction.z).toBeCloseTo(-1, 9);

    const turned = pixelToWorldRay(CAM, { position: vec3(0, 0, 0), orientation: yaw(90) },
      640, 480)!;
    expect(turned.direction.x).toBeCloseTo(-1, 6);
    expect(turned.direction.z).toBeCloseTo(0, 6);
  });
});

describe('boxToWorld', () => {
  /**
   * Master spec 10.1 step 1: the BOTTOM-centre pixel, because that is where the object meets
   * the table and therefore the one point on the box that lies in the plane being intersected.
   */
  it('projects the bottom of the box, not its centre', () => {
    const head = { position: vec3(0, 0, 0), orientation: IDENTITY_QUAT };
    const box = { x: 0.4, y: 0.3, w: 0.2, h: 0.4 };
    const bottom = boxToWorld(CAM, head, box, TABLE)!;
    // A shorter box with the same top has its bottom higher in frame, so its ray is shallower
    // and lands further away. Kept below the image centre: a bottom edge exactly on the centre
    // line projects along the horizon and never meets the table at all.
    const shorter = boxToWorld(CAM, head, { ...box, h: 0.3 }, TABLE)!;
    expect(Math.abs(bottom.z)).toBeLessThan(Math.abs(shorter.z));
  });

  it('puts a detection centred in frame straight ahead on the table', () => {
    const head = { position: vec3(0, 0, 0), orientation: IDENTITY_QUAT };
    // Bottom edge at 3/4 down the image, horizontally centred.
    const hit = boxToWorld(CAM, head, { x: 0.45, y: 0.35, w: 0.1, h: 0.4 }, TABLE)!;
    expect(hit.x).toBeCloseTo(0, 6);
    expect(hit.y).toBeCloseTo(-1, 6);
    expect(hit.z).toBeLessThan(0);
  });

  it('is null when the box projects above the horizon and never reaches the table', () => {
    const head = { position: vec3(0, 0, 0), orientation: IDENTITY_QUAT };
    expect(boxToWorld(CAM, head, { x: 0.4, y: 0, w: 0.2, h: 0.1 }, TABLE)).toBeNull();
  });

  /**
   * The whole reason `poseRing` exists, expressed as a test: the SAME pixel under a different
   * head pose is a different world point. Anything that uses the current pose for a frame
   * captured a second ago is computing this wrong and cannot tell.
   */
  it('gives a different answer for the same pixel under a different head pose', () => {
    const box = { x: 0.45, y: 0.35, w: 0.1, h: 0.4 };
    const a = boxToWorld(CAM, IDENTITY_POSE, box, TABLE)!;
    const b = boxToWorld(CAM, { position: vec3(0, 0, 0), orientation: yaw(30) }, box, TABLE)!;
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(0.3);
  });
});

describe('normalize', () => {
  it('is null for a zero vector rather than NaN', () => {
    expect(normalize(vec3(0, 0, 0))).toBeNull();
  });

  it('preserves direction', () => {
    const n = normalize(vec3(0, 0, -5))!;
    expect(dot(n, vec3(0, 0, -1))).toBeCloseTo(1, 9);
  });
});
