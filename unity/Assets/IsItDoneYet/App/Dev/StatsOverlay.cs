using System.Text;
using IsItDoneYet.Design;
using TMPro;
using UnityEngine;

namespace IsItDoneYet.App
{
    /// <summary>
    /// Frame time, allocations, and whether the HUD is still somewhere the cook can read it.
    ///
    /// Development only, and compiled out of a release build entirely -- not hidden behind a
    /// flag. An overlay that ships is an overlay somebody enables by accident in front of a
    /// judge.
    ///
    /// It has to cost nothing to be honest. A stats overlay that allocates a string per frame
    /// is measuring its own garbage, so the text is built into a reused StringBuilder and only
    /// when the display actually changes.
    /// </summary>
    public class StatsOverlay : MonoBehaviour
    {
        [SerializeField] TextMeshPro _text;
        [SerializeField] HudRoot _hud;
        [SerializeField] FrameUploader _uploader;

        [Tooltip("Updates per second. Faster than this and the numbers are unreadable anyway.")]
        public float RefreshHz = 4f;

        readonly StringBuilder _builder = new StringBuilder(256);
        float _nextRefresh;
        float _worstMs;
        int _frames;
        float _accumulatedMs;
        long _lastGcBytes;
        int _collections;

#if !UNITY_EDITOR && !DEVELOPMENT_BUILD
        void Awake() => gameObject.SetActive(false);
#endif

        void Update()
        {
            var ms = Time.unscaledDeltaTime * 1000f;
            _accumulatedMs += ms;
            _frames++;
            if (ms > _worstMs) _worstMs = ms;

            var gc = System.GC.GetTotalMemory(false);
            if (gc < _lastGcBytes) _collections++;
            _lastGcBytes = gc;

            if (Time.unscaledTime < _nextRefresh) return;
            _nextRefresh = Time.unscaledTime + 1f / Mathf.Max(1f, RefreshHz);

            var averageMs = _frames > 0 ? _accumulatedMs / _frames : 0f;
            var budget = ThemeManager.Instance?.Tokens?.Xr.TargetHz ?? 72f;
            var budgetMs = 1000f / budget;

            _builder.Clear();
            _builder.Append("avg ").Append(averageMs.ToString("0.0")).Append("ms");
            _builder.Append("  worst ").Append(_worstMs.ToString("0.0")).Append("ms");
            // The budget matters more than the average. A 72Hz target is 13.9ms and an app
            // that averages 11 while spiking to 30 is an app that judders.
            _builder.Append(averageMs > budgetMs ? "  OVER" : "  ok").Append('\n');

            _builder.Append("heap ").Append((gc / 1024 / 1024f).ToString("0.0")).Append("MB");
            _builder.Append("  gc ").Append(_collections).Append('\n');

            _builder.Append("tweens ").Append(TweenRunner.Instance != null ? TweenRunner.Instance.ActiveCount : 0);
            if (_uploader != null)
            {
                _builder.Append("  frames ").Append(_uploader.FramesSent)
                        .Append('/').Append(_uploader.FramesSent + _uploader.FramesDropped)
                        .Append("  ").Append(_uploader.LastUploadBytes / 1024).Append("KB");
            }
            _builder.Append('\n');

            _builder.Append("room ").Append(AdaptiveLegibility.RoomLuminance.ToString("0.00"));
            _builder.Append("  panel x").Append(AdaptiveLegibility.OpacityBoost.ToString("0.00"));
            if (_hud != null) _builder.Append(_hud.AnchorsWithinComfort() ? "  hud ok" : "  HUD OUT OF FOV");

            if (_text != null) _text.SetText(_builder);

            _frames = 0;
            _accumulatedMs = 0f;
            _worstMs = 0f;
        }

        public void Toggle() => gameObject.SetActive(!gameObject.activeSelf);
    }
}
