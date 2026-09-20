using System;
using System.Collections.Generic;

namespace MRPerception
{
    /// <summary>
    /// The recipe state machine.
    ///
    /// WHY THIS CHANGES WHAT THE DETECTOR IS FOR, which is the point of the whole file. Without
    /// a recipe, perception has to answer "what is on this counter" -- an open question, against
    /// a model that knows ten foods, on a wooden surface that generates false positives. With a
    /// recipe, it answers "has the pan arrived yet", which is closed, expected, and easy. A step
    /// knows what it is waiting for, so a detection that is not that is simply not interesting.
    ///
    /// EVERY OBJECT HAS TWO NAMES and both are matched. COCO calls it "bottle", GPT calls it
    /// "bottle of olive oil"; COCO says "broccoli", GPT says "romanesco". Feeding only one of
    /// them in means the recipe misses whichever vocabulary it was not written against, and the
    /// checklist sits there never ticking while the object is plainly on the counter. So
    /// <see cref="Observe"/> takes a list of alternatives per track, and matching goes through
    /// <see cref="LabelMatch"/> rather than string equality.
    ///
    /// Deliberately free of UnityEngine. Labels and a timestamp in, state out, so it can be
    /// unit-tested in EditMode with no scene, no headset and no camera -- which matters, because
    /// a state machine that strands the demo on step four is discovered in front of a judge
    /// otherwise.
    /// </summary>
    public sealed class RecipeRunner
    {
        private readonly Recipe _recipe;

        /// <summary>Every label ever seen, raw. Matching happens against this, not into it.</summary>
        private readonly List<string> _acquired = new();

        private int _index;
        private float _stepEnteredAt;
        private bool _started;

        public RecipeRunner(Recipe recipe)
        {
            _recipe = recipe ?? throw new ArgumentNullException(nameof(recipe));
        }

        public Recipe Recipe => _recipe;
        public int Index => _index;

        public RecipeStep Current =>
            _recipe.Steps != null && _index < _recipe.Steps.Length ? _recipe.Steps[_index] : null;

        public bool Complete => Current == null || Current.Trigger == StepTrigger.Never;

        /// <summary>Seconds on the current step. Drives the countdown on timed steps.</summary>
        public float ElapsedOnStep(float now) => _started ? now - _stepEnteredAt : 0f;

        /// <summary>
        /// How far through a timed step, 0..1, or -1 when the step is not timed.
        /// Worth rendering: a countdown the user can see beats an instruction that changes
        /// without warning.
        /// </summary>
        public float StepProgress(float now)
        {
            RecipeStep step = Current;
            if (step == null || step.Trigger != StepTrigger.Seconds || step.TriggerSeconds <= 0f)
            {
                return -1f;
            }
            float t = ElapsedOnStep(now) / step.TriggerSeconds;
            return t < 0f ? 0f : t > 1f ? 1f : t;
        }

        public bool HasIngredient(Ingredient ingredient)
        {
            if (ingredient == null) return false;
            // Things vision will never see are struck through by progress rather than by
            // detection -- more honest than a checklist stuck forever on "1 teaspoon cumin".
            if (ingredient.Optional) return _index > 0;

            foreach (string seen in _acquired)
            {
                if (LabelMatch.MatchesAny(ingredient.DetectLabels, seen)) return true;
            }
            return false;
        }

        /// <summary>Ingredients still outstanding, for the "you need" list.</summary>
        public IEnumerable<Ingredient> Outstanding()
        {
            if (_recipe.Ingredients == null) yield break;
            foreach (Ingredient i in _recipe.Ingredients)
            {
                if (!HasIngredient(i)) yield return i;
            }
        }

        /// <summary>
        /// Feeds one frame of tracked labels in and advances if the step's trigger is met.
        ///
        /// Each entry may carry several alternatives for the same object -- typically the local
        /// detector's class and the vision provider's name. Any of them matching counts.
        ///
        /// Returns true on the frame a step actually changed, so the caller can bark, play a
        /// sound, or redraw without diffing state itself.
        /// </summary>
        public bool Observe(IReadOnlyList<string[]> tracks, float now)
        {
            if (!_started)
            {
                _started = true;
                _stepEnteredAt = now;
            }

            // Anything ever seen counts as acquired and STAYS acquired. An ingredient that rolls
            // behind the bowl has not stopped existing, and a checklist that un-ticks itself is
            // worse than one that never ticked.
            if (tracks != null)
            {
                foreach (string[] names in tracks)
                {
                    if (names == null) continue;
                    foreach (string label in names)
                    {
                        if (string.IsNullOrWhiteSpace(label)) continue;
                        if (!_acquired.Contains(label)) _acquired.Add(label);
                    }
                }
            }

            RecipeStep step = Current;
            if (step == null) return false;

            bool fire = step.Trigger switch
            {
                StepTrigger.Seconds => now - _stepEnteredAt >= step.TriggerSeconds,
                StepTrigger.Appears => AnyPresent(tracks, step.TriggerLabels),
                // Only counts as a disappearance if it was there to begin with. Otherwise the
                // step completes instantly on entry, having never seen the thing leave.
                StepTrigger.Disappears =>
                    WasAcquired(step.TriggerLabels) && !AnyPresent(tracks, step.TriggerLabels),
                StepTrigger.CountAtLeast =>
                    CountPresent(tracks, step.TriggerLabels) >= step.TriggerCount,
                _ => false,
            };

            return fire && Advance(now);
        }

        /// <summary>
        /// The user pushing the step along by hand.
        ///
        /// Refused only on a step that explicitly forbids it, which nothing does by default.
        /// This is the escape hatch that keeps a failed detection from ending the demo.
        /// </summary>
        public bool AdvanceManually(float now)
        {
            RecipeStep step = Current;
            if (step == null || !step.ManualOverride) return false;
            return Advance(now);
        }

        public void Back(float now)
        {
            if (_index == 0) return;
            _index--;
            _stepEnteredAt = now;
        }

        public void Restart(float now)
        {
            _index = 0;
            _stepEnteredAt = now;
            _acquired.Clear();
        }

        /// <summary>
        /// The instruction to show on a given tracked object, or null.
        ///
        /// This is how the anchored box in the reference works: the current step names some
        /// labels, and whichever tracked object matches one shows the instruction instead of its
        /// own name. No new rendering and no second anchoring system -- the box that already
        /// exists around the pan simply says "add salt" while that step is live.
        /// </summary>
        public string InstructionFor(string trackedLabel)
        {
            RecipeStep step = Current;
            if (step == null || string.IsNullOrEmpty(trackedLabel)) return null;
            return LabelMatch.MatchesAny(step.AnchorLabels, trackedLabel) ? step.Instruction : null;
        }

        private bool Advance(float now)
        {
            if (_recipe.Steps == null || _index >= _recipe.Steps.Length - 1) return false;
            _index++;
            _stepEnteredAt = now;
            return true;
        }

        private bool WasAcquired(string[] wanted)
        {
            foreach (string seen in _acquired)
            {
                if (LabelMatch.MatchesAny(wanted, seen)) return true;
            }
            return false;
        }

        private static bool AnyPresent(IReadOnlyList<string[]> tracks, string[] wanted)
        {
            if (tracks == null || wanted == null || wanted.Length == 0) return false;
            for (int i = 0; i < tracks.Count; i++)
            {
                if (TrackMatches(tracks[i], wanted)) return true;
            }
            return false;
        }

        /// <summary>
        /// Counts OBJECTS, not names.
        ///
        /// A track carries both the detector's class and the provider's name, so counting names
        /// would score one banana as two the moment GPT called it "sliced banana" -- and
        /// CountAtLeast would fire on a single uncut piece of fruit.
        /// </summary>
        private static int CountPresent(IReadOnlyList<string[]> tracks, string[] wanted)
        {
            if (tracks == null || wanted == null || wanted.Length == 0) return 0;
            int n = 0;
            for (int i = 0; i < tracks.Count; i++)
            {
                if (TrackMatches(tracks[i], wanted)) n++;
            }
            return n;
        }

        /// <summary>True when ANY of a track's names matches any wanted label.</summary>
        private static bool TrackMatches(string[] names, string[] wanted)
        {
            if (names == null) return false;
            foreach (string name in names)
            {
                if (LabelMatch.MatchesAny(wanted, name)) return true;
            }
            return false;
        }
    }
}
