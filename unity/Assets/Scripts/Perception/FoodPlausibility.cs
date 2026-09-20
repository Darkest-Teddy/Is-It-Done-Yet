using System.Collections.Generic;
using UnityEngine;

namespace MRPerception
{
    /// <summary>
    /// Rejects detections that cannot be what the model says they are.
    ///
    /// THE PROBLEM. A COCO detector on a kitchen counter produces a steady trickle of nonsense:
    /// wood grain called broccoli, a cabinet handle called a knife, a reflection called a bowl.
    /// Raising the confidence threshold trades those for missing the real objects, because a
    /// false positive at 0.55 and a real carrot at 0.55 are indistinguishable TO THE MODEL.
    ///
    /// The fix is not a better model or better training data -- it is asking a question the
    /// model cannot: how big is it, actually, in metres?
    ///
    /// THIS ONLY WORKS BECAUSE THERE IS DEPTH. A 2D pipeline has no idea whether a box is a
    /// carrot at 30cm or a carrot-coloured cabinet at 3m; both are the same pixels. Raycasting
    /// against the depth map gives a distance, distance plus the box gives real size, and real
    /// size is decisive: a "banana" 90cm long is a countertop, and no confidence score will ever
    /// tell you that. It is the single strongest false-positive filter available here and it is
    /// nearly free, because <c>EstimateSize</c> is already computing the number.
    ///
    /// All ranges are TUNED, not sourced -- supermarket produce, measured by eye. They are
    /// deliberately generous: the job is to reject the absurd, not to adjudicate a large carrot.
    /// </summary>
    public static class FoodPlausibility
    {
        /// <summary>What a detected class is FOR, which decides how it is handled.</summary>
        public enum Role
        {
            /// <summary>Food in its own right. Box it, identify it.</summary>
            Food,
            /// <summary>A container. Interesting for WHAT IS IN IT, not for itself.</summary>
            Container,
            /// <summary>A utensil or anything else. Useful context, never a subject.</summary>
            Ignore
        }

        private readonly struct SizeRange
        {
            public readonly float MinM;
            public readonly float MaxM;
            public readonly Role Role;
            public SizeRange(float minM, float maxM, Role role) { MinM = minM; MaxM = maxM; Role = role; }
        }

        // Longest real-world dimension, metres.
        private static readonly Dictionary<string, SizeRange> Known = new()
        {
            // --- food -------------------------------------------------------------
            { "banana",   new SizeRange(0.10f, 0.28f, Role.Food) },
            { "apple",    new SizeRange(0.04f, 0.12f, Role.Food) },
            { "orange",   new SizeRange(0.04f, 0.12f, Role.Food) },
            { "broccoli", new SizeRange(0.06f, 0.28f, Role.Food) },
            { "carrot",   new SizeRange(0.06f, 0.32f, Role.Food) },
            { "sandwich", new SizeRange(0.07f, 0.30f, Role.Food) },
            { "hot dog",  new SizeRange(0.08f, 0.28f, Role.Food) },
            { "pizza",    new SizeRange(0.12f, 0.50f, Role.Food) },
            { "donut",    new SizeRange(0.05f, 0.16f, Role.Food) },
            { "cake",     new SizeRange(0.08f, 0.45f, Role.Food) },

            // --- containers -------------------------------------------------------
            // The route to everything COCO cannot see. Shredded cheese, chopped onion, flour,
            // spices -- none has a shape a detector can find, and all of them live in a bowl.
            { "bowl",       new SizeRange(0.07f, 0.40f, Role.Container) },
            { "cup",        new SizeRange(0.05f, 0.18f, Role.Container) },
            { "bottle",     new SizeRange(0.08f, 0.40f, Role.Container) },
            { "wine glass", new SizeRange(0.08f, 0.28f, Role.Container) },

            // --- context ----------------------------------------------------------
            { "fork",  new SizeRange(0.08f, 0.32f, Role.Ignore) },
            { "knife", new SizeRange(0.08f, 0.40f, Role.Ignore) },
            { "spoon", new SizeRange(0.08f, 0.32f, Role.Ignore) },
        };

        /// <summary>
        /// A floor and ceiling for anything not in the table.
        ///
        /// Nothing worth putting a hologram on in a kitchen is smaller than a grape or bigger
        /// than a worktop. Most wild false positives are outside this without needing a
        /// per-class opinion at all.
        /// </summary>
        private const float AbsoluteMinM = 0.02f;
        private const float AbsoluteMaxM = 0.60f;

        public static Role RoleOf(string label)
        {
            return Known.TryGetValue(label, out SizeRange r) ? r.Role : Role.Food;
        }

        /// <summary>
        /// True when an object that size could plausibly be that class.
        ///
        /// Judged on the LONGER axis. The shorter one is unreliable: a carrot seen end-on is a
        /// circle, and a pepper half-hidden behind a bowl is whatever fraction of itself is
        /// visible. The long axis is the one that survives partial occlusion.
        /// </summary>
        public static bool PlausibleSize(string label, Vector2 sizeMeters)
        {
            float longest = Mathf.Max(sizeMeters.x, sizeMeters.y);
            if (!(longest > 0f) || float.IsNaN(longest) || float.IsInfinity(longest)) return false;
            if (longest < AbsoluteMinM || longest > AbsoluteMaxM) return false;

            if (!Known.TryGetValue(label, out SizeRange range)) return true;
            return longest >= range.MinM && longest <= range.MaxM;
        }

        /// <summary>
        /// Explains a rejection, for the debug panel.
        ///
        /// "rejected: carrot at 0.78m" is diagnosable in one glance. A detection that silently
        /// fails to appear is not, and the natural reaction is to start lowering the confidence
        /// threshold, which makes everything worse.
        /// </summary>
        public static string Explain(string label, Vector2 sizeMeters)
        {
            float longest = Mathf.Max(sizeMeters.x, sizeMeters.y);
            if (!Known.TryGetValue(label, out SizeRange range))
            {
                return $"{label} at {longest:F2}m (outside {AbsoluteMinM:F2}-{AbsoluteMaxM:F2}m)";
            }
            return $"{label} at {longest:F2}m (expected {range.MinM:F2}-{range.MaxM:F2}m)";
        }
    }
}
