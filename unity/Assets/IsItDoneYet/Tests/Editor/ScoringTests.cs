using System.Collections.Generic;
using IsItDoneYet.Core;
using NUnit.Framework;

namespace IsItDoneYet.Tests
{
    /// <summary>
    /// The scorer. The property that matters most is the first one: the same log always yields
    /// the same number, because that is what lets the replay recompute rather than replay a
    /// recording of a number.
    /// </summary>
    public class ScoringTests
    {
        static Rubric TwoSteps(int minA = 0, int minB = 0)
        {
            var rubric = new Rubric { RecipeSlug = "test" };
            rubric.Steps.Add(new RubricStep { StepIndex = 0, Text = "dice the onion", MinDurationSec = minA, Items = { "onion diced evenly" } });
            rubric.Steps.Add(new RubricStep { StepIndex = 1, Text = "sear the patty", MinDurationSec = minB, Items = { "crust has formed" } });
            return rubric;
        }

        static ScoreConfig Config() => new ScoreConfig();

        static List<ScoreEvent> CleanRun(int stepDurationMs = 60_000)
        {
            return new List<ScoreEvent>
            {
                ScoreEvent.Step(0, ScoreEventKind.StepStarted, 0),
                ScoreEvent.Observed(1000, 0, "onion diced evenly", ObservationStatus.Ok),
                ScoreEvent.Step(stepDurationMs, ScoreEventKind.StepCompleted, 0),
                ScoreEvent.Step(stepDurationMs, ScoreEventKind.StepStarted, 1),
                ScoreEvent.Observed(stepDurationMs + 1000, 1, "crust has formed", ObservationStatus.Ok),
                ScoreEvent.Step(stepDurationMs * 2, ScoreEventKind.StepCompleted, 1),
            };
        }

        [Test]
        public void TheSameLogAlwaysYieldsTheSameScore()
        {
            var rubric = TwoSteps();
            var log = CleanRun();
            var first = ScoringEngine.Score(rubric, Config(), log);
            for (var i = 0; i < 20; i++)
            {
                Assert.That(ScoringEngine.Score(rubric, Config(), log).Percent, Is.EqualTo(first.Percent));
            }
        }

        [Test]
        public void ScoreIsZeroForAnEmptyLog()
        {
            Assert.That(ScoringEngine.Score(TwoSteps(), Config(), new List<ScoreEvent>()).Percent, Is.EqualTo(0f));
        }

        [Test]
        public void ScoreIsZeroWhenAnythingIsNull()
        {
            Assert.That(ScoringEngine.Score(null, Config(), new List<ScoreEvent>()).Percent, Is.EqualTo(0f));
            Assert.That(ScoringEngine.Score(TwoSteps(), null, new List<ScoreEvent>()).Percent, Is.EqualTo(0f));
            Assert.That(ScoringEngine.Score(TwoSteps(), Config(), null).Percent, Is.EqualTo(0f));
        }

        [Test]
        public void PercentIsAlwaysWithinRange()
        {
            var rubric = TwoSteps();
            var log = CleanRun();
            // Absurd config: the score must clamp rather than report 900%.
            var config = Config();
            config.PointsPerStep = 100_000f;
            var result = ScoringEngine.Score(rubric, config, log);
            Assert.That(result.Percent, Is.InRange(0f, 100f));
        }

        [Test]
        public void AStepFinishedUnderItsMinimumIsDockedProportionally()
        {
            var rubric = TwoSteps(minA: 100);
            var config = Config();

            var halfway = new List<ScoreEvent>
            {
                ScoreEvent.Step(0, ScoreEventKind.StepStarted, 0),
                ScoreEvent.Step(50_000, ScoreEventKind.StepCompleted, 0),
            };
            var barely = new List<ScoreEvent>
            {
                ScoreEvent.Step(0, ScoreEventKind.StepStarted, 0),
                ScoreEvent.Step(95_000, ScoreEventKind.StepCompleted, 0),
            };

            var halfwayDock = ScoringEngine.Score(rubric, config, halfway).Steps[0].Docked;
            var barelyDock = ScoringEngine.Score(rubric, config, barely).Steps[0].Docked;

            // Proportional, not all-or-nothing: a second early costs a sliver, skipping costs
            // the lot.
            Assert.That(barelyDock, Is.LessThan(halfwayDock));
            Assert.That(halfwayDock, Is.EqualTo(config.PointsPerStep * 0.5f).Within(1f));
        }

        [Test]
        public void AStepPastItsMinimumIsNotDocked()
        {
            var rubric = TwoSteps(minA: 30);
            var log = new List<ScoreEvent>
            {
                ScoreEvent.Step(0, ScoreEventKind.StepStarted, 0),
                ScoreEvent.Step(45_000, ScoreEventKind.StepCompleted, 0),
            };
            Assert.That(ScoringEngine.Score(rubric, Config(), log).Steps[0].Docked, Is.EqualTo(0f));
        }

        [Test]
        public void ADockedStepNamesItsReason()
        {
            var rubric = TwoSteps(minA: 100);
            var log = new List<ScoreEvent>
            {
                ScoreEvent.Step(0, ScoreEventKind.StepStarted, 0),
                ScoreEvent.Step(10_000, ScoreEventKind.StepCompleted, 0),
            };
            // "You lost points" with no reason is the feedback people remember as unfair.
            Assert.That(ScoringEngine.Score(rubric, Config(), log).Steps[0].DockReason, Does.Contain("10s of 100s"));
        }

        [Test]
        public void LowHeatDocksPerSecondAndIsCapped()
        {
            var rubric = TwoSteps();
            var config = Config();
            var log = new List<ScoreEvent> { ScoreEvent.Step(0, ScoreEventKind.StepStarted, 0) };
            for (var i = 0; i < 200; i++) log.Add(new ScoreEvent { AtMs = i * 1000, Kind = ScoreEventKind.LowHeatSecond, StepIndex = 0 });
            log.Add(ScoreEvent.Step(200_000, ScoreEventKind.StepCompleted, 0));

            var docked = ScoringEngine.Score(rubric, config, log).Steps[0].Docked;
            Assert.That(docked, Is.EqualTo(config.MaxLowHeatDockPerStep).Within(0.01f));
        }

        [Test]
        public void AnUnknownObservationIsNeverNegative()
        {
            // The cook is not penalised for the camera's blind spot.
            var rubric = TwoSteps();
            var config = Config();
            var withUnknown = new List<ScoreEvent>
            {
                ScoreEvent.Step(0, ScoreEventKind.StepStarted, 0),
                ScoreEvent.Observed(1000, 0, "onion diced evenly", ObservationStatus.Unknown),
                ScoreEvent.Step(60_000, ScoreEventKind.StepCompleted, 0),
            };
            var withNothing = new List<ScoreEvent>
            {
                ScoreEvent.Step(0, ScoreEventKind.StepStarted, 0),
                ScoreEvent.Step(60_000, ScoreEventKind.StepCompleted, 0),
            };
            Assert.That(ScoringEngine.Score(rubric, config, withUnknown).RawPoints,
                        Is.EqualTo(ScoringEngine.Score(rubric, config, withNothing).RawPoints).Within(0.01f));
        }

        [Test]
        public void ACleanRunBuildsAStreakAndABadOneBreaksIt()
        {
            var rubric = TwoSteps();
            var clean = ScoringEngine.Score(rubric, Config(), CleanRun());
            Assert.That(clean.MaxStreak, Is.EqualTo(2));

            var log = CleanRun();
            log[4] = ScoreEvent.Observed(61_000, 1, "crust has formed", ObservationStatus.Bad);
            var broken = ScoringEngine.Score(rubric, Config(), log);
            Assert.That(broken.MaxStreak, Is.EqualTo(1));
            Assert.That(broken.FinalMultiplier, Is.EqualTo(1f));
        }

        [Test]
        public void TheComboIsAppliedAfterTheDockNotBefore()
        {
            // Multiplying the gross would let a long streak outrun the penalty for skipping
            // steps -- which is exactly the behaviour somebody would find and exploit.
            var rubric = TwoSteps(minB: 100);
            var config = Config();
            var log = new List<ScoreEvent>
            {
                ScoreEvent.Step(0, ScoreEventKind.StepStarted, 0),
                ScoreEvent.Observed(500, 0, "onion diced evenly", ObservationStatus.Ok),
                ScoreEvent.Step(60_000, ScoreEventKind.StepCompleted, 0),
                ScoreEvent.Step(60_000, ScoreEventKind.StepStarted, 1),
                ScoreEvent.Step(61_000, ScoreEventKind.StepCompleted, 1),
            };
            var result = ScoringEngine.Score(rubric, config, log);
            var skipped = result.Steps[1];
            Assert.That(skipped.Docked, Is.GreaterThan(0f));
            // Net is floored at zero, so a heavily docked step can never earn more than a clean
            // one just because a multiplier was running.
            Assert.That(skipped.Earned, Is.LessThan(result.Steps[0].Earned));
        }

        [Test]
        public void AnIncompleteStepScoresNothingButStillCountsAgainstThePerfectTotal()
        {
            // Normalising against completed steps only would make one perfect step out of nine
            // read as 100%.
            var rubric = TwoSteps();
            var onlyFirst = new List<ScoreEvent>
            {
                ScoreEvent.Step(0, ScoreEventKind.StepStarted, 0),
                ScoreEvent.Observed(500, 0, "onion diced evenly", ObservationStatus.Ok),
                ScoreEvent.Step(60_000, ScoreEventKind.StepCompleted, 0),
            };
            var result = ScoringEngine.Score(rubric, Config(), onlyFirst);
            Assert.That(result.StepsCompleted, Is.EqualTo(1));
            Assert.That(result.Percent, Is.LessThan(60f));
        }

        [Test]
        public void ReenteringAStepDoesNotResetItsClock()
        {
            // Stepping back and forward would otherwise be a way to erase a duration dock.
            var rubric = TwoSteps(minA: 100);
            var log = new List<ScoreEvent>
            {
                ScoreEvent.Step(0, ScoreEventKind.StepStarted, 0),
                ScoreEvent.Step(90_000, ScoreEventKind.StepStarted, 0),
                ScoreEvent.Step(95_000, ScoreEventKind.StepCompleted, 0),
            };
            var result = ScoringEngine.Score(rubric, Config(), log);
            Assert.That(result.Steps[0].DurationSec, Is.EqualTo(95));
        }

        [Test]
        public void EventsForAStepThatDoesNotExistAreIgnored()
        {
            var rubric = TwoSteps();
            var log = new List<ScoreEvent>
            {
                ScoreEvent.Step(0, ScoreEventKind.StepStarted, 99),
                ScoreEvent.Observed(1, -3, "nothing", ObservationStatus.Ok),
            };
            Assert.DoesNotThrow(() => ScoringEngine.Score(rubric, Config(), log));
        }

        [Test]
        public void SafetyWarningsDock()
        {
            var rubric = TwoSteps();
            var config = Config();
            var log = new List<ScoreEvent>
            {
                ScoreEvent.Step(0, ScoreEventKind.StepStarted, 0),
                new ScoreEvent { AtMs = 1000, Kind = ScoreEventKind.SafetyWarning, StepIndex = 0 },
                ScoreEvent.Step(60_000, ScoreEventKind.StepCompleted, 0),
            };
            Assert.That(ScoringEngine.Score(rubric, config, log).Steps[0].Docked, Is.EqualTo(config.SafetyWarningDock));
        }

        [TestCase("ok", ObservationStatus.Ok)]
        [TestCase("warn", ObservationStatus.Warn)]
        [TestCase("bad", ObservationStatus.Bad)]
        [TestCase("unknown", ObservationStatus.Unknown)]
        public void ParseStatus_AcceptsTheFourLegalStrings(string raw, ObservationStatus expected)
        {
            Assert.That(ScoringEngine.ParseStatus(raw), Is.EqualTo(expected));
        }

        [TestCase("OK")]
        [TestCase("OK!")]
        [TestCase("Ok")]
        [TestCase("")]
        [TestCase(null)]
        [TestCase("great")]
        public void ParseStatus_TreatsAnythingElseAsUnknown(string raw)
        {
            // Never a throw, never a guess at the nearest match. A model that once writes "OK!"
            // should cost one frame of commentary, not a crash and not an invented pass.
            Assert.That(ScoringEngine.ParseStatus(raw), Is.EqualTo(ObservationStatus.Unknown));
        }
    }
}
