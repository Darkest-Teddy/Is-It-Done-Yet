using System;
using System.Collections.Generic;
using UnityEngine;

namespace IsItDoneYet.Design
{
    /// <summary>
    /// A pooled tween. Never constructed by callers -- <see cref="TweenRunner"/> hands them out
    /// and takes them back, so a run that plays a thousand toasts allocates the same handful.
    /// </summary>
    public class Tween
    {
        internal float Elapsed;
        internal float Duration;
        internal Vector4 Controls;
        internal Action<float> OnUpdate;
        internal Action OnComplete;
        internal bool Unscaled;
        internal bool Active;
        internal int Generation;

        internal void Reset()
        {
            Elapsed = 0f;
            Duration = 0f;
            OnUpdate = null;
            OnComplete = null;
            Unscaled = false;
            Active = false;
            Generation++;
        }
    }

    /// <summary>
    /// A handle that survives the tween being recycled.
    ///
    /// Holding a <see cref="Tween"/> reference and cancelling it later is a use-after-free in
    /// slow motion: by then the pool may have handed that object to somebody else, and the
    /// cancel stops the wrong animation. The generation counter makes a stale handle a no-op.
    /// </summary>
    public readonly struct TweenHandle
    {
        readonly Tween _tween;
        readonly int _generation;

        internal TweenHandle(Tween tween, int generation)
        {
            _tween = tween;
            _generation = generation;
        }

        public bool IsAlive => _tween != null && _tween.Active && _tween.Generation == _generation;

        public void Cancel()
        {
            if (IsAlive) _tween.Active = false;
        }
    }
}
