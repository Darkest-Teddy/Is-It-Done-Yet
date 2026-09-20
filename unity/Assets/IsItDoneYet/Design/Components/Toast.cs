using System.Collections.Generic;
using IsItDoneYet.Core;
using UnityEngine;

namespace IsItDoneYet.Design
{
    /// <summary>
    /// One coach message: a glyph for the verdict, a line of text, and a row of pips showing how
    /// sure the model was.
    ///
    /// The pips are the point. The coach is a language model looking at a blurry frame from a
    /// head-mounted camera, and a sentence rendered with total typographic confidence invites
    /// the cook to trust it exactly as much as a thermometer. Four pips out of five says
    /// something a hedge word cannot.
    /// </summary>
    [ExecuteAlways]
    public class Toast : MonoBehaviour
    {
        [SerializeField] GlassPanel _panel;
        [SerializeField] Label _message;
        [SerializeField] Label _glyph;
        [SerializeField] Transform _pipRoot;

        [Header("Size")]
        public Vector2 SizeM = new Vector2(0.34f, 0.09f);
        public int PipCount = 5;

        readonly List<GlassPanel> _pips = new List<GlassPanel>();
        float _confidence;
        ObservationStatus _status = ObservationStatus.Unknown;

        public float ShownAt { get; private set; }
        public string Id { get; private set; }

        void OnEnable()
        {
            if (_panel == null) _panel = GetComponentInChildren<GlassPanel>();
            ThemeManager.AnyThemeChanged += Refresh;
            Refresh();
        }

        void OnDisable() => ThemeManager.AnyThemeChanged -= Refresh;

        public void Show(string id, string text, ObservationStatus status, float confidence, float nowSeconds)
        {
            Id = id;
            _status = status;
            _confidence = Mathf.Clamp01(confidence);
            ShownAt = nowSeconds;
            if (_message != null) _message.SetText(text);
            Refresh();
            PlayIn();
        }

        /// <summary>
        /// A glyph per state, in text rather than as a sprite.
        ///
        /// Four characters in the SDF atlas beat four textures: no atlas page, no import
        /// settings, and they inherit the label's outline so they stay legible over passthrough
        /// for free. The generator is told to include these explicitly -- see FontAssetBuilder.
        /// </summary>
        static string GlyphFor(ObservationStatus status)
        {
            switch (status)
            {
                case ObservationStatus.Ok: return "✓";
                case ObservationStatus.Warn: return "!";
                case ObservationStatus.Bad: return "✕";
                default: return "?";
            }
        }

        static void ToneFor(ObservationStatus status, out ColorRole fill, out ColorRole ink)
        {
            switch (status)
            {
                case ObservationStatus.Ok: Chip.ResolveTone(Chip.ChipTone.Success, out fill, out ink); break;
                case ObservationStatus.Warn: Chip.ResolveTone(Chip.ChipTone.Warning, out fill, out ink); break;
                case ObservationStatus.Bad: Chip.ResolveTone(Chip.ChipTone.Danger, out fill, out ink); break;
                default: Chip.ResolveTone(Chip.ChipTone.Neutral, out fill, out ink); break;
            }
        }

        public void Refresh()
        {
            if (_panel == null) return;
            ToneFor(_status, out var fill, out var ink);

            _panel.SizeM = SizeM;
            _panel.Fill = fill;
            _panel.Border = ColorRole.Ink;
            _panel.RadiusPx = 22f;
            _panel.ShadowLevel = "card";
            _panel.Refresh();

            if (_glyph != null)
            {
                _glyph.Text = GlyphFor(_status);
                _glyph.Color = ink;
                _glyph.OnFill = fill;
                _glyph.TypeRole = "displayXs";
                _glyph.Refresh();
            }

            if (_message != null)
            {
                _message.Color = ink;
                _message.OnFill = fill;
                _message.TypeRole = "body";
                _message.Refresh();
            }

            RefreshPips(ink);
        }

        void RefreshPips(ColorRole ink)
        {
            if (_pipRoot == null) return;

            // Built once and reused. Rebuilding the row per message would allocate a GameObject
            // per pip per toast, which for a run of a few hundred messages is a few thousand
            // objects nobody frees.
            while (_pips.Count < PipCount)
            {
                var host = new GameObject($"Pip{_pips.Count}", typeof(MeshFilter), typeof(MeshRenderer), typeof(GlassPanel));
                host.transform.SetParent(_pipRoot, false);
                var pip = host.GetComponent<GlassPanel>();
                pip.SizeM = new Vector2(0.006f, 0.006f);
                pip.RadiusPx = 999f;
                pip.BorderPx = 0f;
                pip.ShadowLevel = "flat";
                pip.Frost = 0f;
                _pips.Add(pip);
            }

            var lit = Mathf.RoundToInt(_confidence * PipCount);
            for (var i = 0; i < _pips.Count; i++)
            {
                var pip = _pips[i];
                pip.gameObject.SetActive(i < PipCount);
                pip.transform.localPosition = new Vector3(i * 0.009f, 0f, 0f);
                pip.Fill = i < lit ? ink : ColorRole.OutlineSoft;
                pip.OpacityScale = i < lit ? 1f : 0.4f;
                pip.Refresh();
            }
        }

        void PlayIn()
        {
            var tokens = ThemeManager.Instance != null ? ThemeManager.Instance.Tokens : null;
            var duration = tokens != null ? tokens.Duration("toast", 0.42f) : 0.42f;
            var easing = tokens != null ? tokens.Easing("overshoot") : new Vector4(0.3f, 1.5f, 0.5f, 1f);

            var start = transform.localPosition + Vector3.down * 0.06f;
            var end = transform.localPosition;
            var root = transform;
            TweenRunner.Instance.Play(duration, easing, t =>
            {
                if (root == null) return;
                root.localPosition = Vector3.LerpUnclamped(start, end, t);
            });
        }
    }
}
