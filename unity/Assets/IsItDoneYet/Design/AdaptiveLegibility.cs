using UnityEngine;

namespace IsItDoneYet.Design
{
    /// <summary>
    /// Reads the room's brightness off the frame already captured for the coach, and nudges
    /// panel opacity and text outline to match.
    ///
    /// A cream panel at 94% is perfect over a dark counter and invisible over a sunlit white
    /// worktop. The obvious fix -- make everything opaque -- throws away the thing that makes
    /// the app read as mixed reality.
    ///
    /// This costs nothing. The frame is already in memory, downscaled, on its way to the
    /// server; this reads a few hundred pixels of it. Nothing extra is captured, nothing extra
    /// is stored, nothing extra is sent, and it only runs once camera consent has been granted.
    /// </summary>
    public static class AdaptiveLegibility
    {
        /// <summary>Multiplies every panel's opacity. 1 when the room is dark.</summary>
        public static float OpacityBoost { get; private set; } = 1f;

        /// <summary>Multiplies every label's outline width. 1 when the room is dark.</summary>
        public static float OutlineBoost { get; private set; } = 1f;

        static float _smoothedLuminance = 0.2f;
        static bool _enabled;

        /// <summary>
        /// Off until the cook grants camera consent, and off again the moment it is revoked.
        /// When off, the boosts return to 1 rather than freezing at their last value -- a
        /// stale adaptation is worse than none, because it is tuned for a room that has gone.
        /// </summary>
        public static void SetEnabled(bool enabled)
        {
            _enabled = enabled;
            if (!enabled)
            {
                OpacityBoost = 1f;
                OutlineBoost = 1f;
                _smoothedLuminance = 0.2f;
            }
        }

        /// <summary>
        /// Feeds one downscaled frame.
        ///
        /// <paramref name="stride"/> samples every nth pixel: a 512px frame is 260k pixels and
        /// this runs every three seconds on the main thread. Stride 16 reads about a thousand
        /// of them, which is plenty for an average and is not a frame-time event.
        /// </summary>
        public static void Sample(Color32[] pixels, float deltaTime, int stride = 16)
        {
            if (!_enabled || pixels == null || pixels.Length == 0) return;

            var sum = 0f;
            var count = 0;
            for (var i = 0; i < pixels.Length; i += stride)
            {
                var p = pixels[i];
                // Rec. 709 luma on the sRGB values. Perceptual weighting, not a mean of the
                // channels -- a mean calls a saturated blue as bright as a pale yellow.
                sum += (0.2126f * p.r + 0.7152f * p.g + 0.0722f * p.b) / 255f;
                count++;
            }
            if (count == 0) return;

            var luminance = sum / count;

            // Smoothed hard. A hand crossing the camera drops the average for one frame, and an
            // unsmoothed response makes every panel flinch. Two seconds of time constant means
            // the HUD reacts to the room, not to events in it.
            var t = 1f - Mathf.Exp(-Mathf.Max(0f, deltaTime) / 2f);
            _smoothedLuminance = Mathf.Lerp(_smoothedLuminance, luminance, t);

            // Dark room: leave it alone. Bright room: up to +6% opacity and double the outline.
            var brightness = Mathf.InverseLerp(0.25f, 0.75f, _smoothedLuminance);
            OpacityBoost = Mathf.Lerp(1f, 1.06f, brightness);
            OutlineBoost = Mathf.Lerp(1f, 2.0f, brightness);
        }

        /// <summary>The smoothed room luminance, 0..1. Shown in the dev stats overlay.</summary>
        public static float RoomLuminance => _smoothedLuminance;
    }
}
