using UnityEngine;

namespace IsItDoneYet.Design
{
    /// <summary>
    /// The token easings, evaluated. Pure and static, so every curve in the design system can be
    /// checked from a terminal with no scene.
    /// </summary>
    public static class Easing
    {
        /// <summary>
        /// A CSS cubic-bezier, solved for y at a given x.
        ///
        /// A cubic-bezier easing is parametric: the curve is (x(t), y(t)) and what an animation
        /// wants is y at a given *x*, which means solving x(t) = target for t first. Newton
        /// converges in three or four steps for every curve in this design; the bisection
        /// fallback exists for the overshoot curve, whose control point at y=1.5 puts x'(t) near
        /// zero in a region where Newton stalls.
        ///
        /// Allocation-free and loop-bounded, so it is safe to call once per tween per frame.
        /// </summary>
        public static float CubicBezier(float x1, float y1, float x2, float y2, float x)
        {
            if (x <= 0f) return 0f;
            if (x >= 1f) return 1f;

            // Linear curve: skip the solve entirely. This is the common case for the
            // "standard" easing under a reduced-motion theme, where both controls collapse.
            if (Mathf.Approximately(x1, y1) && Mathf.Approximately(x2, y2)) return x;

            var t = x;
            for (var i = 0; i < 8; i++)
            {
                var currentX = BezierAxis(t, x1, x2) - x;
                if (Mathf.Abs(currentX) < 1e-5f) return BezierAxis(t, y1, y2);
                var slope = BezierSlope(t, x1, x2);
                if (Mathf.Abs(slope) < 1e-6f) break;
                t -= currentX / slope;
            }

            var lo = 0f;
            var hi = 1f;
            t = x;
            for (var i = 0; i < 20; i++)
            {
                var currentX = BezierAxis(t, x1, x2);
                if (Mathf.Abs(currentX - x) < 1e-5f) break;
                if (currentX > x) hi = t; else lo = t;
                t = (lo + hi) * 0.5f;
            }
            return BezierAxis(t, y1, y2);
        }

        public static float CubicBezier(Vector4 controls, float x) =>
            CubicBezier(controls.x, controls.y, controls.z, controls.w, x);

        /// <summary>One axis of a unit cubic bezier whose endpoints are 0 and 1.</summary>
        static float BezierAxis(float t, float a, float b)
        {
            var mt = 1f - t;
            return 3f * mt * mt * t * a + 3f * mt * t * t * b + t * t * t;
        }

        static float BezierSlope(float t, float a, float b)
        {
            var mt = 1f - t;
            return 3f * mt * mt * a + 6f * mt * t * (b - a) + 3f * t * t * (1f - b);
        }

        /// <summary>
        /// A critically-damped spring step.
        ///
        /// Not a duration-based tween: this is a differential equation integrated forward, so it
        /// has no end time and settles asymptotically. That is what it is for -- a toast chasing
        /// a head that keeps moving has no "end" to ease toward, and a fixed-duration tween
        /// restarted every frame produces the rubber-banding that makes spatial UI feel cheap.
        ///
        /// Semi-implicit Euler with the velocity updated first, which stays stable at the
        /// stiffnesses in the tokens where plain Euler diverges.
        /// </summary>
        public static float Spring(float current, float target, ref float velocity, float stiffness, float damping, float deltaTime)
        {
            // Long frames are the hazard: one 200ms hitch integrated in a single step sends a
            // stiff spring to infinity. Substepping caps the error instead of the symptom.
            var remaining = Mathf.Max(0f, deltaTime);
            const float maxStep = 1f / 120f;
            var guard = 0;
            while (remaining > 0f && guard++ < 16)
            {
                var step = Mathf.Min(maxStep, remaining);
                remaining -= step;
                var force = (target - current) * stiffness - velocity * damping;
                velocity += force * step;
                current += velocity * step;
            }
            return current;
        }

        public static Vector3 Spring(Vector3 current, Vector3 target, ref Vector3 velocity, float stiffness, float damping, float deltaTime)
        {
            var vx = velocity.x; var vy = velocity.y; var vz = velocity.z;
            var x = Spring(current.x, target.x, ref vx, stiffness, damping, deltaTime);
            var y = Spring(current.y, target.y, ref vy, stiffness, damping, deltaTime);
            var z = Spring(current.z, target.z, ref vz, stiffness, damping, deltaTime);
            velocity = new Vector3(vx, vy, vz);
            return new Vector3(x, y, z);
        }

        /// <summary>
        /// The reference's landing squash: overshoot wide and flat, rebound tall and thin,
        /// settle. Returns a non-uniform scale for a normalised time.
        ///
        /// Three keyframes rather than a curve because that is literally what the CSS does, and
        /// approximating it with a single ease loses the thing that makes it read as weight.
        /// </summary>
        public static Vector2 Squash(Vector2 impact, Vector2 rebound, float t)
        {
            t = Mathf.Clamp01(t);
            if (t < 0.35f) return Vector2.Lerp(Vector2.one, impact, Smooth(t / 0.35f));
            if (t < 0.70f) return Vector2.Lerp(impact, rebound, Smooth((t - 0.35f) / 0.35f));
            return Vector2.Lerp(rebound, Vector2.one, Smooth((t - 0.70f) / 0.30f));
        }

        static float Smooth(float t) => t * t * (3f - 2f * t);
    }
}
