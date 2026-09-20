using IsItDoneYet.Core;
using TMPro;
using UnityEngine;

namespace IsItDoneYet.Design
{
    /// <summary>
    /// Text, sized in angular units and outlined so it survives passthrough.
    ///
    /// Two things make text different in a headset. It is read at a distance the cook chooses,
    /// so a size in metres is legible exactly once -- sizes here are in reference pixels and
    /// converted through dmm at the placement distance, with Meta's 24 dmm floor applied.
    ///
    /// And the background is a real kitchen. A panel is translucent over passthrough, so text
    /// sits over whatever is behind it: a dark counter, a window, a hob. The outline is not
    /// decoration, it is what keeps a label readable when the thing behind it happens to match
    /// its colour. <see cref="AdaptiveLegibility"/> drives the thickness from the room.
    /// </summary>
    [ExecuteAlways]
    [RequireComponent(typeof(TextMeshPro))]
    public class Label : MonoBehaviour
    {
        /// <summary>
        /// The angular size above which WCAG's large-text threshold (3:1) applies instead of
        /// the body threshold (4.5:1).
        ///
        /// WCAG defines large text as 18pt, which at a 40cm reading distance subtends the same
        /// angle as roughly 16 dmm. Meta's own floor for body text in a headset is 24 dmm --
        /// half again as large -- so every label in this app that respects the floor is already
        /// "large text" in the only sense the criterion is about, which is angular size.
        ///
        /// That is why the reference gets away with an 11px uppercase chip label on a fill
        /// measuring 3.97:1: on a monitor it is marginal, and at 24 dmm in a headset it is not.
        /// The guard below therefore checks the EFFECTIVE size, and still fires for anything
        /// that opts out of the floor.
        /// </summary>
        public const float LargeTextDmm = 16f;


        [Header("Content")]
        [TextArea] public string Text = "Label";

        [Header("Style")]
        [Tooltip("A role name from design/tokens.json: hero, screenTitle, panelTitle, body, label...")]
        public string TypeRole = "body";
        public ColorRole Color = ColorRole.TextPrimary;
        [Tooltip("The fill this text sits on. Checked against the measured contrast table.")]
        public ColorRole OnFill = ColorRole.Surface;

        [Header("Placement")]
        [Tooltip("How far the cook is expected to read this from. Drives the angular size.")]
        public float ViewDistanceM = 1.0f;
        public TextAlignmentOptions Alignment = TextAlignmentOptions.TopLeft;
        public Vector2 SizeM = new Vector2(0.3f, 0.06f);

        [Header("Legibility")]
        [Range(0f, 1f)] public float OutlineWidth = 0.15f;
        public ColorRole OutlineColor = ColorRole.Ink;

        TextMeshPro _text;
        LayoutConfig _layout;

        public TextMeshPro Tmp => _text;

        void OnEnable()
        {
            _text = GetComponent<TextMeshPro>();
            ThemeManager.AnyThemeChanged += Refresh;
            Refresh();
        }

        void OnDisable() => ThemeManager.AnyThemeChanged -= Refresh;

#if UNITY_EDITOR
        void OnValidate() { if (isActiveAndEnabled) Refresh(); }
#endif

        public void Bind(LayoutConfig layout) => _layout = layout;

        public void SetText(string value)
        {
            if (Text == value) return;
            Text = value;
            if (_text != null) _text.SetText(value);
        }

        public void Refresh()
        {
            if (_text == null) return;
            var theme = ThemeManager.Instance;
            var tokens = theme != null ? theme.Tokens : null;
            var role = tokens != null ? tokens.Type(TypeRole) : default;

            _text.SetText(Text ?? string.Empty);
            _text.alignment = Alignment;
            _text.rectTransform.sizeDelta = SizeM;
            _text.textWrappingMode = TextWrappingModes.Normal;
            _text.overflowMode = TextOverflowModes.Truncate;

            if (tokens != null)
            {
                var font = role.Display ? tokens.DisplayFont : tokens.BodyFont;
                if (font != null) _text.font = font;
            }

            var typeScale = theme != null ? theme.TypeScale : 1f;
            var sizePx = Mathf.Max(role.SizePx, 1f) * typeScale;

            // TMP's font size is in its own units; in a world-space TextMeshPro one unit of
            // font size is roughly 0.1 world units at scale 1. Converting through metres rather
            // than picking a number by eye is what makes the 24 dmm floor actually hold.
            var heightM = _layout != null
                ? _layout.TextHeightMetres(sizePx, ViewDistanceM)
                : AngularLayout.DmmToMetres(Mathf.Max(sizePx / 1.6f, 24f), ViewDistanceM);
            _text.fontSize = heightM * 10f;

            _text.characterSpacing = role.TrackingEm * 100f;
            _text.lineSpacing = (role.LineHeight - 1f) * 100f;
            _text.fontStyle = role.Uppercase ? FontStyles.UpperCase : FontStyles.Normal;
            _text.fontWeight = role.Weight >= 700 ? FontWeight.Bold : FontWeight.Regular;

            // Raw sRGB, deliberately: TMP's shaders expect a gamma vertex colour and convert
            // internally. Linearising here double-converts and every label goes dark.
            if (theme != null) _text.color = Srgb.ForText(theme.Color(Color));

            var outline = OutlineWidth * AdaptiveLegibility.OutlineBoost;
            _text.outlineWidth = Mathf.Clamp01(outline);
            if (theme != null) _text.outlineColor = Srgb.ForText(theme.Color(OutlineColor));

#if UNITY_EDITOR
            WarnIfUnreadable(theme, role, heightM);
#endif
        }

#if UNITY_EDITOR
        void WarnIfUnreadable(ThemeManager theme, TypeRole role, float heightM)
        {
            if (theme == null || role.Display) return;

            var dmm = Core.AngularLayout.MetresToDmm(heightM, Mathf.Max(ViewDistanceM, 0.05f));
            if (dmm >= LargeTextDmm) return;

            var ratio = Core.Srgb.ContrastRatio(theme.Color(OnFill), theme.Color(Color));
            if (ratio >= 4.5f) return;

            Debug.LogWarning(
                $"[Design] '{name}' sets {dmm:0} dmm type on {OnFill} at {ratio:0.00}:1, below 4.5:1 " +
                "for text this small. Raise the size, change the fill, or use a display role -- " +
                "see design/DEVIATIONS.md #10.", this);
        }
#endif
    }
}
