using UnityEngine;

namespace IsItDoneYet.Core
{
    /// <summary>
    /// Placing things by angle and distance instead of by pixel, and sizing them so they stay
    /// legible wherever they end up.
    ///
    /// A headset has no screen edge. The reference design is seven 1440x810 rectangles, and
    /// porting one literally gives you a billboard taped to the cook's face. What survives the
    /// port is the *relationship*: "title above the eye line, toasts below it, menu off to the
    /// left". Those are angles, and this file is the only place that turns an angle into a
    /// position.
    ///
    /// Pure, static, no UnityEngine component -- so the whole of it is checkable from a terminal
    /// with no headset, no camera and no scene. That is the point: this is the maths that is
    /// wrong by 10cm in a way nobody notices until a demo.
    /// </summary>
    public static class AngularLayout
    {
        /// <summary>
        /// 1 dmm is 1 millimetre at 1 metre -- an angular unit, so a size in dmm subtends the
        /// same angle however far away the panel is. Meta's guidance is written in these, which
        /// is why the tokens are.
        /// </summary>
        public const float MillimetresPerDmmAtOneMetre = 0.001f;

        /// <summary>
        /// World size, in metres, of something specified in dmm at a given distance.
        ///
        /// This is the function that makes "24 dmm minimum body text" mean something. Size a
        /// label in metres instead and it is legible on the panel you tuned it against and
        /// nowhere else.
        /// </summary>
        public static float DmmToMetres(float dmm, float distanceMetres) =>
            dmm * MillimetresPerDmmAtOneMetre * distanceMetres;

        public static float MetresToDmm(float metres, float distanceMetres) =>
            distanceMetres <= 0.0f ? 0.0f : metres / (MillimetresPerDmmAtOneMetre * distanceMetres);

        /// <summary>The angle a thing of this size subtends at this distance, in degrees.</summary>
        public static float AngularSizeDeg(float sizeMetres, float distanceMetres) =>
            distanceMetres <= 0.0f ? 0.0f : 2.0f * Mathf.Atan2(sizeMetres * 0.5f, distanceMetres) * Mathf.Rad2Deg;

        /// <summary>
        /// A point at (yaw, pitch, distance) relative to a head pose.
        ///
        /// Yaw is signed: negative is to the cook's left, which is where the side menu lives.
        /// Pitch is signed: positive is up.
        ///
        /// The head's ROLL is deliberately discarded. Using the full head rotation means a cook
        /// who tilts their head to look at the board takes the whole HUD with them, which is
        /// both nauseating and the single most common mistake in a first spatial UI. Only the
        /// heading is used, and the panel stays level with the world.
        /// </summary>
        public static Vector3 PlaceFromHead(Vector3 headPosition, Quaternion headRotation, float yawDeg, float pitchDeg, float distanceMetres)
        {
            var heading = HeadingOnly(headRotation);
            var local = DirectionFromAngles(yawDeg, pitchDeg) * distanceMetres;
            return headPosition + heading * local;
        }

        /// <summary>Unit direction in head-local space for a yaw/pitch pair.</summary>
        public static Vector3 DirectionFromAngles(float yawDeg, float pitchDeg)
        {
            var yaw = yawDeg * Mathf.Deg2Rad;
            var pitch = pitchDeg * Mathf.Deg2Rad;
            var cosPitch = Mathf.Cos(pitch);
            return new Vector3(
                Mathf.Sin(yaw) * cosPitch,
                Mathf.Sin(pitch),
                Mathf.Cos(yaw) * cosPitch);
        }

        /// <summary>
        /// The heading component of a head rotation: yaw only, roll and pitch discarded.
        ///
        /// Taken from the forward vector flattened onto the horizontal plane. Reading the Euler
        /// y angle instead is the tempting one-liner and it is wrong -- Euler decomposition is
        /// ambiguous near the poles, so a cook looking straight down at the board gets a
        /// heading that swings wildly, and the side menu orbits them.
        /// </summary>
        public static Quaternion HeadingOnly(Quaternion headRotation)
        {
            var forward = headRotation * Vector3.forward;
            var flat = new Vector3(forward.x, 0.0f, forward.z);
            // Looking almost straight up or down leaves nothing to project. Fall back to the
            // up vector, which still carries the heading in that pose.
            if (flat.sqrMagnitude < 1e-6f)
            {
                var up = headRotation * Vector3.up;
                flat = new Vector3(up.x, 0.0f, up.z);
            }
            if (flat.sqrMagnitude < 1e-6f) return Quaternion.identity;
            return Quaternion.LookRotation(flat.normalized, Vector3.up);
        }

        /// <summary>
        /// The rotation that makes a panel at <paramref name="position"/> face the head.
        ///
        /// Panels stay upright: a panel that rolls with the head is what makes people take the
        /// headset off.
        /// </summary>
        public static Quaternion FacingHead(Vector3 position, Vector3 headPosition)
        {
            var toHead = headPosition - position;
            var flat = new Vector3(toHead.x, 0.0f, toHead.z);
            if (flat.sqrMagnitude < 1e-6f) return Quaternion.identity;
            return Quaternion.LookRotation(-flat.normalized, Vector3.up);
        }

        /// <summary>
        /// Lazy follow with a dead zone, for the toast stack -- the only thing that follows the
        /// head at all.
        ///
        /// Inside the dead zone nothing moves, so small head motion leaves the toast alone and
        /// it reads as part of the room. Past it the toast eases toward the target rather than
        /// snapping. Both halves matter: without the dead zone a toast jitters constantly, and
        /// without the easing it lurches.
        /// </summary>
        /// <param name="smoothing">Fraction of the remaining error closed per second, 0..1.</param>
        public static Vector3 LazyFollow(
            Vector3 current, Vector3 target, Vector3 headPosition,
            float deadZoneDeg, float smoothing, float deltaTime)
        {
            var toCurrent = current - headPosition;
            var toTarget = target - headPosition;
            if (toCurrent.sqrMagnitude < 1e-8f || toTarget.sqrMagnitude < 1e-8f) return target;

            var errorDeg = Vector3.Angle(toCurrent, toTarget);
            if (errorDeg <= deadZoneDeg) return current;

            // Frame-rate independent: an exponential decay evaluated over dt, not a fixed lerp.
            // A plain Lerp(current, target, smoothing) moves twice as fast at 144Hz as at 72Hz,
            // so the feel of the HUD would change with the frame rate.
            var t = 1.0f - Mathf.Exp(-Mathf.Max(0.0f, smoothing) * Mathf.Max(0.0f, deltaTime));
            return Vector3.Lerp(current, target, t);
        }

        /// <summary>
        /// A seat on a vertical cylinder around the cook, for the side menu.
        ///
        /// <paramref name="index"/> is 0-based from the top of the arc.
        /// </summary>
        public static Vector3 CurvedMenuSeat(
            Vector3 headPosition, Quaternion headRotation,
            float centreYawDeg, float radiusMetres,
            int index, int count, float arcDeg, float itemHeightMetres)
        {
            var spread = count <= 1 ? 0.0f : arcDeg / (count - 1);
            var yaw = centreYawDeg - arcDeg * 0.5f + spread * index;
            var position = PlaceFromHead(headPosition, headRotation, yaw, 0.0f, radiusMetres);
            // Items stack vertically about the centre, so an odd count has one at eye level.
            var offset = (count - 1) * 0.5f - index;
            return position + Vector3.up * (offset * itemHeightMetres);
        }

        /// <summary>
        /// Is this inside the comfortable field of view Meta documents for primary content?
        ///
        /// Used by the Design Gallery and the dev stats overlay to flag a panel that has drifted
        /// somewhere the cook would have to turn their head to read.
        /// </summary>
        public static bool WithinComfortFov(Vector3 position, Vector3 headPosition, Quaternion headRotation, float fovDeg)
        {
            var toTarget = position - headPosition;
            if (toTarget.sqrMagnitude < 1e-8f) return true;
            return Vector3.Angle(headRotation * Vector3.forward, toTarget) <= fovDeg * 0.5f;
        }
    }
}
