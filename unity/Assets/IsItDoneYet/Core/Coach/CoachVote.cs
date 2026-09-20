using System.Collections.Generic;
using UnityEngine;

namespace IsItDoneYet.Core
{
    /// <summary>One item's verdict from one round trip.</summary>
    public struct CoachObservation
    {
        public string Item;
        public ObservationStatus Status;
        public float Confidence;
        public string Evidence;
    }

    /// <summary>What came back from POST /api/coach/analyze, once.</summary>
    public class CoachResult
    {
        public int AtMs;
        public bool Offline;
        public bool Unsure;
        public string CoachLine;
        public List<CoachObservation> Observations = new List<CoachObservation>();
    }

    /// <summary>A verdict the app is willing to act on.</summary>
    public struct VotedObservation
    {
        public string Item;
        public ObservationStatus Status;
        public int Agreeing;
        public float Confidence;
    }

    /// <summary>
    /// Turning three opinions into one, and refusing to speak when they disagree.
    ///
    /// A single frame from a head-mounted camera is a bad witness: the cook's hand crosses the
    /// pan, the exposure hunts, the model sees a shadow and calls it a burn. Acting on one frame
    /// gives a coach that contradicts itself every three seconds, and a coach that contradicts
    /// itself is worse than no coach -- people stop reading it, including when it is right.
    ///
    /// So: keep the last three results, and only surface a verdict that at least two of them
    /// agree on. This is the same hysteresis idea the perception tracker uses, leaning the same
    /// way -- slow to confirm, because a confirmed warning costs points and a missed one costs a
    /// few seconds.
    ///
    /// Nothing here allocates per frame once the window is full.
    /// </summary>
    public class CoachVote
    {
        readonly int _windowSize;
        readonly int _agreementNeeded;
        readonly float _confidenceFloor;
        readonly List<CoachResult> _window = new List<CoachResult>();

        /// <param name="windowSize">How many results to keep. Three.</param>
        /// <param name="agreementNeeded">How many must agree. Two.</param>
        /// <param name="confidenceFloor">
        /// Below this an observation does not get a vote at all. It is not counted as
        /// disagreement either -- a model saying "I am not sure" should not be able to veto two
        /// confident frames, it should simply abstain.
        /// </param>
        public CoachVote(int windowSize = 3, int agreementNeeded = 2, float confidenceFloor = 0.4f)
        {
            _windowSize = Mathf.Max(1, windowSize);
            _agreementNeeded = Mathf.Clamp(agreementNeeded, 1, _windowSize);
            _confidenceFloor = Mathf.Clamp01(confidenceFloor);
        }

        public int Count => _window.Count;

        public void Clear() => _window.Clear();

        /// <summary>
        /// An offline result is dropped rather than recorded.
        ///
        /// Recording it as a window entry would push a good result out and dilute the vote, so a
        /// patch of bad wifi would make the coach fall silent for three cycles AFTER it came
        /// back. The window holds opinions; an outage is not one.
        /// </summary>
        public void Add(CoachResult result)
        {
            if (result == null || result.Offline) return;
            _window.Add(result);
            while (_window.Count > _windowSize) _window.RemoveAt(0);
        }

        /// <summary>
        /// The verdicts that cleared the bar, in the order the rubric asks for them.
        ///
        /// <paramref name="items"/> is the rubric's own list, so the output order is stable and
        /// an item nobody asked about cannot appear.
        /// </summary>
        public void Vote(IReadOnlyList<string> items, List<VotedObservation> into)
        {
            into.Clear();
            if (items == null || _window.Count == 0) return;

            for (var i = 0; i < items.Count; i++)
            {
                var item = items[i];
                var counts = new int[4];
                var confidence = new float[4];

                for (var w = 0; w < _window.Count; w++)
                {
                    var observations = _window[w].Observations;
                    for (var o = 0; o < observations.Count; o++)
                    {
                        var observation = observations[o];
                        if (observation.Item != item) continue;
                        if (observation.Confidence < _confidenceFloor) continue;
                        var slot = (int)observation.Status;
                        counts[slot] += 1;
                        confidence[slot] += observation.Confidence;
                        break;
                    }
                }

                // Unknown is excluded from winning. It is the absence of a verdict, and a window
                // of three "I cannot see it" should leave the item unreported rather than
                // reporting "unknown" as though it were a finding.
                var best = -1;
                for (var s = 1; s < 4; s++)
                {
                    if (counts[s] < _agreementNeeded) continue;
                    if (best < 0 || counts[s] > counts[best]) best = s;
                }
                if (best < 0) continue;

                // A tie between two statuses that both cleared the bar resolves to the more
                // serious one. Two frames saying "bad" and two saying "warn" is not a coin
                // flip: the cook would rather look and find nothing.
                for (var s = 3; s > best; s--)
                {
                    if (counts[s] == counts[best]) { best = s; break; }
                }

                into.Add(new VotedObservation
                {
                    Item = item,
                    Status = (ObservationStatus)best,
                    Agreeing = counts[best],
                    Confidence = confidence[best] / counts[best],
                });
            }
        }

        /// <summary>
        /// True when the window has nothing useful to say -- the pan is out of frame, the cook
        /// is looking at the fridge, the model keeps abstaining.
        ///
        /// The UI says "not sure" rather than going blank, because a HUD element that vanishes
        /// reads as a crash.
        /// </summary>
        public bool IsUnsure(IReadOnlyList<string> items, List<VotedObservation> scratch)
        {
            if (_window.Count == 0) return true;
            Vote(items, scratch);
            if (scratch.Count == 0) return true;

            var unsureResults = 0;
            for (var w = 0; w < _window.Count; w++) if (_window[w].Unsure) unsureResults += 1;
            return unsureResults * 2 > _window.Count;
        }
    }
}
