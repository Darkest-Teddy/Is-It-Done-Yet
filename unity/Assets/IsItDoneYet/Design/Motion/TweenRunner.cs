using System;
using System.Collections.Generic;
using UnityEngine;

// Split out of Tween.cs so the file name matches the class name.
//
// Unity resolves a MonoBehaviour by FILE name. A MonoBehaviour declared in a file called
// something else compiles perfectly and cannot be attached to a GameObject -- AddComponent
// fails and the scene stores a null script reference. It is silent at compile time and
// silent at edit time, and it surfaces as the component simply not being there.

namespace IsItDoneYet.Design
{

    /// <summary>
    /// Every animation in the app, on one update, with one global time scale.
    ///
    /// One runner rather than a coroutine per element. Coroutines allocate an enumerator each
    /// time they start, and a toast stack plus a number roll plus a combo meter starts several a
    /// second -- which is a steady drip of garbage on a device where a collection is a dropped
    /// frame you can feel through your face.
    ///
    /// <see cref="TimeScale"/> is what SAFE mode turns down. It is not a debug convenience:
    /// slowing and stopping motion for somebody working near heat is a product requirement, and
    /// routing every tween through one number is what makes it reliable rather than a property
    /// twelve components each have to remember to honour.
    /// </summary>
    [DefaultExecutionOrder(-50)]
    public class TweenRunner : MonoBehaviour
    {
        static TweenRunner _instance;

        /// <summary>
        /// Global multiplier. 1 is NORMAL, 0.35 is SAFE. Zero finishes everything instantly
        /// rather than freezing it half-played -- a paused animation is a UI stuck mid-gesture.
        /// </summary>
        public static float TimeScale = 1f;

        readonly List<Tween> _active = new List<Tween>(64);
        readonly Stack<Tween> _pool = new Stack<Tween>(64);
        // Swapped with _active during Update so a callback that starts a tween cannot mutate
        // the list being walked. Reused, never reallocated.
        readonly List<Tween> _scratch = new List<Tween>(64);

        public static TweenRunner Instance
        {
            get
            {
                if (_instance != null) return _instance;
                var existing = FindAnyObjectByType<TweenRunner>();
                if (existing != null) { _instance = existing; return _instance; }
                var host = new GameObject("TweenRunner");
                DontDestroyOnLoad(host);
                _instance = host.AddComponent<TweenRunner>();
                return _instance;
            }
        }

        void OnDestroy()
        {
            if (_instance == this) _instance = null;
        }

        /// <param name="unscaled">
        /// True for anything that must play while the app is paused or while SAFE mode has
        /// stopped everything else -- notably the safety toast, which must never be the one
        /// animation a theme can silence.
        /// </param>
        public TweenHandle Play(float durationSeconds, Vector4 easing, Action<float> onUpdate, Action onComplete = null, bool unscaled = false)
        {
            if (onUpdate == null) return default;

            var tween = _pool.Count > 0 ? _pool.Pop() : new Tween();
            tween.Elapsed = 0f;
            tween.Duration = Mathf.Max(0f, durationSeconds);
            tween.Controls = easing;
            tween.OnUpdate = onUpdate;
            tween.OnComplete = onComplete;
            tween.Unscaled = unscaled;
            tween.Active = true;
            _active.Add(tween);

            // A zero-length tween still reports its end state, on this frame, exactly once.
            // Skipping the callback is how an element ends up invisible because its fade-in had
            // a duration of zero under a reduced-motion theme.
            if (tween.Duration <= 0f)
            {
                onUpdate(1f);
                onComplete?.Invoke();
                tween.Active = false;
            }

            return new TweenHandle(tween, tween.Generation);
        }

        void Update()
        {
            if (_active.Count == 0) return;

            _scratch.Clear();
            _scratch.AddRange(_active);
            _active.Clear();

            var scaled = Time.deltaTime * Mathf.Max(0f, TimeScale);
            var unscaled = Time.unscaledDeltaTime;

            for (var i = 0; i < _scratch.Count; i++)
            {
                var tween = _scratch[i];
                if (!tween.Active) { Recycle(tween); continue; }

                tween.Elapsed += tween.Unscaled ? unscaled : scaled;
                var t = tween.Duration <= 0f ? 1f : Mathf.Clamp01(tween.Elapsed / tween.Duration);
                var eased = Easing.CubicBezier(tween.Controls, t);

                var update = tween.OnUpdate;
                var complete = tween.OnComplete;
                update(eased);

                if (t >= 1f)
                {
                    tween.Active = false;
                    complete?.Invoke();
                    Recycle(tween);
                }
                else
                {
                    _active.Add(tween);
                }
            }
        }

        void Recycle(Tween tween)
        {
            tween.Reset();
            if (_pool.Count < 128) _pool.Push(tween);
        }

        /// <summary>Stops everything. Used when a scene tears down mid-animation.</summary>
        public void CancelAll()
        {
            for (var i = 0; i < _active.Count; i++) _active[i].Active = false;
        }

        public int ActiveCount => _active.Count;
    }
}
