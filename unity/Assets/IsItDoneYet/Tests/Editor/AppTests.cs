using IsItDoneYet.App;
using IsItDoneYet.Audio;
using IsItDoneYet.Core;
using IsItDoneYet.Design;
using NUnit.Framework;
using UnityEngine;

namespace IsItDoneYet.Tests
{
    /// <summary>
    /// The app layer's pure parts: the JSON the server actually sends, the rubric derived from
    /// a recipe, the frame fit, and the synthesised audio.
    /// </summary>
    public class JsonParsingTests
    {
        /// <summary>A real response body, not a hand-simplified one.</summary>
        const string RecipeListJson = @"{
          ""recipes"": [
            {
              ""id"": ""65f1a2b3c4d5e6f7a8b9c0d1"",
              ""slug"": ""smash-burger"",
              ""title"": ""Smash Burger"",
              ""description"": ""Thin patty, hard sear."",
              ""servings"": 2,
              ""tags"": [""beef"", ""quick""],
              ""source"": ""builtin"",
              ""ingredients"": [
                { ""name"": ""ground beef"", ""quantity"": 340, ""unit"": ""g"", ""notes"": ""80/20"" }
              ],
              ""steps"": [
                { ""order"": 0, ""text"": ""Press the ball flat"", ""durationSec"": 90, ""hot"": true, ""knife"": false },
                { ""order"": 1, ""text"": ""Slice the onion"", ""durationSec"": 60, ""hot"": false, ""knife"": true }
              ],
              ""cover"": { ""tint"": ""#F9C7BE"", ""ink"": ""#46101A"", ""accent"": ""#F5230E"" }
            }
          ],
          ""total"": 1
        }";

        [Test]
        public void ARecipeListParses()
        {
            var parsed = JsonUtility.FromJson<RecipeListDto>(RecipeListJson);
            Assert.IsNotNull(parsed);
            Assert.That(parsed.recipes.Length, Is.EqualTo(1));
            Assert.That(parsed.recipes[0].title, Is.EqualTo("Smash Burger"));
            Assert.That(parsed.recipes[0].steps.Length, Is.EqualTo(2));
            Assert.That(parsed.recipes[0].steps[0].hot, Is.True);
            Assert.That(parsed.recipes[0].steps[1].knife, Is.True);
        }

        [Test]
        public void TheCoverTintParsesIntoAColour()
        {
            var parsed = JsonUtility.FromJson<RecipeListDto>(RecipeListJson);
            Assert.IsTrue(Srgb.TryParseHex(parsed.recipes[0].cover.tint, out var tint));
            Assert.That(tint.r, Is.EqualTo(249f / 255f).Within(1e-4f));
        }

        [Test]
        public void AnOfflineCoachResponseParses()
        {
            var parsed = JsonUtility.FromJson<CoachAnalysisDto>(
                @"{""observations"":[],""coachLine"":null,""unsure"":true,""offline"":true,""reason"":""upstream_unavailable""}");
            Assert.IsTrue(parsed.offline);
            Assert.IsTrue(parsed.unsure);
            Assert.That(parsed.observations.Length, Is.EqualTo(0));
        }

        [Test]
        public void AFullCoachResponseParsesAndItsStatusesMap()
        {
            var parsed = JsonUtility.FromJson<CoachAnalysisDto>(
                @"{""observations"":[
                     {""item"":""crust has formed"",""status"":""ok"",""evidence"":""dark edge"",""confidence"":0.86},
                     {""item"":""onion is translucent"",""status"":""unknown"",""evidence"":""out of frame"",""confidence"":0.2}
                   ],""coachLine"":""Flip it."",""unsure"":false,""offline"":false}");

            Assert.That(ScoringEngine.ParseStatus(parsed.observations[0].status), Is.EqualTo(ObservationStatus.Ok));
            Assert.That(ScoringEngine.ParseStatus(parsed.observations[1].status), Is.EqualTo(ObservationStatus.Unknown));
            Assert.That(parsed.coachLine, Is.EqualTo("Flip it."));
        }

        [Test]
        public void AMissingArrayIsNullButAMissingObjectIsNot()
        {
            /*
             * JsonUtility is asymmetric about absent fields, and the app has to know which way
             * round: an absent ARRAY stays null, while an absent nested [Serializable] OBJECT
             * comes back instantiated with empty strings.
             *
             * Found by this test failing, not by reading the docs. It matters at exactly one
             * place -- RecipeBook.CoverTint -- where a `cover != null` check would pass for a
             * recipe that has no cover, and the app would then read "" as a hex colour. The
             * guard there is a TryParseHex that returns false, which is why the fallback tint
             * still works; a NullReference check alone would not have.
             */
            var parsed = JsonUtility.FromJson<RecipeDto>(@"{""slug"":""x"",""title"":""X""}");
            Assert.IsNotNull(parsed);
            Assert.That(parsed.title, Is.EqualTo("X"));
            Assert.IsNull(parsed.steps, "an absent array should stay null");
            Assert.IsNotNull(parsed.cover, "JsonUtility instantiates an absent nested object");
            // Instantiated, but its own strings are left null -- so the check that
            // matters is not "is the object there" but "is the value parseable".
            Assert.That(parsed.cover.tint, Is.Null.Or.Empty);
            // And this is why the fallback holds: an empty string is not a colour.
            Assert.IsFalse(Srgb.TryParseHex(parsed.cover.tint, out _));
        }

        [Test]
        public void ALeaderboardParses()
        {
            var parsed = JsonUtility.FromJson<LeaderboardDto>(
                @"{""entries"":[{""rank"":1,""name"":""QuickWhisk42"",""score"":88.5,""createdAt"":""2026-09-20T04:00:00.000Z""}],""total"":1,""limit"":20,""offset"":0}");
            Assert.That(parsed.entries[0].name, Is.EqualTo("QuickWhisk42"));
            Assert.That(parsed.entries[0].score, Is.EqualTo(88.5f).Within(1e-4f));
        }

        [Test]
        public void ASessionStartParses()
        {
            var parsed = JsonUtility.FromJson<SessionStartDto>(
                @"{""sessionId"":""abc123def456"",""token"":""sig"",""startedAt"":""2026-09-20T04:00:00.000Z"",""requiredSeconds"":120,""minRunSeconds"":20,""practice"":false}");
            Assert.That(parsed.sessionId, Is.EqualTo("abc123def456"));
            Assert.That(parsed.requiredSeconds, Is.EqualTo(120));
        }
    }

    public class RubricDerivationTests
    {
        static RecipeDto Recipe() => new RecipeDto
        {
            slug = "test",
            title = "Test",
            steps = new[]
            {
                new StepDto { order = 0, text = "Dice the onion", durationSec = 60, technique = "brunoise", knife = true },
                new StepDto { order = 1, text = "Sear the patty", durationSec = 90, hot = true },
                new StepDto { order = 2, text = "Season to taste" },
            },
        };

        [Test]
        public void EveryStepBecomesARubricStep()
        {
            Assert.That(RunController.RubricFrom(Recipe()).Steps.Count, Is.EqualTo(3));
        }

        [Test]
        public void TheStepTextIsAnItemTheCoachIsAskedAbout()
        {
            var rubric = RunController.RubricFrom(Recipe());
            Assert.That(rubric.Steps[0].Items, Does.Contain("Dice the onion"));
        }

        [Test]
        public void ATechniqueAddsASecondItem()
        {
            var rubric = RunController.RubricFrom(Recipe());
            Assert.That(rubric.Steps[0].Items.Count, Is.EqualTo(2));
            Assert.That(rubric.Steps[0].Items, Does.Contain("brunoise"));
            Assert.That(rubric.Steps[2].Items.Count, Is.EqualTo(1));
        }

        [Test]
        public void HotAndKnifeFlagsCarryThrough()
        {
            var rubric = RunController.RubricFrom(Recipe());
            Assert.IsTrue(rubric.Steps[0].Knife);
            Assert.IsTrue(rubric.Steps[1].Hot);
            Assert.IsFalse(rubric.Steps[2].Hot);
        }

        [Test]
        public void AnUntimedStepGetsNoCeilingRatherThanAZeroOne()
        {
            var rubric = RunController.RubricFrom(Recipe());
            Assert.That(rubric.Steps[2].MinDurationSec, Is.EqualTo(0));
            Assert.That(rubric.Steps[2].MaxDurationSec, Is.EqualTo(0));
        }

        [Test]
        public void ANullRecipeProducesAnEmptyRubricRatherThanThrowing()
        {
            Assert.That(RunController.RubricFrom(null).Steps.Count, Is.EqualTo(0));
            Assert.DoesNotThrow(() => RunController.RubricFrom(new RecipeDto()));
        }
    }

    public class FrameFitTests
    {
        [Test]
        public void AWideFrameFitsItsLongEdge()
        {
            var size = FrameUploader.FitLongEdge(1280, 960, 512);
            Assert.That(size.x, Is.EqualTo(512));
            Assert.That(size.y, Is.EqualTo(384));
        }

        [Test]
        public void ATallFrameFitsItsLongEdgeToo()
        {
            var size = FrameUploader.FitLongEdge(960, 1280, 512);
            Assert.That(size.y, Is.EqualTo(512));
            Assert.That(size.x, Is.EqualTo(384));
        }

        [Test]
        public void ASmallFrameIsNotUpscaled()
        {
            var size = FrameUploader.FitLongEdge(320, 240, 512);
            Assert.That(size.x, Is.EqualTo(320));
            Assert.That(size.y, Is.EqualTo(240));
        }

        [Test]
        public void DimensionsAreAlwaysEven()
        {
            // JPEG chroma subsampling works in 2x2 blocks; an odd edge costs a padded block
            // for nothing.
            for (var w = 101; w < 140; w++)
            {
                var size = FrameUploader.FitLongEdge(w, 77, 512);
                Assert.That(size.x % 2, Is.EqualTo(0), $"width {w}");
                Assert.That(size.y % 2, Is.EqualTo(0), $"width {w}");
            }
        }

        [Test]
        public void AspectRatioSurvivesTheFit()
        {
            var size = FrameUploader.FitLongEdge(1600, 900, 512);
            Assert.That((float)size.x / size.y, Is.EqualTo(1600f / 900f).Within(0.02f));
        }

        [Test]
        public void ADegenerateFrameDoesNotDivideByZero()
        {
            Assert.DoesNotThrow(() => FrameUploader.FitLongEdge(0, 0, 512));
            Assert.That(FrameUploader.FitLongEdge(0, 0, 512).x, Is.EqualTo(512));
        }
    }

    public class ToneBankTests
    {
        [Test]
        public void EverySoundRendersSamples()
        {
            foreach (Sfx sound in System.Enum.GetValues(typeof(Sfx)))
            {
                var samples = ToneBank.Render(ToneBank.SpecFor(sound));
                Assert.That(samples.Length, Is.GreaterThan(0), sound.ToString());
            }
        }

        [Test]
        public void NoSoundClips()
        {
            foreach (Sfx sound in System.Enum.GetValues(typeof(Sfx)))
            {
                var samples = ToneBank.Render(ToneBank.SpecFor(sound));
                for (var i = 0; i < samples.Length; i++)
                {
                    Assert.That(Mathf.Abs(samples[i]), Is.LessThanOrEqualTo(1f), $"{sound} clipped at sample {i}");
                }
            }
        }

        [Test]
        public void EverySoundStartsAndEndsAtSilence()
        {
            // A non-zero endpoint is an audible click at the end of every single sound.
            foreach (Sfx sound in System.Enum.GetValues(typeof(Sfx)))
            {
                var samples = ToneBank.Render(ToneBank.SpecFor(sound));
                Assert.That(Mathf.Abs(samples[0]), Is.LessThan(0.02f), $"{sound} starts with a click");
                Assert.That(Mathf.Abs(samples[samples.Length - 1]), Is.LessThan(0.02f), $"{sound} ends with a click");
            }
        }

        [Test]
        public void EnvelopeIsZeroAtBothEnds()
        {
            var partial = new ToneBank.Partial { AttackSec = 0.01f, DecaySec = 0.1f, SustainLevel = 0.5f, ReleaseSec = 0.1f };
            Assert.That(ToneBank.EnvelopeAt(partial, 0f), Is.EqualTo(0f).Within(1e-4f));
            Assert.That(ToneBank.EnvelopeAt(partial, 0.21f), Is.EqualTo(0f).Within(1e-3f));
            Assert.That(ToneBank.EnvelopeAt(partial, 5f), Is.EqualTo(0f));
        }

        [Test]
        public void EnvelopePeaksAtTheEndOfTheAttack()
        {
            var partial = new ToneBank.Partial { AttackSec = 0.01f, DecaySec = 0.1f, SustainLevel = 0.5f, ReleaseSec = 0.1f };
            Assert.That(ToneBank.EnvelopeAt(partial, 0.01f), Is.EqualTo(1f).Within(1e-3f));
        }

        [Test]
        public void EnvelopeNeverGoesNegative()
        {
            var partial = new ToneBank.Partial { AttackSec = 0.005f, DecaySec = 0.05f, SustainLevel = 0f, ReleaseSec = 0.05f };
            for (var t = 0f; t < 0.3f; t += 0.001f)
                Assert.That(ToneBank.EnvelopeAt(partial, t), Is.GreaterThanOrEqualTo(0f), $"at {t}");
        }

        [Test]
        public void RenderIsDeterministic()
        {
            var a = ToneBank.Render(ToneBank.SpecFor(Sfx.GoodCut));
            var b = ToneBank.Render(ToneBank.SpecFor(Sfx.GoodCut));
            Assert.That(a, Is.EqualTo(b));
        }

        [Test]
        public void NoSoundOutlastsTheGestureItBelongsTo()
        {
            // A UI sound that outlasts its gesture stops being feedback and starts being a
            // noise the cook is waiting out -- in a kitchen where they also need to hear a pan.
            foreach (Sfx sound in System.Enum.GetValues(typeof(Sfx)))
            {
                Assert.That(ToneBank.SpecFor(sound).LengthSec, Is.LessThanOrEqualTo(0.75f), sound.ToString());
            }
        }

        [Test]
        public void TheTimerBandMapsElapsedTimeOntoTheRing()
        {
            ArcGauge.TimerBand(30f, 60, 120, out var progress, out var zoneStart, out var zoneEnd);
            Assert.That(progress, Is.EqualTo(0.25f).Within(1e-4f));
            Assert.That(zoneStart, Is.EqualTo(0.5f).Within(1e-4f));
            Assert.That(zoneEnd, Is.EqualTo(1f).Within(1e-4f));
        }

        [Test]
        public void TheTimerBandStillMovesWithNoMaximum()
        {
            // A ring with no end would otherwise never move.
            ArcGauge.TimerBand(30f, 60, 0, out var progress, out _, out _);
            Assert.That(progress, Is.GreaterThan(0f));
            Assert.That(progress, Is.LessThanOrEqualTo(1f));
        }

        [Test]
        public void TheTimerBandClampsPastTheMaximum()
        {
            ArcGauge.TimerBand(9999f, 60, 120, out var progress, out _, out _);
            Assert.That(progress, Is.EqualTo(1f));
        }
    }
}
