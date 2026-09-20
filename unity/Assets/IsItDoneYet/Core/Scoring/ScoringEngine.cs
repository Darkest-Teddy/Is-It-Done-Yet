using System.Collections.Generic;
using UnityEngine;

namespace IsItDoneYet.Core
{
    /// <summary>
    /// The score. Deterministic, local, and nothing to do with the language model.
    ///
    /// This is the reason the coach is allowed to be offline. The model contributes
    /// <i>observations</i>, and observations are already voted and confirmed before they reach
    /// the log (see <see cref="CoachVote"/>); everything after that is arithmetic over an ordered
    /// list. The same log always yields the same number -- no wall clock, no random, no floating
    /// accumulation whose order depends on a dictionary's iteration.
    ///
    /// That property is what makes the replay screen honest: it replays the log and recomputes,
    /// rather than replaying a recording of a number.
    /// </summary>
    public static class ScoringEngine
    {
        public static ScoreResult Score(Rubric rubric, ScoreConfig config, IReadOnlyList<ScoreEvent> log)
        {
            var result = new ScoreResult();
            if (rubric == null || config == null || log == null) return result;

            var stepCount = rubric.Steps.Count;
            if (stepCount == 0) return result;

            // Indexed by step, so the pass below can stay a single ordered walk of the log.
            var startedAtMs = new int[stepCount];
            var completedAtMs = new int[stepCount];
            var lowHeatSeconds = new int[stepCount];
            var safetyWarnings = new int[stepCount];
            var observationPoints = new float[stepCount];
            var observedBad = new bool[stepCount];
            for (var i = 0; i < stepCount; i++) { startedAtMs[i] = -1; completedAtMs[i] = -1; }

            for (var e = 0; e < log.Count; e++)
            {
                var ev = log[e];
                if (ev.StepIndex < 0 || ev.StepIndex >= stepCount) continue;
                var i = ev.StepIndex;

                switch (ev.Kind)
                {
                    case ScoreEventKind.StepStarted:
                        // First start wins. A step re-entered after a back-navigation must not
                        // reset its clock, or stepping back and forward is a way to erase a
                        // duration dock.
                        if (startedAtMs[i] < 0) startedAtMs[i] = ev.AtMs;
                        break;

                    case ScoreEventKind.StepCompleted:
                        if (completedAtMs[i] < 0) completedAtMs[i] = ev.AtMs;
                        break;

                    case ScoreEventKind.Observation:
                        observationPoints[i] += PointsFor(ev.Status, config);
                        if (ev.Status == ObservationStatus.Bad) observedBad[i] = true;
                        break;

                    case ScoreEventKind.LowHeatSecond:
                        lowHeatSeconds[i] += 1;
                        break;

                    case ScoreEventKind.SafetyWarning:
                        safetyWarnings[i] += 1;
                        break;
                }
            }

            var streak = 0;
            var maxStreak = 0;
            var multiplier = 1.0f;

            for (var i = 0; i < stepCount; i++)
            {
                if (completedAtMs[i] < 0) continue;

                var step = rubric.Steps[i];
                var startedAt = startedAtMs[i] < 0 ? completedAtMs[i] : startedAtMs[i];
                var durationSec = Mathf.Max(0, (completedAtMs[i] - startedAt)) / 1000;

                var earned = config.PointsPerStep + observationPoints[i];
                var docked = 0f;
                string reason = null;

                // A step finished under its minimum: dock in proportion to the shortfall.
                if (step.MinDurationSec > 0 && durationSec < step.MinDurationSec)
                {
                    var shortfall = 1.0f - (float)durationSec / step.MinDurationSec;
                    var amount = config.PointsPerStep * config.UnderMinDockFraction * shortfall;
                    docked += amount;
                    reason = $"finished in {durationSec}s of {step.MinDurationSec}s";
                }

                if (lowHeatSeconds[i] > 0)
                {
                    var amount = Mathf.Min(lowHeatSeconds[i] * config.LowHeatDockPerSecond, config.MaxLowHeatDockPerStep);
                    docked += amount;
                    reason = reason == null
                        ? $"heat looked low for {lowHeatSeconds[i]}s"
                        : $"{reason}; heat looked low for {lowHeatSeconds[i]}s";
                }

                if (safetyWarnings[i] > 0)
                {
                    docked += safetyWarnings[i] * config.SafetyWarningDock;
                    reason = reason == null ? "safety warning" : $"{reason}; safety warning";
                }

                // The combo is applied to what survived the docks, not to the gross.
                // Multiplying first would let a long streak outrun the penalty for skipping
                // steps, which is exactly the behaviour somebody would find and exploit.
                var net = Mathf.Max(0f, earned - docked);
                var scored = net * multiplier;

                var clean = docked <= 0f && !observedBad[i];
                if (clean)
                {
                    streak += 1;
                    if (streak > maxStreak) maxStreak = streak;
                    multiplier = Mathf.Min(config.ComboMax, multiplier + config.ComboStep);
                    if (config.StreakEvery > 0 && streak % config.StreakEvery == 0) scored += config.StreakBonus;
                }
                else
                {
                    streak = 0;
                    multiplier = 1.0f;
                }

                result.RawPoints += scored;
                result.StepsCompleted += 1;
                result.Steps.Add(new StepScore
                {
                    StepIndex = i,
                    Earned = scored,
                    Docked = docked,
                    Multiplier = multiplier,
                    DurationSec = durationSec,
                    DockReason = reason,
                });
            }

            result.MaxStreak = maxStreak;
            result.FinalMultiplier = multiplier;

            // Normalised against every step in the recipe, not against the ones that were
            // completed. Otherwise finishing one step out of nine perfectly is 100%.
            var perfect = config.PerfectPointsPerStep * stepCount;
            var percent = perfect <= 0f ? 0f : result.RawPoints / perfect * 100f;
            result.Percent = Mathf.Round(Mathf.Clamp(percent, 0f, 100f) * 10f) / 10f;
            return result;
        }

        static float PointsFor(ObservationStatus status, ScoreConfig config)
        {
            switch (status)
            {
                case ObservationStatus.Ok: return config.PointsOk;
                case ObservationStatus.Warn: return config.PointsWarn;
                case ObservationStatus.Bad: return config.PointsBad;
                default: return config.PointsUnknown;
            }
        }

        /// <summary>
        /// Parses the four status strings the server is allowed to send.
        ///
        /// Anything else is <see cref="ObservationStatus.Unknown"/>, never a throw and never a
        /// guess at the nearest match. A model that once writes "OK!" should cost one frame of
        /// commentary, not a crash and not an invented pass.
        /// </summary>
        public static ObservationStatus ParseStatus(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return ObservationStatus.Unknown;
            switch (raw)
            {
                case "ok": return ObservationStatus.Ok;
                case "warn": return ObservationStatus.Warn;
                case "bad": return ObservationStatus.Bad;
                case "unknown": return ObservationStatus.Unknown;
                default: return ObservationStatus.Unknown;
            }
        }
    }
}
