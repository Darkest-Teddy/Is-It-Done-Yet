using System;

namespace MRPerception
{
    /// <summary>
    /// What advances a step.
    ///
    /// Be honest about the distribution: most steps are <see cref="Seconds"/> or
    /// <see cref="Manual"/>, and only a few are genuinely perception-driven. The reference
    /// concept video says so out loud -- its instruction reads "add salt (2 sec)", which is a
    /// timer, not a detector. Pretending otherwise leads to building six fragile gesture
    /// detectors for things a two-second countdown covers better.
    ///
    /// Detection earns its place on steps where something appears or leaves: a pan arriving on
    /// the hob, the last ingredient reaching the counter. Those are easy, robust and visible.
    /// </summary>
    public enum StepTrigger
    {
        /// <summary>Waits for the user. The safe default for anything hard to see.</summary>
        Manual,
        /// <summary>A matching label shows up in the tracked set.</summary>
        Appears,
        /// <summary>A label leaves the tracked set -- the pepper was taken off the board.</summary>
        Disappears,
        /// <summary>At least N matching objects present. Cut something up and count the pieces.</summary>
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
        /// Which tracked object this step is ABOUT. Empty floats the instruction.
        ///
        /// An ARRAY because one real object has several names. A frying pan seen from above is
        /// routinely called "bowl" by a COCO model and "frying pan" by GPT, and the step should
        /// anchor to it either way.
        ///
        /// This is the piece that makes the reference look the way it does: the box is not
        /// around the food, it is around whatever the current step concerns -- the hob, then the
        /// pan. Both are large, stable and easily detected, which is why it works.
        /// </summary>
        public string[] AnchorLabels = Array.Empty<string>();

        public StepTrigger Trigger = StepTrigger.Manual;
        public string[] TriggerLabels = Array.Empty<string>();
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
        /// Labels that satisfy it. Empty for things vision will never see.
        ///
        /// Ordered most-specific first purely for readability; matching is order-independent.
        /// Where a COCO class exists it is included as a fallback, so the item still ticks with
        /// the network off.
        /// </summary>
        public string[] DetectLabels = Array.Empty<string>();

        /// <summary>
        /// Never detectable -- cumin, paprika, salt. Struck through on progress instead.
        ///
        /// More honest than pretending a detector might find a teaspoon of ground spice, and it
        /// avoids a checklist that sits stuck forever with no explanation.
        /// </summary>
        public bool Optional;

        /// <summary>
        /// True when no COCO class can see this, so it needs the vision provider.
        ///
        /// Recorded so the rail can say why an item is not ticking when running offline, rather
        /// than leaving somebody to work it out from a blank checklist.
        /// </summary>
        public bool NeedsVisionProvider;
    }

    [Serializable]
    public sealed class Recipe
    {
        public string Name;

        /// <summary>
        /// True when every non-optional ingredient has a COCO class behind it, so the recipe
        /// runs with the network off.
        /// </summary>
        public bool WorksOffline;

        public Ingredient[] Ingredients = Array.Empty<Ingredient>();
        public RecipeStep[] Steps = Array.Empty<RecipeStep>();

        // COCO-80's entire kitchen vocabulary, for reference while authoring:
        //   bottle, wine glass, cup, fork, knife, spoon, bowl,
        //   banana, apple, sandwich, orange, broccoli, carrot, hot dog, pizza, donut, cake,
        //   diningtable, microwave, oven, toaster, sink, refrigerator
        // Everything else in a kitchen -- pepper, egg, garlic, onion, cheese, pan, hob -- is
        // invisible to it and needs the vision provider.

        /// <summary>
        /// Every ingredient and anchor is a real COCO class, so this runs with no network at
        /// all.
        ///
        /// This is the one to demo on venue wifi, and the one to rehearse with. Master spec
        /// 5.2.3 wants the full demo runnable offline and rehearsed that way at least once;
        /// a recipe whose every step depends on a cloud round trip cannot satisfy that.
        /// </summary>
        public static Recipe FruitSalad() => new()
        {
            Name = "Fruit salad",
            WorksOffline = true,
            Ingredients = new[]
            {
                new Ingredient { Text = "1 banana", DetectLabels = new[] { "banana" } },
                new Ingredient { Text = "1 apple", DetectLabels = new[] { "apple" } },
                new Ingredient { Text = "1 orange", DetectLabels = new[] { "orange" } },
                new Ingredient { Text = "1 bowl", DetectLabels = new[] { "bowl" } },
                new Ingredient { Text = "a knife", DetectLabels = new[] { "knife" } },
            },
            Steps = new[]
            {
                new RecipeStep
                {
                    Rail = "ingredients",
                    Instruction = "get the fruit out",
                    Trigger = StepTrigger.Manual,
                },
                new RecipeStep
                {
                    Rail = "bowl out",
                    Instruction = "put the bowl down",
                    AnchorLabels = new[] { "bowl" },
                    Trigger = StepTrigger.Appears,
                    TriggerLabels = new[] { "bowl" },
                },
                new RecipeStep
                {
                    Rail = "cutting",
                    Instruction = "slice the banana",
                    AnchorLabels = new[] { "knife" },
                    // Counting slices is the one genuinely perception-driven food step here, and
                    // it still keeps its manual override: a slice half behind a hand is not a
                    // slice as far as the detector is concerned.
                    Trigger = StepTrigger.CountAtLeast,
                    TriggerLabels = new[] { "banana" },
                    TriggerCount = 2,
                },
                new RecipeStep
                {
                    Rail = "plating",
                    Instruction = "into the bowl",
                    AnchorLabels = new[] { "bowl" },
                    Trigger = StepTrigger.Seconds,
                    TriggerSeconds = 10f,
                },
                new RecipeStep { Rail = "done", Instruction = "done", Trigger = StepTrigger.Never },
            },
        };

        /// <summary>
        /// The reference video's recipe. NEEDS THE VISION PROVIDER.
        ///
        /// Pepper, egg and garlic have no COCO class and never will -- COCO's ten foods are
        /// prepared dishes. With the provider off these three never tick and the checklist
        /// stalls, which is correct behaviour and is why <see cref="WorksOffline"/> is false.
        ///
        /// Where a COCO class is a plausible stand-in it is listed as a fallback: a tall tin
        /// often reads as "bottle", and a frying pan seen from above reads as "bowl"
        /// surprisingly reliably. Those are not corrections to the model, they are alternative
        /// names for the same pixels, and matching on either is the honest thing to do.
        /// </summary>
        public static Recipe Shakshuka() => new()
        {
            Name = "Shakshuka",
            WorksOffline = false,
            Ingredients = new[]
            {
                new Ingredient
                {
                    Text = "1 pepper",
                    DetectLabels = new[] { "bell pepper", "pepper", "capsicum" },
                    NeedsVisionProvider = true,
                },
                new Ingredient
                {
                    Text = "4 eggs",
                    DetectLabels = new[] { "egg", "eggs" },
                    NeedsVisionProvider = true,
                },
                new Ingredient
                {
                    Text = "1 can crushed tomatoes",
                    // "bottle" is the COCO fallback: a tall tin frequently reads as one.
                    DetectLabels = new[] { "canned tomatoes", "tin", "can", "bottle" },
                },
                new Ingredient
                {
                    Text = "1 garlic clove",
                    DetectLabels = new[] { "garlic" },
                    NeedsVisionProvider = true,
                },
                new Ingredient
                {
                    // The one ingredient COCO genuinely sees.
                    Text = "2 tablespoons olive oil",
                    DetectLabels = new[] { "olive oil", "bottle" },
                },
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
                    AnchorLabels = new[] { "knife" },     // COCO class
                    Trigger = StepTrigger.CountAtLeast,
                    TriggerLabels = new[] { "bell pepper", "pepper" },
                    TriggerCount = 3,
                },
                new RecipeStep
                {
                    Rail = "pan on",
                    Instruction = "put the pan on",
                    // "oven" is COCO's nearest thing to a hob, and an induction top often trips
                    // it. Listed last so a real name wins when the provider supplies one.
                    AnchorLabels = new[] { "hob", "stove", "cooktop", "oven" },
                    Trigger = StepTrigger.Appears,
                    TriggerLabels = new[] { "frying pan", "pan", "skillet", "bowl" },
                },
                new RecipeStep
                {
                    Rail = "pouring",
                    Instruction = "pour in the tomatoes",
                    AnchorLabels = new[] { "frying pan", "pan", "skillet", "bowl" },
                    Trigger = StepTrigger.Seconds,
                    TriggerSeconds = 8f,
                },
                new RecipeStep
                {
                    Rail = "salting",
                    Instruction = "add salt (2 sec)",
                    AnchorLabels = new[] { "frying pan", "pan", "skillet", "bowl" },
                    Trigger = StepTrigger.Seconds,
                    TriggerSeconds = 2f,
                },
                new RecipeStep
                {
                    Rail = "cracking",
                    Instruction = "crack the eggs in",
                    AnchorLabels = new[] { "frying pan", "pan", "skillet", "bowl" },
                    Trigger = StepTrigger.Manual,
                },
                new RecipeStep
                {
                    Rail = "waiting",
                    Instruction = "let it set",
                    AnchorLabels = new[] { "frying pan", "pan", "skillet", "bowl" },
                    Trigger = StepTrigger.Seconds,
                    TriggerSeconds = 20f,
                },
                new RecipeStep { Rail = "done", Instruction = "done", Trigger = StepTrigger.Never },
            },
        };
    }
}
