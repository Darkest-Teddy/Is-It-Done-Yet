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
            // A contrast violation is a warning in the Editor and silent in a build. It is a
            // design error, not a runtime one, and the place to catch it is the Design Gallery.
            if (theme != null && !role.Display && !theme.AllowsBodyText(OnFill))
            {
                Debug.LogWarning(
                    $"[Design] '{name}' sets body-sized type on {OnFill}, which measured below 4.5:1. " +
                    "Use a display role or a different fill -- see design/DEVIATIONS.md #10.", this);
            }
#endif
        }
    }
}
