using System.Collections.Generic;
using IsItDoneYet.Audio;
using IsItDoneYet.Design;
using UnityEngine;

namespace IsItDoneYet.App
{
    /// <summary>
    /// Every magic number on a slider, every sound on a button, and the theme switcher.
    ///
    /// This exists because of one rule this project inherited and keeps: rebuilding to the
    /// headset to try a different threshold is how a Saturday disappears. Everything tunable is
    /// here, live, while the app is running.
    ///
    /// The sound page is not padding. Eleven procedurally synthesised sounds cannot be checked
    /// by reading the code, and the only way to find out that the streak-break chime is
    /// indistinguishable from the points-docked one is to press them one after another.
    /// </summary>
    public class DebugMenu : MonoBehaviour
    {
        [Header("Wiring")]
        public RunController Run;
        public FrameUploader Uploader;
        public StatsOverlay Stats;
        public LayoutConfig Layout;
        public HudRoot Hud;

        [Header("State")]
        public bool Visible;

        readonly List<Sfx> _sounds = new List<Sfx>();

        void Awake()
        {
            foreach (Sfx sound in System.Enum.GetValues(typeof(Sfx))) _sounds.Add(sound);
        }

        /// <summary>
        /// IMGUI, deliberately.
        ///
        /// It is ugly and it is not spatial, and neither matters: this panel is read on the
        /// Mac in Play mode with the simulator, where a flat overlay is the fastest thing to
        /// build and the easiest thing to read. Building it out of the design system would
        /// cost hours and make it worse at its one job.
        ///
        /// Compiled out of release builds along with the rest of the dev layer.
        /// </summary>
#if UNITY_EDITOR || DEVELOPMENT_BUILD
        void OnGUI()
        {
            if (!Visible) return;

            GUILayout.BeginArea(new Rect(10, 10, 360, Screen.height - 20), GUI.skin.box);
            GUILayout.Label("Is It Done Yet — debug");

            var theme = ThemeManager.Instance;
            if (theme != null)
            {
                GUILayout.Label($"theme: {theme.Current}");
                GUILayout.BeginHorizontal();
                if (GUILayout.Button("NORMAL")) theme.Apply(ThemeName.Normal);
                if (GUILayout.Button("SAFE")) theme.Apply(ThemeName.Safe);
                if (GUILayout.Button("PRACTICE")) theme.Apply(ThemeName.Practice);
                GUILayout.EndHorizontal();
            }

            if (Hud != null && GUILayout.Button("Recenter HUD")) Hud.Recenter();
            if (Stats != null && GUILayout.Button("Toggle stats")) Stats.Toggle();

            if (Uploader != null)
            {
                GUILayout.Label($"camera: {(Uploader.IsCapturing ? "capturing" : "off")}  sent {Uploader.FramesSent}");
                GUILayout.Label($"frame interval {Uploader.SecondsBetweenFrames:0.0}s");
                Uploader.SecondsBetweenFrames = GUILayout.HorizontalSlider(Uploader.SecondsBetweenFrames, 1f, 10f);
                GUILayout.Label($"jpeg budget {Uploader.MaxJpegBytes / 1024}KB");
                Uploader.MaxJpegBytes = Mathf.RoundToInt(GUILayout.HorizontalSlider(Uploader.MaxJpegBytes, 20_000, 200_000));
                if (GUILayout.Button(OnboardingFlow.HasConsent ? "Revoke camera consent" : "Grant camera consent"))
                {
                    Uploader.SetConsent(!OnboardingFlow.HasConsent);
                }
            }

            if (Run != null)
            {
                GUILayout.Space(6);
                GUILayout.Label($"score {Run.Current.Percent:0.0}  streak {Run.Current.MaxStreak}  x{Run.Current.FinalMultiplier:0.00}");
                GUILayout.Label($"points/step {Run.ScoreSettings.PointsPerStep:0}");
                Run.ScoreSettings.PointsPerStep = GUILayout.HorizontalSlider(Run.ScoreSettings.PointsPerStep, 20f, 300f);
                GUILayout.Label($"combo step {Run.ScoreSettings.ComboStep:0.00}  max {Run.ScoreSettings.ComboMax:0.0}");
                Run.ScoreSettings.ComboStep = GUILayout.HorizontalSlider(Run.ScoreSettings.ComboStep, 0f, 1f);
                Run.ScoreSettings.ComboMax = GUILayout.HorizontalSlider(Run.ScoreSettings.ComboMax, 1f, 4f);
                GUILayout.Label($"low-heat dock/s {Run.ScoreSettings.LowHeatDockPerSecond:0.0}");
                Run.ScoreSettings.LowHeatDockPerSecond = GUILayout.HorizontalSlider(Run.ScoreSettings.LowHeatDockPerSecond, 0f, 20f);
                if (GUILayout.Button("Advance step")) Run.Advance();
            }

            if (Layout != null)
            {
                GUILayout.Space(6);
                GUILayout.Label($"toast dead zone {Layout.ToastDeadZoneDeg:0.0}°");
                Layout.ToastDeadZoneDeg = GUILayout.HorizontalSlider(Layout.ToastDeadZoneDeg, 0f, 25f);
                GUILayout.Label($"toast follow {Layout.ToastFollowSmoothing:0.0}");
                Layout.ToastFollowSmoothing = GUILayout.HorizontalSlider(Layout.ToastFollowSmoothing, 0.5f, 12f);
            }

            GUILayout.Space(6);
            GUILayout.Label("sounds");
            for (var i = 0; i < _sounds.Count; i += 2)
            {
                GUILayout.BeginHorizontal();
                for (var k = i; k < Mathf.Min(i + 2, _sounds.Count); k++)
                {
                    // Zero cooldown: the point of this page is to hear them back to back.
                    if (GUILayout.Button(_sounds[k].ToString())) SoundManager.Instance?.Play(_sounds[k], 0f);
                }
                GUILayout.EndHorizontal();
            }

            GUILayout.EndArea();
        }
#endif
    }
}
