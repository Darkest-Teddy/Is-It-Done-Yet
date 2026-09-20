using System.Collections.Generic;
using UnityEngine;

namespace IsItDoneYet.Core
{
    /// <summary>
    /// Per-message cooldowns, so a coach that is right stays bearable.
    ///
    /// The failure this prevents is specific and common: a condition that stays true -- the pan
    /// is still not hot -- produces a correct warning every single cycle. Correct, and after the
    /// fourth one the cook has stopped reading the toast area entirely.
    ///
    /// Keyed by message id rather than by text, so rewording a line does not silently reset its
    /// cooldown. Shared by the coach and by <c>SoundManager</c>, which has exactly the same
    /// problem with the same shape -- the warning chime that fires eleven times.
    ///
    /// Time is passed in rather than read from <c>Time.time</c>, which is what lets the whole of
    /// this be tested without entering play mode.
    /// </summary>
    public class MessageCooldown
    {
        readonly Dictionary<string, float> _lastSpokenAt = new Dictionary<string, float>();
        readonly float _defaultSeconds;

        public MessageCooldown(float defaultSeconds = 12f)
        {
            _defaultSeconds = Mathf.Max(0f, defaultSeconds);
        }

        /// <summary>
        /// May this fire now? Records the time if so.
        ///
        /// Ask-and-commit in one call on purpose. A separate `CanSpeak` then `MarkSpoken` is two
        /// calls that one early `return` between them turns into a message that never cools down
        /// again, and that bug is invisible until somebody sits through a whole run.
        /// </summary>
        public bool TrySpeak(string id, float nowSeconds, float cooldownSeconds = -1f)
        {
            if (string.IsNullOrEmpty(id)) return false;
            var cooldown = cooldownSeconds < 0f ? _defaultSeconds : cooldownSeconds;

            if (_lastSpokenAt.TryGetValue(id, out var last) && nowSeconds - last < cooldown) return false;

            _lastSpokenAt[id] = nowSeconds;
            return true;
        }

        /// <summary>Seconds until this id may fire again. Zero when it is ready.</summary>
        public float RemainingSeconds(string id, float nowSeconds, float cooldownSeconds = -1f)
        {
            if (string.IsNullOrEmpty(id)) return 0f;
            var cooldown = cooldownSeconds < 0f ? _defaultSeconds : cooldownSeconds;
            if (!_lastSpokenAt.TryGetValue(id, out var last)) return 0f;
            return Mathf.Max(0f, cooldown - (nowSeconds - last));
        }

        /// <summary>
        /// Forgets one id. Used when a step advances: the warning about the previous step is no
        /// longer suppressed just because it was recent, because it now means something else.
        /// </summary>
        public void Forget(string id)
        {
            if (!string.IsNullOrEmpty(id)) _lastSpokenAt.Remove(id);
        }

        public void Clear() => _lastSpokenAt.Clear();
    }
}
