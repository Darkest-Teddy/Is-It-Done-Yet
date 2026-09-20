using UnityEngine;

// Split out of Chip.cs so the file name matches the class name.
//
// Unity resolves a MonoBehaviour by FILE name. A MonoBehaviour declared in a file called
// something else compiles perfectly and cannot be attached to a GameObject -- AddComponent
// fails and the scene stores a null script reference. It is silent at compile time and
// silent at edit time, and it surfaces as the component simply not being there.

namespace IsItDoneYet.Design
{

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
}
