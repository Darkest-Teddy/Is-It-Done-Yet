using System;
using System.Collections.Generic;
using UnityEngine;

namespace IsItDoneYet.Design
{
    public enum ThemeName { Normal = 0, Safe = 1, Practice = 2 }

    /// <summary>
    /// Every colour the design has, as an enum rather than a string key.
    ///
    /// A typed role is checked by the compiler; a string key is checked by whoever happens to
    /// look at the panel that went magenta. The names are the keys in design/tokens.json with
    /// the hyphens removed, and the importer asserts that the two lists match exactly -- so
    /// adding a colour to the JSON without adding it here fails the import rather than being
    /// silently dropped.
    /// </summary>
    public enum ColorRole
    {
        Ink, InkWarm,
        Background, BackgroundPaper,
        Surface, SurfaceSunken, SurfaceRail,
        Accent, Accent2,
        Success, SuccessInk,
        Warning, WarningInk,
        Danger, DangerInk,
        Info, InfoInk,
        Spice, SpiceInk,
        TextPrimary, TextMuted, TextBody,
        TextOnDark, TextOnDarkMuted, TextOnAccent,
        Outline, OutlineSoft, Divider,
        CounterWood, CounterEdge,
    }

    /// <summary>A named role paired with the sRGB colour the reference gave it.</summary>
    [Serializable]
    public struct RoleColor
    {
        public ColorRole Role;
        [ColorUsage(true, false)] public Color Srgb;
    }

    [Serializable]
    public class ThemePalette
    {
        public ThemeName Name;
        public List<RoleColor> Colors = new List<RoleColor>();
        [Tooltip("Multiplies every type size. SAFE runs at 1.25.")]
        public float TypeScale = 1f;
        [Tooltip("Multiplies every tween duration. SAFE runs at 0.35 and stops looping motion.")]
        public float MotionScale = 1f;
        public bool LoopingAnimation = true;
        [Range(0f, 1f)] public float PanelOpacity = 0.94f;
        public bool HasBadge;
        public string BadgeText = string.Empty;
        [ColorUsage(true, false)] public Color BadgeFill = Color.white;
        [ColorUsage(true, false)] public Color BadgeInk = Color.black;

        // Filled by Rebuild so lookup is an array index rather than a list scan. The scan
        // version cost 30 comparisons per colour per panel per frame, which is nothing until
        // a dozen panels are up and it is suddenly a measurable slice of the frame.
        Color[] _byRole;

        public void Rebuild()
        {
            var count = Enum.GetValues(typeof(ColorRole)).Length;
            _byRole = new Color[count];
            for (var i = 0; i < count; i++) _byRole[i] = Color.magenta;
            for (var i = 0; i < Colors.Count; i++) _byRole[(int)Colors[i].Role] = Colors[i].Srgb;
        }

        /// <summary>
        /// The sRGB value. Callers pushing this to a shader must go through
        /// <see cref="IsItDoneYet.Core.Srgb.ForShader"/>; callers handing it to TextMeshPro
        /// must not.
        /// </summary>
        public Color Get(ColorRole role)
        {
            if (_byRole == null) Rebuild();
            var index = (int)role;
            // Magenta is the deliberate "this was never imported" colour. Silently returning
            // white or clear would make a missing token look like a design choice.
            return index >= 0 && index < _byRole.Length ? _byRole[index] : Color.magenta;
        }
    }

    [Serializable]
    public struct ShadowLevel
    {
        public string Name;
        public Vector2 HardOffsetPx;
        [Range(0f, 1f)] public float HardAlpha;
        public Vector2 BlurOffsetPx;
        public float BlurPx;
        [Range(0f, 1f)] public float BlurAlpha;
        [Range(0f, 1f)] public float LipAlpha;
        [Range(0f, 1f)] public float FootAlpha;
    }

    [Serializable]
    public struct TypeRole
    {
        public string Name;
        public bool Display;
        public float SizePx;
        public float Weight;
        public float LineHeight;
        public float TrackingEm;
        public bool Uppercase;
    }

    [Serializable]
    public struct EasingCurve
    {
        public string Name;
        public Vector4 CubicBezier;
    }

    [Serializable]
    public struct SpringSetting
    {
        public string Name;
        public float Stiffness;
        public float Damping;
    }

    [Serializable]
    public struct NamedDuration
    {
        public string Name;
        public float Seconds;
    }

    /// <summary>
    /// Meta's own numbers, as hard floors rather than suggestions.
    ///
    /// A dmm is one millimetre at one metre, so it is an angular unit: a size in dmm subtends
    /// the same angle however far away the panel sits. That is the only way "minimum readable
    /// text" can mean anything in a world where the cook decides how far away to put things.
    /// </summary>
    [Serializable]
    public class XrTokens
    {
        public float MinBodyTextDmm = 24f;
        public float MinTouchTargetDmm = 64f;
        public float TouchPaddingDmm = 16f;
        public float PrimaryContentFovDeg = 41f;
        public float TargetHz = 72f;

        public float DirectHandM = 0.45f;
        public float HybridM = 0.70f;
        public float IndirectM = 1.0f;
        public float HudTitleM = 1.4f;
        public float SideMenuRadiusM = 0.9f;
        public float GrabbablePanelMinM = 0.6f;
        public float GrabbablePanelMaxM = 1.0f;

        public float TitleAboveEyeDeg = 15f;
        public float ToastBelowEyeDeg = 12f;
        public float LazyFollowDeadZoneDeg = 8f;
    }

    /// <summary>
    /// The design system, as one asset, generated from design/tokens.json.
    ///
    /// Generated and not hand-edited: the JSON is the source of truth for both this and the web
    /// tooling, and two hand-maintained copies of a palette diverge within a day. Re-run
    /// <c>IsItDoneYet/Design/Import Tokens</c> after touching the JSON.
    /// </summary>
    [CreateAssetMenu(menuName = "IsItDoneYet/Design Tokens", fileName = "DesignTokens")]
    public class DesignTokens : ScriptableObject
    {
        [Header("Provenance")]
        public string SourceFile = "design/tokens.json";
        public string ImportedAt = string.Empty;

        [Header("Themes")]
        public List<ThemePalette> Themes = new List<ThemePalette>();

        [Header("Geometry (reference pixels)")]
        public float RadiusXs = 5f, RadiusSm = 9f, RadiusMd = 14f, RadiusLg = 18f;
        public float RadiusXl = 22f, Radius2Xl = 26f, Radius3Xl = 34f;
        public float BorderHairline = 2f, BorderThin = 3f, BorderBase = 4f, BorderThick = 5f, BorderHeavy = 6f;
        public List<ShadowLevel> Shadows = new List<ShadowLevel>();
        [ColorUsage(true, false)] public Color ShadowHardColor = Color.black;
        [ColorUsage(true, false)] public Color ShadowBlurColor = Color.black;
        [ColorUsage(true, false)] public Color ShadowLipColor = Color.white;
        [ColorUsage(true, false)] public Color ShadowFootColor = Color.black;

        [Header("Type")]
        public List<TypeRole> TypeRoles = new List<TypeRole>();
        public TMPro.TMP_FontAsset DisplayFont;
        public TMPro.TMP_FontAsset BodyFont;

        [Header("Motion")]
        public List<NamedDuration> Durations = new List<NamedDuration>();
        public List<EasingCurve> Easings = new List<EasingCurve>();
        public List<SpringSetting> Springs = new List<SpringSetting>();
        public Vector2 SquashImpact = new Vector2(1.10f, 0.82f);
        public Vector2 SquashRebound = new Vector2(0.96f, 1.05f);
        public float MaxFlashHz = 3f;

        [Header("XR")]
        public XrTokens Xr = new XrTokens();

        [Header("Contrast")]
        [Tooltip("Roles that measured below 4.5:1 against their own text colour. Display sizes only.")]
        public List<ColorRole> LargeTextOnly = new List<ColorRole>();

        public ThemePalette Palette(ThemeName name)
        {
            for (var i = 0; i < Themes.Count; i++) if (Themes[i].Name == name) return Themes[i];
            return Themes.Count > 0 ? Themes[0] : null;
        }

        public float Duration(string name, float fallback = 0.3f)
        {
            for (var i = 0; i < Durations.Count; i++) if (Durations[i].Name == name) return Durations[i].Seconds;
            return fallback;
        }

        public Vector4 Easing(string name)
        {
            for (var i = 0; i < Easings.Count; i++) if (Easings[i].Name == name) return Easings[i].CubicBezier;
            return new Vector4(0.4f, 0f, 0.2f, 1f);
        }

        public ShadowLevel Shadow(string name)
        {
            for (var i = 0; i < Shadows.Count; i++) if (Shadows[i].Name == name) return Shadows[i];
            return Shadows.Count > 0 ? Shadows[0] : default;
        }

        public TypeRole Type(string name)
        {
            for (var i = 0; i < TypeRoles.Count; i++) if (TypeRoles[i].Name == name) return TypeRoles[i];
            return TypeRoles.Count > 0 ? TypeRoles[0] : default;
        }

        /// <summary>
        /// May a label of this angular size be set on this fill?
        ///
        /// Enforced rather than documented. The measured ratios live in design/tokens.json and
        /// three of the fills are below AA for body text -- the reference only ever puts display
        /// type on them, and this is what keeps that true as the app grows.
        /// </summary>
        public bool AllowsBodyText(ColorRole fill) => !LargeTextOnly.Contains(fill);

        void OnEnable()
        {
            for (var i = 0; i < Themes.Count; i++) Themes[i].Rebuild();
        }
    }
}
