using UnityEngine;

namespace IsItDoneYet.Design
{
    /// <summary>
    /// The small stadium-shaped tag the design uses everywhere: "25 MIN", "LEVEL 2", "9 OF 9 ON
    /// THE COUNTER".
    ///
    /// Semantic rather than decorative. <see cref="Tone"/> picks a fill AND its matching ink
    /// from the measured pairs in design/tokens.json, so the two can never be set to a
    /// combination nobody checked -- which is exactly how a mint chip ends up with mint text.
    /// </summary>
    [ExecuteAlways]
    public class Chip : MonoBehaviour
    {
        public enum ChipTone { Neutral, Success, Warning, Danger, Info, Spice, Accent }

        [Header("Content")]
        public string Text = "CHIP";
        public ChipTone Tone = ChipTone.Neutral;

        [Header("Size")]
        public Vector2 PaddingM = new Vector2(0.016f, 0.007f);
        public float MinWidthM = 0.05f;

        [SerializeField] GlassPanel _panel;
        [SerializeField] Label _label;

        void OnEnable()
        {
            if (_panel == null) _panel = GetComponentInChildren<GlassPanel>();
            if (_label == null) _label = GetComponentInChildren<Label>();
            ThemeManager.AnyThemeChanged += Refresh;
            Refresh();
        }

        void OnDisable() => ThemeManager.AnyThemeChanged -= Refresh;

#if UNITY_EDITOR
        void OnValidate() { if (isActiveAndEnabled) Refresh(); }
#endif

        public void Set(string text, ChipTone tone)
        {
            Text = text;
            Tone = tone;
            Refresh();
        }

        public void Refresh()
        {
            if (_panel == null) return;
            ResolveTone(Tone, out var fill, out var ink);

            _panel.Fill = fill;
            _panel.Border = ColorRole.Ink;
            _panel.BorderPx = 3f;
            // A chip is always a stadium. A large radius on a short box reaches the shader's
            // clamp and becomes exactly that, at any width, with no special case.
            _panel.RadiusPx = 999f;
            _panel.ShadowLevel = "chip";
            _panel.Frost = 0f;

            if (_label != null)
            {
                _label.Text = Text;
                _label.TypeRole = "labelTight";
                _label.Color = ink;
                _label.OnFill = fill;
                _label.Alignment = TMPro.TextAlignmentOptions.Center;
                _label.Refresh();

                var preferred = _label.Tmp != null ? _label.Tmp.GetPreferredValues(Text) : Vector2.zero;
                var width = Mathf.Max(MinWidthM, preferred.x + PaddingM.x * 2f);
                var height = Mathf.Max(preferred.y + PaddingM.y * 2f, 0.022f);
                _panel.SetSize(new Vector2(width, height));
                _label.SizeM = new Vector2(width, height);
            }

            _panel.Refresh();
        }

        /// <summary>
        /// Fill and ink together, never separately. Every pair here has a measured contrast
        /// ratio recorded in design/tokens.json.
        /// </summary>
        public static void ResolveTone(ChipTone tone, out ColorRole fill, out ColorRole ink)
        {
            switch (tone)
            {
                case ChipTone.Success: fill = ColorRole.Success; ink = ColorRole.SuccessInk; break;
                case ChipTone.Warning: fill = ColorRole.Warning; ink = ColorRole.WarningInk; break;
                case ChipTone.Danger:  fill = ColorRole.Danger;  ink = ColorRole.DangerInk;  break;
                case ChipTone.Info:    fill = ColorRole.Info;    ink = ColorRole.InfoInk;    break;
                case ChipTone.Spice:   fill = ColorRole.Spice;   ink = ColorRole.SpiceInk;   break;
                case ChipTone.Accent:  fill = ColorRole.Accent;  ink = ColorRole.TextOnDark; break;
                default:               fill = ColorRole.Surface; ink = ColorRole.TextPrimary; break;
            }
        }
    }
}
