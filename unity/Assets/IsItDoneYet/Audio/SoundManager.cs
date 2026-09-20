using System.Collections.Generic;
using IsItDoneYet.Core;
using UnityEngine;
using UnityEngine.Audio;

namespace IsItDoneYet.Audio
{
    /// <summary>
    /// Plays the sounds, and refuses to play them too often.
    ///
    /// The refusal is the whole job. A coach that is correct produces the same warning every
    /// cycle while the condition holds, and eleven identical chimes in thirty seconds teaches
    /// the cook to ignore the twelfth -- including when it is the one that matters. The
    /// cooldowns come from <see cref="MessageCooldown"/>, the same class the coach uses for its
    /// text, because it is the same problem.
    ///
    /// Three mixer groups, so the cook can turn the coach down without silencing the UI clicks
    /// that tell them a poke landed. Volume and mute persist -- somebody who muted this once
    /// did not mean "until you restart".
    ///
    /// <b>Sound is never the only channel for a safety warning.</b> Every call that matters is
    /// paired with a visible cue by its caller, because a cook with a pan going may not hear
    /// any of this.
    /// </summary>
    [DefaultExecutionOrder(-40)]
    public class SoundManager : MonoBehaviour
    {
        public static SoundManager Instance { get; private set; }

        const string MutedKey = "idy.audio.muted";
        const string VolumeKey = "idy.audio.volume";

        [Header("Mixer")]
        [Tooltip("Optional. Without one the sources play unrouted, which still works.")]
        public AudioMixer Mixer;
        public string MasterParameter = "MasterVolume";
        public AudioMixerGroup UiGroup;
        public AudioMixerGroup CoachGroup;

        [Header("Pool")]
        [Tooltip("More than this many at once and the newest is dropped rather than stealing one mid-play.")]
        public int Voices = 8;

        [Header("Cooldowns (seconds)")]
        public float DefaultCooldown = 0.35f;
        [Tooltip("The coach's own sounds cool down far slower than a UI click.")]
        public float WarningCooldown = 8f;
        public float StreakBreakCooldown = 4f;

        readonly Dictionary<Sfx, AudioClip> _clips = new Dictionary<Sfx, AudioClip>();
        readonly List<AudioSource> _pool = new List<AudioSource>();
        readonly MessageCooldown _cooldown = new MessageCooldown();

        bool _muted;
        float _volume = 0.8f;

        public bool Muted => _muted;
        public float Volume => _volume;

        void Awake()
        {
            if (Instance != null && Instance != this) { Destroy(gameObject); return; }
            Instance = this;

            _muted = PlayerPrefs.GetInt(MutedKey, 0) == 1;
            _volume = PlayerPrefs.GetFloat(VolumeKey, 0.8f);

            // Built once, at startup. Synthesising on first play would put a few milliseconds
            // of sample generation on the frame a button is pressed, which is the one frame
            // that must not hitch.
            foreach (Sfx sound in System.Enum.GetValues(typeof(Sfx))) _clips[sound] = ToneBank.Build(sound);

            for (var i = 0; i < Mathf.Max(1, Voices); i++)
            {
                var host = new GameObject($"Voice{i}");
                host.transform.SetParent(transform, false);
                var source = host.AddComponent<AudioSource>();
                source.playOnAwake = false;
                // Flat 2D. These are UI sounds; spatialising them would put the combo chime
                // somewhere in the room, which is both confusing and quieter than intended.
                source.spatialBlend = 0f;
                source.dopplerLevel = 0f;
                _pool.Add(source);
            }

            ApplyVolume();
        }

        void OnDestroy()
        {
            if (Instance == this) Instance = null;
        }

        /// <param name="cooldownSeconds">-1 uses the per-sound default below.</param>
        public void Play(Sfx sound, float cooldownSeconds = -1f)
        {
            if (_muted) return;
            if (!_clips.TryGetValue(sound, out var clip) || clip == null) return;

            var cooldown = cooldownSeconds >= 0f ? cooldownSeconds : DefaultCooldownFor(sound);
            // Keyed by the sound, so two different sounds never suppress each other -- a
            // warning must not be swallowed because a poke click happened to be recent.
            if (!_cooldown.TrySpeak(sound.ToString(), Time.unscaledTime, cooldown)) return;

            var source = FreeVoice();
            // No voice stealing. Cutting a chime off mid-play to start another is more
            // noticeable than the sound that did not happen.
            if (source == null) return;

            source.outputAudioMixerGroup = IsCoachSound(sound) ? CoachGroup : UiGroup;
            source.clip = clip;
            source.volume = _volume;
            source.Play();
        }

        static bool IsCoachSound(Sfx sound) =>
            sound == Sfx.Warning || sound == Sfx.MessagePop || sound == Sfx.SafeModeEnter;

        float DefaultCooldownFor(Sfx sound)
        {
            switch (sound)
            {
                case Sfx.Warning: return WarningCooldown;
                case Sfx.StreakBreak: return StreakBreakCooldown;
                case Sfx.SafeModeEnter: return 2f;
                // Hover fires as a finger sweeps a row of buttons. A cooldown here is the
                // difference between feedback and a machine-gun.
                case Sfx.Hover: return 0.12f;
                default: return DefaultCooldown;
            }
        }

        AudioSource FreeVoice()
        {
            for (var i = 0; i < _pool.Count; i++) if (!_pool[i].isPlaying) return _pool[i];
            return null;
        }

        public void SetMuted(bool muted)
        {
            _muted = muted;
            PlayerPrefs.SetInt(MutedKey, muted ? 1 : 0);
            PlayerPrefs.Save();
            ApplyVolume();
        }

        public void SetVolume(float volume)
        {
            _volume = Mathf.Clamp01(volume);
            PlayerPrefs.SetFloat(VolumeKey, _volume);
            PlayerPrefs.Save();
            ApplyVolume();
        }

        void ApplyVolume()
        {
            if (Mixer == null) return;
            // The mixer is in decibels and its floor is -80, not 0. Passing a linear 0 sets it
            // to full volume, which is the loudest possible interpretation of "mute".
            var db = _muted || _volume <= 0.0001f ? -80f : Mathf.Log10(_volume) * 20f;
            Mixer.SetFloat(MasterParameter, db);
        }

        /// <summary>Clears every cooldown. Called when a run starts, so nothing carries over.</summary>
        public void ResetCooldowns() => _cooldown.Clear();
    }
}
