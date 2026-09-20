using UnityEngine;

// Split out of Chip.cs so the file name matches the class name.
//
// Unity resolves a MonoBehaviour by FILE name. A MonoBehaviour declared in a file called
// something else compiles perfectly and cannot be attached to a GameObject -- AddComponent
// fails and the scene stores a null script reference. It is silent at compile time and
// silent at edit time, and it surfaces as the component simply not being there.

namespace IsItDoneYet.Design
{
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
