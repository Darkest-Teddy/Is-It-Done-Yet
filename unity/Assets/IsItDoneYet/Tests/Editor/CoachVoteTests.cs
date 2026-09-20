using System.Collections.Generic;
using IsItDoneYet.Core;
using NUnit.Framework;

namespace IsItDoneYet.Tests
{
    /// <summary>
    /// The three-frame vote. A coach that contradicts itself every three seconds is worse than
    /// no coach, because people stop reading it -- including when it is right.
    /// </summary>
    public class CoachVoteTests
    {
        static readonly List<string> Items = new List<string> { "crust has formed", "onion is translucent" };

        static CoachResult Result(params (string item, ObservationStatus status, float confidence)[] observations)
        {
            var result = new CoachResult();
            foreach (var (item, status, confidence) in observations)
                result.Observations.Add(new CoachObservation { Item = item, Status = status, Confidence = confidence, Evidence = "seen" });
            return result;
        }

        [Test]
        public void OneOpinionIsNotEnough()
        {
            var vote = new CoachVote();
            vote.Add(Result(("crust has formed", ObservationStatus.Bad, 0.9f)));

            var voted = new List<VotedObservation>();
            vote.Vote(Items, voted);
            Assert.That(voted, Is.Empty);
        }

        [Test]
        public void TwoAgreeingOpinionsAreEnough()
        {
            var vote = new CoachVote();
            vote.Add(Result(("crust has formed", ObservationStatus.Bad, 0.9f)));
            vote.Add(Result(("crust has formed", ObservationStatus.Bad, 0.8f)));

            var voted = new List<VotedObservation>();
            vote.Vote(Items, voted);
            Assert.That(voted.Count, Is.EqualTo(1));
            Assert.That(voted[0].Status, Is.EqualTo(ObservationStatus.Bad));
            Assert.That(voted[0].Agreeing, Is.EqualTo(2));
        }

        [Test]
        public void DisagreementProducesNothing()
        {
            var vote = new CoachVote();
            vote.Add(Result(("crust has formed", ObservationStatus.Ok, 0.9f)));
            vote.Add(Result(("crust has formed", ObservationStatus.Bad, 0.9f)));
            vote.Add(Result(("crust has formed", ObservationStatus.Warn, 0.9f)));

            var voted = new List<VotedObservation>();
            vote.Vote(Items, voted);
            Assert.That(voted, Is.Empty);
        }

        [Test]
        public void ATieResolvesToTheMoreSeriousStatus()
        {
            // Two "bad" and two "warn" is not a coin flip -- the cook would rather look and
            // find nothing.
            var vote = new CoachVote(windowSize: 4, agreementNeeded: 2);
            vote.Add(Result(("crust has formed", ObservationStatus.Warn, 0.9f)));
            vote.Add(Result(("crust has formed", ObservationStatus.Warn, 0.9f)));
            vote.Add(Result(("crust has formed", ObservationStatus.Bad, 0.9f)));
            vote.Add(Result(("crust has formed", ObservationStatus.Bad, 0.9f)));

            var voted = new List<VotedObservation>();
            vote.Vote(Items, voted);
            Assert.That(voted[0].Status, Is.EqualTo(ObservationStatus.Bad));
        }

        [Test]
        public void LowConfidenceAbstainsRatherThanVetoes()
        {
            // A model saying "I am not sure" must not be able to outvote two confident frames.
            var vote = new CoachVote();
            vote.Add(Result(("crust has formed", ObservationStatus.Bad, 0.9f)));
            vote.Add(Result(("crust has formed", ObservationStatus.Bad, 0.9f)));
            vote.Add(Result(("crust has formed", ObservationStatus.Ok, 0.05f)));

            var voted = new List<VotedObservation>();
            vote.Vote(Items, voted);
            Assert.That(voted.Count, Is.EqualTo(1));
            Assert.That(voted[0].Status, Is.EqualTo(ObservationStatus.Bad));
        }

        [Test]
        public void UnknownNeverWins()
        {
            // Three frames of "I cannot see it" leave the item unreported, rather than
            // reporting "unknown" as though it were a finding.
            var vote = new CoachVote();
            for (var i = 0; i < 3; i++) vote.Add(Result(("crust has formed", ObservationStatus.Unknown, 0.9f)));

            var voted = new List<VotedObservation>();
            vote.Vote(Items, voted);
            Assert.That(voted, Is.Empty);
        }

        [Test]
        public void AnOfflineResultIsDroppedRatherThanRecorded()
        {
            // Recording it would push a good result out of the window, so a patch of bad wifi
            // would silence the coach for three cycles AFTER it came back.
            var vote = new CoachVote();
            vote.Add(Result(("crust has formed", ObservationStatus.Bad, 0.9f)));
            vote.Add(Result(("crust has formed", ObservationStatus.Bad, 0.9f)));
            vote.Add(new CoachResult { Offline = true });

            Assert.That(vote.Count, Is.EqualTo(2));
            var voted = new List<VotedObservation>();
            vote.Vote(Items, voted);
            Assert.That(voted.Count, Is.EqualTo(1));
        }

        [Test]
        public void TheWindowIsBounded()
        {
            var vote = new CoachVote(windowSize: 3);
            for (var i = 0; i < 10; i++) vote.Add(Result(("crust has formed", ObservationStatus.Ok, 0.9f)));
            Assert.That(vote.Count, Is.EqualTo(3));
        }

        [Test]
        public void AnOldOpinionFallsOutOfTheWindow()
        {
            var vote = new CoachVote(windowSize: 3);
            vote.Add(Result(("crust has formed", ObservationStatus.Bad, 0.9f)));
            vote.Add(Result(("crust has formed", ObservationStatus.Bad, 0.9f)));
            for (var i = 0; i < 3; i++) vote.Add(Result(("crust has formed", ObservationStatus.Ok, 0.9f)));

            var voted = new List<VotedObservation>();
            vote.Vote(Items, voted);
            Assert.That(voted[0].Status, Is.EqualTo(ObservationStatus.Ok));
        }

        [Test]
        public void ItemsNobodyAskedAboutAreNotReported()
        {
            var vote = new CoachVote();
            vote.Add(Result(("a hallucinated item", ObservationStatus.Bad, 0.9f)));
            vote.Add(Result(("a hallucinated item", ObservationStatus.Bad, 0.9f)));

            var voted = new List<VotedObservation>();
            vote.Vote(Items, voted);
            Assert.That(voted, Is.Empty);
        }

        [Test]
        public void OutputOrderFollowsTheRubricNotTheModel()
        {
            var vote = new CoachVote();
            for (var i = 0; i < 2; i++)
            {
                vote.Add(Result(
                    ("onion is translucent", ObservationStatus.Ok, 0.9f),
                    ("crust has formed", ObservationStatus.Ok, 0.9f)));
            }

            var voted = new List<VotedObservation>();
            vote.Vote(Items, voted);
            Assert.That(voted[0].Item, Is.EqualTo("crust has formed"));
            Assert.That(voted[1].Item, Is.EqualTo("onion is translucent"));
        }

        [Test]
        public void ConfidenceIsAveragedAcrossTheAgreeingFrames()
        {
            var vote = new CoachVote();
            vote.Add(Result(("crust has formed", ObservationStatus.Ok, 0.6f)));
            vote.Add(Result(("crust has formed", ObservationStatus.Ok, 1.0f)));

            var voted = new List<VotedObservation>();
            vote.Vote(Items, voted);
            Assert.That(voted[0].Confidence, Is.EqualTo(0.8f).Within(1e-4f));
        }

        [Test]
        public void AnEmptyWindowIsUnsure()
        {
            var vote = new CoachVote();
            Assert.IsTrue(vote.IsUnsure(Items, new List<VotedObservation>()));
        }

        [Test]
        public void ClearEmptiesTheWindow()
        {
            var vote = new CoachVote();
            vote.Add(Result(("crust has formed", ObservationStatus.Ok, 0.9f)));
            vote.Clear();
            Assert.That(vote.Count, Is.EqualTo(0));
        }

        [Test]
        public void NullAndEmptyInputsAreSafe()
        {
            var vote = new CoachVote();
            vote.Add(null);
            var voted = new List<VotedObservation>();
            Assert.DoesNotThrow(() => vote.Vote(null, voted));
            Assert.That(voted, Is.Empty);
        }
    }
}
