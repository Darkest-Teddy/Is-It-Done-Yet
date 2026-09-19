using System;
using UnityEngine;

namespace MRPerception
{
    /// <summary>
    /// Identifies what something IS, given a picture of it.
    ///
    /// Deliberately separate from detection. YOLO and the contour finder answer "where is
    /// something", locally, every capture, in milliseconds. This answers "what is it", remotely,
    /// once per object, in about a second. Conflating the two is what makes people send a frame
    /// to a cloud model at 5Hz and then wonder why the app costs money and feels laggy.
    ///
    /// An interface rather than a concrete class because the provider WILL change -- a cloud
    /// model during development, an offline stub for the demo rehearsal, possibly a local model
    /// later. Master spec rule #12: whatever survives bad wifi. Every implementation must
    /// degrade rather than hang.
    /// </summary>
    public interface IVisionProvider
    {
        string Name { get; }

        /// <summary>
        /// True when a request is already outstanding. Callers use this to avoid queueing a
        /// backlog -- results that arrive for an object that has since been forgotten cost real
        /// money and help nobody.
        /// </summary>
        bool Busy { get; }

        /// <summary>
        /// Identifies the subject of a cropped image.
        ///
        /// <paramref name="hint"/> is what the local detector already thinks it is, or null.
        /// Passing it is worth a surprising amount: "a COCO detector called this broccoli" lets
        /// the model correct a near miss rather than start from nothing, and it lets it say so
        /// when the hint is plainly wrong.
        ///
        /// Never throws. A failure is <see cref="VisionResult.None"/>, because a provider that
        /// throws into a render loop takes the app down over a network hiccup.
        /// </summary>
        void Identify(Texture2D crop, string hint, Action<VisionResult> onComplete);
    }

    /// <summary>What a provider concluded. Plain data; nothing here touches the network.</summary>
    public readonly struct VisionResult
    {
        /// <summary>A short noun phrase: "cucumber", "cheddar cheese", "handwritten note".</summary>
        public readonly string Label;
        /// <summary>0..1, as reported by the model. Treat as a rough ordering, not a probability.</summary>
        public readonly float Confidence;
        /// <summary>Anything worth showing a user: "looks like a hard cheese, cannot tell which".</summary>
        public readonly string Note;
        public readonly bool Ok;
        /// <summary>Round-trip time. Worth putting on the debug panel; it sets the whole UX.</summary>
        public readonly float LatencyMs;

        public VisionResult(string label, float confidence, string note, float latencyMs)
        {
            Label = label;
            Confidence = confidence;
            Note = note;
            LatencyMs = latencyMs;
            Ok = !string.IsNullOrEmpty(label);
        }

        public static VisionResult None => default;
    }

    /// <summary>
    /// A provider that answers instantly from the local hint, for offline rehearsal.
    ///
    /// Master spec 5.2.3 wants the full demo runnable with no network at all, and rehearsed that
    /// way at least once. This is what makes that possible: swap it in and every code path
    /// downstream behaves identically, just with COCO's vocabulary instead of an open one.
    /// </summary>
    public sealed class LocalHintProvider : IVisionProvider
    {
        public string Name => "local";
        public bool Busy => false;

        public void Identify(Texture2D crop, string hint, Action<VisionResult> onComplete)
        {
            onComplete?.Invoke(string.IsNullOrEmpty(hint)
                ? VisionResult.None
                : new VisionResult(hint, 0.5f, "offline: local detector label", 0f));
        }
    }
}
