using System.Collections.Generic;
using UnityEngine;

namespace MRPerception
{
    /// <summary>
    /// Every threshold in the perception stack, in one place, with bounds.
    ///
    /// WHY THIS EXISTS RATHER THAN [SerializeField] ON EACH COMPONENT. A serialized field can
    /// only be changed in the editor, which means changing it requires a rebuild, which on Quest
    /// means five to ten minutes of build-deploy-relaunch-walk-back-to-the-table. Tuning a Canny
    /// threshold takes about twenty attempts. That is an afternoon.
    ///
    /// The values that need tuning are also exactly the values that CANNOT be tuned anywhere but
    /// on the device: Canny thresholds depend on the room's lighting, the confidence threshold
    /// depends on how far you stand from the table, and the association radius depends on how
    /// big the real objects are. None of that is knowable from a desk.
    ///
    /// Consumers read through <see cref="Get"/> EVERY TIME rather than caching into a local.
    /// A cached copy makes the slider look broken, which is worse than having no slider, because
    /// you then debug the wrong thing.
    /// </summary>
    public static class PerceptionTunables
    {
        // --- keys ---------------------------------------------------------------------
        // Constants rather than raw strings: a typo in a literal silently creates a second,
        // invisible tunable that nothing reads and no panel shows.

        public const string CaptureHz = "capture.hz";

        public const string YoloConfidence = "yolo.confidence";
        public const string YoloNms = "yolo.nms";

        public const string CannyLowMult = "doc.cannyLow";
        public const string CannyHighMult = "doc.cannyHigh";
        public const string DocMinArea = "doc.minArea";
        public const string DocMaxArea = "doc.maxArea";
        public const string DocEpsilon = "doc.epsilon";
        public const string DocDilate = "doc.dilate";

        public const string ConfirmFrames = "track.confirm";
        public const string ForgetFrames = "track.forget";
        public const string AssocRadius = "track.assoc";
        public const string Smoothing = "track.smoothing";

        public const string RayMaxDistance = "ray.max";
        public const string RayMinDistance = "ray.min";
        public const string SurfaceOffset = "ray.offset";

        private const string PrefPrefix = "perc.";

        public sealed class Tunable
        {
            public string Key;
            public string Label;
            public string Group;
            public float Default;
            public float Min;
            public float Max;
            public float Step;
            /// <summary>Decimal places to show. Integers use 0 and adjust in whole steps.</summary>
            public int Decimals;
            public float Value;
        }

        private static readonly List<Tunable> Ordered = new();
        private static readonly Dictionary<string, Tunable> ByKey = new();
        private static bool _loaded;

        static PerceptionTunables()
        {
            // --- capture ---
            Define(CaptureHz, "Capture rate", "CAPTURE", 5f, 1f, 15f, 1f, 0);

            // --- yolo ---
            // Confidence is the first thing to move on arrival. Trained on web photos, run on
            // low-contrast passthrough, YOLO is systematically less confident here than its
            // defaults assume -- 0.4 finds things that 0.5 silently drops.
            Define(YoloConfidence, "Confidence", "FOOD", 0.4f, 0.05f, 0.9f, 0.05f, 2);
            Define(YoloNms, "NMS overlap", "FOOD", 0.45f, 0.1f, 0.9f, 0.05f, 2);

            // --- documents ---
            // Multipliers on the image median, not absolute thresholds. Absolute numbers tuned
            // under one lighting condition produce a solid white edge map or an empty one in
            // the next room; these track the exposure.
            Define(CannyLowMult, "Canny low x median", "DOCUMENT", 0.66f, 0.1f, 1.5f, 0.02f, 2);
            Define(CannyHighMult, "Canny high x median", "DOCUMENT", 1.33f, 0.5f, 3f, 0.02f, 2);
            Define(DocMinArea, "Min area (frame frac)", "DOCUMENT", 0.02f, 0.002f, 0.3f, 0.002f, 3);
            Define(DocMaxArea, "Max area (frame frac)", "DOCUMENT", 0.95f, 0.3f, 1f, 0.01f, 2);
            Define(DocEpsilon, "Corner simplify", "DOCUMENT", 0.02f, 0.005f, 0.08f, 0.002f, 3);
            Define(DocDilate, "Edge dilate px", "DOCUMENT", 3f, 1f, 9f, 2f, 0);

            // --- tracking ---
            Define(ConfirmFrames, "Confirm frames", "TRACKING", 2f, 1f, 10f, 1f, 0);
            Define(ForgetFrames, "Forget frames", "TRACKING", 5f, 1f, 30f, 1f, 0);
            Define(AssocRadius, "Association radius m", "TRACKING", 0.12f, 0.02f, 0.5f, 0.01f, 2);
            Define(Smoothing, "Smoothing", "TRACKING", 0.35f, 0.05f, 1f, 0.05f, 2);

            // --- raycast ---
            Define(RayMaxDistance, "Max distance m", "RAYCAST", 4f, 0.5f, 10f, 0.25f, 2);
            Define(RayMinDistance, "Min distance m", "RAYCAST", 0.15f, 0.05f, 1f, 0.05f, 2);
            Define(SurfaceOffset, "Surface offset m", "RAYCAST", 0.005f, 0f, 0.05f, 0.001f, 3);
        }

        private static void Define(
            string key, string label, string group,
            float def, float min, float max, float step, int decimals)
        {
            var t = new Tunable
            {
                Key = key, Label = label, Group = group,
                Default = def, Min = min, Max = max, Step = step,
                Decimals = decimals, Value = def
            };
            Ordered.Add(t);
            ByKey[key] = t;
        }

        public static IReadOnlyList<Tunable> All
        {
            get { EnsureLoaded(); return Ordered; }
        }

        public static float Get(string key)
        {
            EnsureLoaded();
            return ByKey.TryGetValue(key, out Tunable t) ? t.Value : 0f;
        }

        public static int GetInt(string key) => Mathf.RoundToInt(Get(key));

        /// <summary>Clamps into the declared range. A non-finite value is ignored, never stored.</summary>
        public static void Set(string key, float value)
        {
            EnsureLoaded();
            if (!ByKey.TryGetValue(key, out Tunable t)) return;
            if (float.IsNaN(value) || float.IsInfinity(value)) return;
            t.Value = Mathf.Clamp(value, t.Min, t.Max);
        }

        public static void Nudge(string key, int steps)
        {
            EnsureLoaded();
            if (!ByKey.TryGetValue(key, out Tunable t)) return;
            Set(key, t.Value + t.Step * steps);
        }

        public static void Reset(string key)
        {
            EnsureLoaded();
            if (ByKey.TryGetValue(key, out Tunable t)) t.Value = t.Default;
        }

        public static void ResetAll()
        {
            EnsureLoaded();
            foreach (Tunable t in Ordered) t.Value = t.Default;
        }

        /// <summary>
        /// Persists to PlayerPrefs.
        ///
        /// Tuning happens once, on arrival, under the lighting that will be there all night.
        /// Losing it to an app restart -- which on Quest happens every time the headset sleeps
        /// with the app foregrounded -- reads as the software being flaky and costs the whole
        /// session over again.
        /// </summary>
        public static void Save()
        {
            EnsureLoaded();
            foreach (Tunable t in Ordered)
            {
                // Only overrides are written, so changing a DEFAULT in code still reaches any
                // device that never touched that particular knob.
                if (Mathf.Approximately(t.Value, t.Default)) PlayerPrefs.DeleteKey(PrefPrefix + t.Key);
                else PlayerPrefs.SetFloat(PrefPrefix + t.Key, t.Value);
            }
            PlayerPrefs.Save();
        }

        private static void EnsureLoaded()
        {
            if (_loaded) return;
            _loaded = true;
            foreach (Tunable t in Ordered)
            {
                string pref = PrefPrefix + t.Key;
                if (PlayerPrefs.HasKey(pref))
                {
                    t.Value = Mathf.Clamp(PlayerPrefs.GetFloat(pref), t.Min, t.Max);
                }
            }
        }

        public static string Format(Tunable t) => t.Value.ToString("F" + t.Decimals);
    }
}
