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

    /// <summary>
    /// The PRACTICE badge, and anything else that must be readable as a word rather than as a
    /// colour.
    ///
    /// Separate from <see cref="Chip"/> because it means something different: a chip describes
    /// the thing it sits on, a badge describes the MODE the app is in. Practice mode changes
    /// what a score means, and signalling that with a hue alone is invisible to a colourblind
    /// cook -- so the badge always carries the word.
    /// </summary>
    [ExecuteAlways]
    public class Badge : MonoBehaviour
    {
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

        public void Refresh()
        {
            var theme = ThemeManager.Instance;
            var show = theme != null && theme.HasBadge;
            // Hidden by disabling the renderers, not the GameObject: a disabled GameObject's
            // OnEnable never runs again through a theme change, so it would stay hidden after
            // switching back into a theme that has a badge.
            if (_panel != null) _panel.gameObject.SetActive(show);
            if (_label != null) _label.gameObject.SetActive(show);
            if (!show || _panel == null) return;

            var palette = theme.Tokens != null ? theme.Tokens.Palette(theme.Current) : null;
            _panel.Fill = ColorRole.Accent;
            _panel.Border = ColorRole.Ink;
            _panel.RadiusPx = 999f;
            _panel.ShadowLevel = "chip";
            _panel.Refresh();

            if (_label != null)
            {
                _label.Text = palette != null && !string.IsNullOrEmpty(palette.BadgeText) ? palette.BadgeText : theme.BadgeText;
                _label.TypeRole = "label";
                _label.Color = ColorRole.TextOnDark;
                _label.OnFill = ColorRole.Accent;
                _label.Refresh();
            }
        }
    }

    /// <summary>The 3px dashed rule that separates a panel's footer from its body.</summary>
    [ExecuteAlways]
    public class Divider : MonoBehaviour
    {
        public float WidthM = 0.3f;
        public bool Dashed = true;

        [SerializeField] GlassPanel _panel;

        void OnEnable()
        {
            if (_panel == null) _panel = GetComponentInChildren<GlassPanel>();
            ThemeManager.AnyThemeChanged += Refresh;
            Refresh();
        }

        void OnDisable() => ThemeManager.AnyThemeChanged -= Refresh;

        public void Refresh()
        {
            if (_panel == null) return;
            _panel.SizeM = new Vector2(WidthM, GlassPanel.Px(3f));
            _panel.Fill = ColorRole.Divider;
            _panel.Border = ColorRole.Divider;
            _panel.BorderPx = 0f;
            _panel.RadiusPx = 2f;
            // No shadow at all. A 3px rule with a drop shadow reads as a seam in the panel,
            // which is a different thing from a divider and looks like a rendering fault.
            _panel.ShadowLevel = "flat";
            _panel.Dashed = Dashed;
            _panel.Frost = 0f;
            _panel.Refresh();
        }
    }
}
