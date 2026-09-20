using IsItDoneYet.Audio;
using IsItDoneYet.Core;
using IsItDoneYet.Design;
using UnityEngine;

namespace IsItDoneYet.App
{
    /// <summary>
    /// The live score, top right, on an arc: a rolling counter, a segmented combo meter, and a
    /// burst when points land.
    ///
    /// The points-docked animation is deliberately not a punishment. It moves the number down,
    /// shows what it cost and why, and stops -- no red flash, no buzzer, no shake. A cook who
    /// is being shouted at stops taking risks, and the whole app is about making them
    /// comfortable enough to try the cut they are unsure about.
    /// </summary>
    public class ScoreHud : MonoBehaviour
    {
        [Header("Wiring")]
        public LayoutConfig Layout;
        public Transform Head;
        public NumberRoll Counter;
        public ArcGauge ComboMeter;
        public Label DockReason;
        public ParticleSystem Burst;

        [Header("Combo")]
        [Tooltip("Segments in the meter. Matches ComboMax / ComboStep in the scoring config.")]
        public int ComboSegments = 4;

        float _lastPercent;
        float _dockShownAt;

        void OnEnable()
        {
            if (Counter != null) Counter.Gained += OnGained;
        }

        void OnDisable()
        {
            if (Counter != null) Counter.Gained -= OnGained;
        }

        void LateUpdate()
        {
            if (Layout == null || Head == null) return;
            // World-locked to a pose computed from the head, but NOT following it: recomputed
            // each frame from the current head pose would make the score orbit the cook, which
            // is the single most nauseating thing a spatial HUD can do. This runs once per
            // recenter; see HudRoot.
            if (DockReason != null && _dockShownAt > 0f && Time.time - _dockShownAt > 4f)
            {
                DockReason.gameObject.SetActive(false);
                _dockShownAt = 0f;
            }
        }

        public void Set(ScoreResult result)
        {
            if (result == null) return;

            if (Counter != null) Counter.SetValue(result.Percent);

            if (ComboMeter != null)
            {
                // The multiplier runs 1..ComboMax; the meter shows how far along that is.
                var span = Mathf.Max(0.001f, 2f - 1f);
                ComboMeter.Segments = ComboSegments;
                ComboMeter.SetProgress(Mathf.Clamp01((result.FinalMultiplier - 1f) / span));
                ComboMeter.Refresh();
            }

            // The most recent dock, named. "You lost points" with no reason is the feedback
            // people remember as unfair, whether or not it was.
            if (result.Percent < _lastPercent - 0.05f) ShowDock(result);
            _lastPercent = result.Percent;
        }

        void ShowDock(ScoreResult result)
        {
            if (DockReason == null) return;

            string reason = null;
            for (var i = result.Steps.Count - 1; i >= 0; i--)
            {
                if (string.IsNullOrEmpty(result.Steps[i].DockReason)) continue;
                reason = result.Steps[i].DockReason;
                break;
            }
            if (reason == null) return;

            DockReason.gameObject.SetActive(true);
            DockReason.SetText(reason);
            DockReason.Color = ColorRole.TextMuted;
            DockReason.Refresh();
            _dockShownAt = Time.time;

            SoundManager.Instance?.Play(Sfx.PointsDocked);
        }

        void OnGained(float delta)
        {
            SoundManager.Instance?.Play(Sfx.GoodCut);

            // The burst fires on the same beat as the counter's punch and the chime's attack.
            // Three cues landing together read as one event; spread by 100ms they read as
            // three, and the HUD feels loose.
            if (Burst == null) return;
            var theme = ThemeManager.Instance;
            if (theme != null)
            {
                var main = Burst.main;
                main.startColor = Srgb.ForText(theme.Color(ColorRole.Accent2));
            }
            Burst.Emit(Mathf.Clamp(Mathf.RoundToInt(delta * 0.4f), 4, 18));
        }
    }
}
