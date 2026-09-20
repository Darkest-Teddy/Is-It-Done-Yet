using UnityEngine;

namespace IsItDoneYet.Design
{
    /// <summary>
    /// A recipe card: a tinted art well, a title, and a row of chips.
    ///
    /// The cover art is procedural -- a tinted panel behind an ingredient icon -- and that is a
    /// decision, not a shortcut. A downloaded cover image is a network fetch on the critical
    /// path of a carousel the cook is already scrolling, on venue wifi, and the failure mode is
    /// a wall of grey rectangles at the exact moment somebody is being shown the app. The
    /// server sends three hex values per recipe instead; see server/src/cover.js.
    /// </summary>
    [ExecuteAlways]
    public class Card : MonoBehaviour
    {
        [Header("Content")]
        public string Title = "Smash Burger";
        public string Footnote = "9 / 9 on counter";
        public string IconName = "patty";

        [Header("Cover")]
        [Tooltip("Set from the recipe's cover hint. Falls back to the theme's warning fill.")]
        public Color CoverTint = new Color(0.98f, 0.89f, 0.63f);
        public bool UseCoverTint = true;

        [Header("Size")]
        public Vector2 SizeM = new Vector2(0.17f, 0.22f);
        public float ArtHeightM = 0.085f;

        [SerializeField] GlassPanel _panel;
        [SerializeField] GlassPanel _artWell;
        [SerializeField] IconQuad _icon;
        [SerializeField] Label _title;
        [SerializeField] Label _footnote;
        [SerializeField] Chip _chipA;
        [SerializeField] Chip _chipB;

        float _lift;
        float _liftVelocity;
        bool _selected;
        Vector3 _restLocalPosition;

        void OnEnable()
        {
            _restLocalPosition = transform.localPosition;
            ThemeManager.AnyThemeChanged += Refresh;
            Refresh();
        }

        void OnDisable() => ThemeManager.AnyThemeChanged -= Refresh;

#if UNITY_EDITOR
        void OnValidate() { if (isActiveAndEnabled) Refresh(); }
#endif

        /// <summary>The selected card lifts toward the cook and deepens its shadow.</summary>
        public void SetSelected(bool selected)
        {
            if (_selected == selected) return;
            _selected = selected;
            if (_panel != null)
            {
                _panel.ShadowLevel = selected ? "hero" : "card";
                _panel.Refresh();
            }
        }

        public void Set(string title, string footnote, string iconName, Color coverTint, string chipA, Chip.ChipTone toneA, string chipB, Chip.ChipTone toneB)
        {
            Title = title;
            Footnote = footnote;
            IconName = iconName;
            CoverTint = coverTint;
            if (_chipA != null) _chipA.Set(chipA, toneA);
            if (_chipB != null) _chipB.Set(chipB, toneB);
            Refresh();
        }

        public void Refresh()
        {
            if (_panel != null)
            {
                _panel.SizeM = SizeM;
                _panel.Fill = ColorRole.Surface;
                _panel.Border = ColorRole.Ink;
                _panel.RadiusPx = 24f;
                _panel.BorderPx = 5f;
                _panel.ShadowLevel = _selected ? "hero" : "card";
                _panel.Refresh();
            }

            if (_artWell != null)
            {
                _artWell.SizeM = new Vector2(SizeM.x - GlassPanel.Px(32f), ArtHeightM);
                _artWell.transform.localPosition = new Vector3(0f, SizeM.y * 0.5f - ArtHeightM * 0.5f - GlassPanel.Px(16f), 0.001f);
                _artWell.Border = ColorRole.Ink;
                _artWell.BorderPx = 4f;
                _artWell.RadiusPx = 18f;
                _artWell.ShadowLevel = "flat";
                _artWell.Refresh();
            }

            if (_icon != null)
            {
                _icon.IconName = IconName;
                _icon.Tinted = false;
                _icon.SizeM = ArtHeightM * 0.72f;
                _icon.Refresh();
            }

            if (_title != null)
            {
                _title.Text = Title;
                _title.TypeRole = "displaySm";
                _title.Color = ColorRole.TextPrimary;
                _title.OnFill = ColorRole.Surface;
                _title.Refresh();
            }

            if (_footnote != null)
            {
                _footnote.Text = Footnote;
                _footnote.TypeRole = "labelTight";
                _footnote.Color = ColorRole.TextMuted;
                _footnote.OnFill = ColorRole.Surface;
                _footnote.Refresh();
            }
        }

        void Update()
        {
            var target = _selected ? 0.012f : 0f;
            _lift = Easing.Spring(_lift, target, ref _liftVelocity, 260f, 28f, Time.deltaTime);
            transform.localPosition = _restLocalPosition + Vector3.back * _lift;
        }

        /// <summary>
        /// Pushes the server's cover tint into the art well.
        ///
        /// The tint is the ONLY thing the server sends about a cover's look, and it is applied
        /// directly rather than through a ColorRole, because it is per-recipe data and not part
        /// of the palette. The outline and the text stay themed, so a PRACTICE or SAFE theme
        /// still reads across a whole shelf of differently-tinted cards.
        /// </summary>
        public void ApplyCoverTint()
        {
            if (_artWell == null || !UseCoverTint) return;
            var renderer = _artWell.GetComponent<MeshRenderer>();
            if (renderer == null) return;
            var block = new MaterialPropertyBlock();
            renderer.GetPropertyBlock(block);
            block.SetColor(Shader.PropertyToID("_Fill"), Core.Srgb.ForShader(CoverTint));
            renderer.SetPropertyBlock(block);
        }
    }
}
