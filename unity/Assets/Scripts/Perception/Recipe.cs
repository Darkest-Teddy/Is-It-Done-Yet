using System;

namespace MRPerception
{
    /// <summary>
    /// What advances a step.
    ///
    /// Be honest about the distribution here: most steps are <see cref="Seconds"/> or
    /// <see cref="Manual"/>, and only a few are genuinely perception-driven. The reference
    /// concept video says so out loud -- its instruction reads "add salt (2 sec)", which is a
    /// timer, not a detector. Pretending otherwise leads to building six fragile detectors for
    /// gestures that a two-second countdown covers better.
    ///
    /// Detection earns its place on the steps where something appears or leaves: a pan arriving
    /// on the hob, the last ingredient reaching the counter. Those are easy, robust, and
    /// visible. The rest is timing.
    /// </summary>
    public enum StepTrigger
    {
        /// <summary>Waits for the user. The safe default for anything hard to see.</summary>
        Manual,
        /// <summary>A label shows up in the tracked set.</summary>
        Appears,
        /// <summary>A label leaves the tracked set -- the pepper was taken off the board.</summary>
        Disappears,
        /// <summary>At least N of a label are present. Cut something into pieces and count them.</summary>
        CountAtLeast,
        /// <summary>A fixed time after the step began.</summary>
        Seconds,
        /// <summary>Terminal. Nothing advances past it.</summary>
        Never
    }

    /// <summary>One line on the rail, and one instruction anchored in the world.</summary>
    [Serializable]
    public sealed class RecipeStep
    {
        /// <summary>Short, lowercase, shown on the left rail: "cutting", "salting".</summary>
        public string Rail;

        /// <summary>The instruction, anchored to the object below: "put the pan on".</summary>
        public string Instruction;

        /// <summary>
        /// Which tracked object this step is ABOUT, by label. Null floats the instruction.
        ///
        /// This is the piece that makes the reference look the way it does: the box is not
        /// around the food, it is around whatever the current step concerns -- the hob, then the
        /// pan. Both are large, stable and trivially detected, which is why it works.
        /// </summary>
        public string AnchorLabel;

        public StepTrigger Trigger = StepTrigger.Manual;
        public string TriggerLabel;
        public int TriggerCount = 1;
        public float TriggerSeconds = 3f;

        /// <summary>
        /// Whether the user can always advance past this step by hand.
        ///
        /// Default true, and it should stay true. Master spec rule #12: pick what survives a
        /// live demo. If the pan is not detected -- bad light, wrong angle, somebody's arm in
        /// the way -- the demo must not be stranded on step four in front of a judge. An
        /// automatic trigger that works is a nice touch; a manual override that always works is
        /// the difference between a demo and an apology.
        /// </summary>
        public bool ManualOverride = true;
    }

    /// <summary>A line in the "you need" checklist.</summary>
    [Serializable]
    public sealed class Ingredient
    {
        /// <summary>As written on the list: "1 pepper", "2 tablespoons olive oil".</summary>
        public string Text;

        /// <summary>
        /// The tracked label that satisfies it, or null for things vision will never see.
        ///
        /// Cumin and paprika are never going to be detected, and marking them optional is more
        /// honest than pretending a detector might find them. They show on the list, they are
        /// struck through when the step completes, and nobody has to explain why the checklist
        /// is stuck.
        /// </summary>
        public string DetectLabel;

        public bool Optional;
    }

    [Serializable]
    public sealed class Recipe
    {
        public string Name;
        public Ingredient[] Ingredients;
        public RecipeStep[] Steps;

        /// <summary>
        /// Shakshuka, matching the reference video's rail.
        ///
        /// Built in rather than authored in the inspector so the whole flow runs the moment the
        /// component is dropped on a GameObject, with no scene setup. Swap it for your own at
        /// leisure; the point is that there is something to run on arrival.
        /// </summary>
        public static Recipe Shakshuka() => new()
        {
            Name = "Shakshuka",
            Ingredients = new[]
            {
                new Ingredient { Text = "1 pepper", DetectLabel = "pepper" },
                new Ingredient { Text = "4 eggs", DetectLabel = "egg" },
                new Ingredient { Text = "1 can crushed tomatoes", DetectLabel = "can" },
                new Ingredient { Text = "1 garlic clove", DetectLabel = "garlic" },
                new Ingredient { Text = "2 tablespoons olive oil", DetectLabel = "bottle" },
                new Ingredient { Text = "1 teaspoon cumin", Optional = true },
                new Ingredient { Text = "1 teaspoon paprika", Optional = true },
                new Ingredient { Text = "1 teaspoon salt", Optional = true },
                new Ingredient { Text = "fresh parsley", Optional = true },
            },
            Steps = new[]
            {
                new RecipeStep
                {
                    Rail = "ingredients",
                    Instruction = "get everything out",
                    Trigger = StepTrigger.Manual,
                },
                new RecipeStep
                {
                    Rail = "cutting",
                    Instruction = "do one step at a time",
                    AnchorLabel = "knife",
                    // Counting pieces is the one genuinely perception-driven food step here,
                    // and it is still worth a manual override: a pepper half behind a hand is
                    // not a piece as far as the detector is concerned.
                    Trigger = StepTrigger.CountAtLeast,
                    TriggerLabel = "pepper",
                    TriggerCount = 3,
                },
                new RecipeStep
                {
                    Rail = "pan on",
                    Instruction = "put the pan on",
                    AnchorLabel = "hob",
                    Trigger = StepTrigger.Appears,
                    TriggerLabel = "pan",
                },
                new RecipeStep
                {
                    Rail = "pouring",
                    Instruction = "pour in the tomatoes",
                    AnchorLabel = "pan",
                    Trigger = StepTrigger.Seconds,
                    TriggerSeconds = 8f,
                },
                new RecipeStep
                {
                    Rail = "salting",
                    Instruction = "add salt (2 sec)",
                    AnchorLabel = "pan",
                    Trigger = StepTrigger.Seconds,
                    TriggerSeconds = 2f,
                },
                new RecipeStep
                {
                    Rail = "cracking",
                    Instruction = "crack the eggs in",
                    AnchorLabel = "pan",
                    Trigger = StepTrigger.Manual,
                },
                new RecipeStep
                {
                    Rail = "waiting",
                    Instruction = "let it set",
                    AnchorLabel = "pan",
                    Trigger = StepTrigger.Seconds,
                    TriggerSeconds = 20f,
                },
                new RecipeStep
                {
                    Rail = "done",
                    Instruction = "done",
                    Trigger = StepTrigger.Never,
                },
            },
        };
    }
}
