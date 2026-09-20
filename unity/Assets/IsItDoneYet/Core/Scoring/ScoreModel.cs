using System;
using System.Collections.Generic;

namespace IsItDoneYet.Core
{
    /// <summary>How the coach judged one rubric item in one frame.</summary>
    public enum ObservationStatus { Unknown = 0, Ok = 1, Warn = 2, Bad = 3 }

    /// <summary>Everything that can happen during a run. The score is a function of this list.</summary>
    public enum ScoreEventKind
    {
        StepStarted,
        StepCompleted,
        /// <summary>A voted, confirmed coach judgement. Raw per-frame results never land here.</summary>
        Observation,
        /// <summary>Heat estimated below the step's band, sampled once a second while it holds.</summary>
        LowHeatSecond,
        SafetyWarning,
        RunFinished,
    }

    /// <summary>
    /// One entry in the log.
    ///
    /// A struct with no reference fields except two interned strings, so a whole run is a flat
    /// array with no allocation churn during play. `AtMs` is milliseconds from the run's start,
    /// never a wall clock: a score that depends on what time it is cannot be reproduced.
    /// </summary>
    [Serializable]
    public struct ScoreEvent
    {
        public int AtMs;
        public ScoreEventKind Kind;
        public int StepIndex;
        public string Item;
        public ObservationStatus Status;

        public static ScoreEvent Step(int atMs, ScoreEventKind kind, int stepIndex) =>
            new ScoreEvent { AtMs = atMs, Kind = kind, StepIndex = stepIndex, Item = null, Status = ObservationStatus.Unknown };

        public static ScoreEvent Observed(int atMs, int stepIndex, string item, ObservationStatus status) =>
            new ScoreEvent { AtMs = atMs, Kind = ScoreEventKind.Observation, StepIndex = stepIndex, Item = item, Status = status };
    }

    /// <summary>One step's expectations. Loaded from the recipe's rubric, never hard-coded.</summary>
    [Serializable]
    public class RubricStep
    {
        public int StepIndex;
        public string Text = string.Empty;
        /// <summary>The items the coach is asked about, verbatim. Order is the display order.</summary>
        public List<string> Items = new List<string>();
        /// <summary>Below this, the step was not really done. 0 means untimed.</summary>
        public int MinDurationSec;
        /// <summary>Past this the step is late. 0 means no ceiling.</summary>
        public int MaxDurationSec;
        public bool Hot;
        public bool Knife;
    }

    [Serializable]
    public class Rubric
    {
        public string RecipeSlug = string.Empty;
        public List<RubricStep> Steps = new List<RubricStep>();

        public RubricStep Step(int index) =>
            index >= 0 && index < Steps.Count ? Steps[index] : null;
    }

    /// <summary>
    /// Every number the scorer uses. None of them appear anywhere else.
    ///
    /// On a slider in the debug panel, per the project's own rule: rebuilding to the headset to
    /// try a different combo cap is how a Saturday disappears.
    /// </summary>
    [Serializable]
    public class ScoreConfig
    {
        public float PointsPerStep = 100f;
        public float PointsOk = 40f;
        public float PointsWarn = 10f;
        public float PointsBad = -25f;
        /// <summary>Unknown scores zero. Never negative: the cook is not penalised for the camera's blind spot.</summary>
        public float PointsUnknown = 0f;

        /// <summary>Multiplier added per consecutive clean step, capped.</summary>
        public float ComboStep = 0.25f;
        public float ComboMax = 2.0f;
        /// <summary>A flat bonus each time the streak reaches a multiple of this.</summary>
        public int StreakEvery = 3;
        public float StreakBonus = 75f;

        /// <summary>
        /// A step finished under its minimum loses this fraction of its points, scaled by how
        /// far under it was. Proportional rather than all-or-nothing, so being a second early
        /// costs a sliver and skipping the step entirely costs the lot.
        /// </summary>
        public float UnderMinDockFraction = 1.0f;
        public float LowHeatDockPerSecond = 4f;
        public float MaxLowHeatDockPerStep = 60f;
        public float SafetyWarningDock = 30f;

        /// <summary>The raw total that maps to 100. Above it the score clamps.</summary>
        public float PerfectPointsPerStep = 240f;
    }

    /// <summary>What one step earned and, if it lost points, exactly why.</summary>
    [Serializable]
    public struct StepScore
    {
        public int StepIndex;
        public float Earned;
        public float Docked;
        public float Multiplier;
        public int DurationSec;
        public string DockReason;
    }

    [Serializable]
    public class ScoreResult
    {
        public float RawPoints;
        /// <summary>0..100, one decimal. What the leaderboard stores.</summary>
        public float Percent;
        public int StepsCompleted;
        public int MaxStreak;
        public float FinalMultiplier;
        public List<StepScore> Steps = new List<StepScore>();
    }
}
