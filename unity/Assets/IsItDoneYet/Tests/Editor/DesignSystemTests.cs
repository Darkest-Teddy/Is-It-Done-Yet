using System;
using System.Collections.Generic;
using System.IO;
using IsItDoneYet.Core;
using IsItDoneYet.Design;
using IsItDoneYet.Design.Editor;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;

namespace IsItDoneYet.Tests
{
    /// <summary>
    /// The design system: the imported token asset, the theme crossfade, and the easings.
    ///
    /// These run against the ASSET the importer produced, not against a fixture. A test that
    /// builds its own DesignTokens proves the test's assumptions; this proves the import.
    /// </summary>
    public class DesignSystemTests
    {
        static DesignTokens Tokens()
        {
            var tokens = AssetDatabase.LoadAssetAtPath<DesignTokens>("Assets/IsItDoneYet/Design/Resources/DesignTokens.asset");
            Assert.IsNotNull(tokens, "DesignTokens.asset is missing -- run IsItDoneYet/Design/Import Tokens");
            return tokens;
        }

        [Test]
        public void TheImportedAssetHasAllThreeThemes()
        {
            var tokens = Tokens();
            Assert.That(tokens.Themes.Count, Is.EqualTo(3));
            foreach (ThemeName name in Enum.GetValues(typeof(ThemeName)))
                Assert.IsNotNull(tokens.Palette(name), $"no palette for {name}");
        }

        [Test]
        public void EveryThemeDefinesEveryColorRole()
        {
            // The importer is supposed to fail rather than leave a gap. This is the assertion
            // that a gap would have produced a magenta panel somebody finds in a headset.
            var tokens = Tokens();
            foreach (var palette in tokens.Themes)
            {
                palette.Rebuild();
                foreach (ColorRole role in Enum.GetValues(typeof(ColorRole)))
                {
                    var color = palette.Get(role);
                    Assert.AreNotEqual(Color.magenta, color, $"{palette.Name}.{role} was never imported");
                }
            }
        }

        [Test]
        public void TokenJsonAndTheColorRoleEnumAgreeExactly()
        {
            var path = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "..", "design/tokens.json"));
            Assert.IsTrue(File.Exists(path), $"no token file at {path}");

            var text = File.ReadAllText(path);
            var roles = (ColorRole[])Enum.GetValues(typeof(ColorRole));
            foreach (var role in roles)
            {
                // `Accent2` -> `accent-2`, `TextOnDark` -> `text-on-dark`.
                var key = KebabCase(role.ToString());
                Assert.IsTrue(text.Contains($"\"{key}\""), $"ColorRole.{role} has no '{key}' entry in design/tokens.json");
            }
        }

        static string KebabCase(string pascal)
        {
            var builder = new System.Text.StringBuilder();
            for (var i = 0; i < pascal.Length; i++)
            {
                var c = pascal[i];
                if (i > 0 && (char.IsUpper(c) || char.IsDigit(c))) builder.Append('-');
                builder.Append(char.ToLowerInvariant(c));
            }
            return builder.ToString();
        }

        [Test]
        public void SafeThemeIsLargerAndCalmerThanNormal()
        {
            var tokens = Tokens();
            var normal = tokens.Palette(ThemeName.Normal);
            var safe = tokens.Palette(ThemeName.Safe);

            Assert.That(safe.TypeScale, Is.GreaterThan(normal.TypeScale));
            Assert.That(safe.MotionScale, Is.LessThan(normal.MotionScale));
            Assert.IsFalse(safe.LoopingAnimation);
            // A translucent panel over a bright hob is unreadable.
            Assert.That(safe.PanelOpacity, Is.EqualTo(1f).Within(1e-4f));
        }

        [Test]
        public void SafeThemeKeepsDanger()
        {
            // Suppressing the one colour that means "stop" in order to calm the palette would
            // be the wrong kind of calm.
            var tokens = Tokens();
            Assert.That(tokens.Palette(ThemeName.Safe).Get(ColorRole.Danger),
                        Is.EqualTo(tokens.Palette(ThemeName.Normal).Get(ColorRole.Danger)));
        }

        [Test]
        public void PracticeThemeAlwaysCarriesAWord()
        {
            // A mode that changes what a score means must never be signalled by hue alone.
            var practice = Tokens().Palette(ThemeName.Practice);
            Assert.IsTrue(practice.HasBadge);
            Assert.That(practice.BadgeText, Is.EqualTo("PRACTICE"));
        }

        [Test]
        public void PracticeAccentCarriesItsTextAtAA()
        {
            var tokens = Tokens();
            var practice = tokens.Palette(ThemeName.Practice);
            var ratio = Srgb.ContrastRatio(practice.Get(ColorRole.Accent), practice.Get(ColorRole.TextOnAccent));
            Assert.That(ratio, Is.GreaterThanOrEqualTo(4.5f), "practice accent dropped below AA for body text");
        }

        [Test]
        public void TheFillsMeasuredBelowAaAreMarkedLargeTextOnly()
        {
            var tokens = Tokens();
            Assert.That(tokens.LargeTextOnly, Does.Contain(ColorRole.Accent));
            Assert.IsFalse(tokens.AllowsBodyText(ColorRole.Accent));
            Assert.IsTrue(tokens.AllowsBodyText(ColorRole.Surface));
        }

        [Test]
        public void TheFiveShadowLevelsAreImportedInDepthOrder()
        {
            var tokens = Tokens();
            var flat = tokens.Shadow("flat");
            var chip = tokens.Shadow("chip");
            var card = tokens.Shadow("card");
            var panel = tokens.Shadow("panel");
            var hero = tokens.Shadow("hero");

            Assert.That(flat.HardAlpha, Is.EqualTo(0f));
            Assert.That(chip.HardOffsetPx.magnitude, Is.LessThan(card.HardOffsetPx.magnitude));
            Assert.That(card.HardOffsetPx.magnitude, Is.LessThan(panel.HardOffsetPx.magnitude));
            Assert.That(panel.HardOffsetPx.magnitude, Is.LessThan(hero.HardOffsetPx.magnitude));
        }

        [Test]
        public void MetaSXrFloorsSurviveTheImport()
        {
            var xr = Tokens().Xr;
            Assert.That(xr.MinBodyTextDmm, Is.EqualTo(24f));
            Assert.That(xr.MinTouchTargetDmm, Is.EqualTo(64f));
            Assert.That(xr.PrimaryContentFovDeg, Is.EqualTo(41f));
        }

        [Test]
        public void BothFontsAreBoundAndCarryGlyphs()
        {
            var tokens = Tokens();
            Assert.IsNotNull(tokens.DisplayFont, "display font not bound -- run Build Font Assets");
            Assert.IsNotNull(tokens.BodyFont, "body font not bound -- run Build Font Assets");
            // The first build of the font tool produced an asset with an EMPTY character table
            // that looked fine in the inspector and rendered nothing.
            Assert.That(tokens.DisplayFont.characterTable.Count, Is.GreaterThan(100));
            Assert.That(tokens.BodyFont.characterTable.Count, Is.GreaterThan(100));
        }

        [Test]
        public void TheDisplayFontFallsBackToTheBodyFont()
        {
            var tokens = Tokens();
            Assert.That(tokens.DisplayFont.fallbackFontAssetTable, Does.Contain(tokens.BodyFont));
        }

        [Test]
        public void ThemeBlend_EndsExactlyOnTheTargetColour()
        {
            var from = new Color(0.1f, 0.2f, 0.3f);
            var to = new Color(0.9f, 0.8f, 0.7f);
            var blended = ThemeManager.Blend(from, to, 1f);
            Assert.That(blended.r, Is.EqualTo(to.r).Within(1e-3f));
            Assert.That(blended.g, Is.EqualTo(to.g).Within(1e-3f));
            Assert.That(blended.b, Is.EqualTo(to.b).Within(1e-3f));
        }

        [Test]
        public void ThemeBlend_StartsExactlyOnTheSourceColour()
        {
            var from = new Color(0.1f, 0.2f, 0.3f);
            var blended = ThemeManager.Blend(from, new Color(0.9f, 0.8f, 0.7f), 0f);
            Assert.That(blended.r, Is.EqualTo(from.r).Within(1e-3f));
        }

        [Test]
        public void ThemeBlend_MidpointIsBrighterThanAPlainSrgbLerp()
        {
            // Lerping sRGB directly passes through a darker, muddier midpoint -- the classic
            // red-to-green-through-brown. Between this palette's red and gold that midpoint is
            // a visibly dirty orange, on screen for the whole fade.
            Srgb.TryParseHex("#F5230E", out var red);
            Srgb.TryParseHex("#FBD24B", out var gold);

            var correct = ThemeManager.Blend(red, gold, 0.5f);
            var naive = Color.Lerp(red, gold, 0.5f);

            Assert.That(Srgb.RelativeLuminance(correct), Is.GreaterThan(Srgb.RelativeLuminance(naive)));
        }

        [Test]
        public void ThemeBlend_ClampsOutsideZeroToOne()
        {
            var from = Color.black;
            var to = Color.white;
            Assert.That(ThemeManager.Blend(from, to, -3f).r, Is.EqualTo(from.r).Within(1e-3f));
            Assert.That(ThemeManager.Blend(from, to, 7f).r, Is.EqualTo(to.r).Within(1e-3f));
        }
    }

    public class EasingTests
    {
        [Test]
        public void CubicBezier_PinsTheEndpoints()
        {
            Assert.That(Easing.CubicBezier(0.4f, 0f, 0.2f, 1f, 0f), Is.EqualTo(0f));
            Assert.That(Easing.CubicBezier(0.4f, 0f, 0.2f, 1f, 1f), Is.EqualTo(1f));
        }

        [Test]
        public void CubicBezier_IsMonotonicForTheStandardCurve()
        {
            var previous = -1f;
            for (var x = 0f; x <= 1f; x += 0.01f)
            {
                var y = Easing.CubicBezier(0.4f, 0f, 0.2f, 1f, x);
                Assert.That(y, Is.GreaterThanOrEqualTo(previous - 1e-4f), $"dipped at x={x}");
                previous = y;
            }
        }

        [Test]
        public void CubicBezier_LinearCurveIsTheIdentity()
        {
            for (var x = 0f; x <= 1f; x += 0.1f)
                Assert.That(Easing.CubicBezier(0.33f, 0.33f, 0.66f, 0.66f, x), Is.EqualTo(x).Within(1e-3f));
        }

        [Test]
        public void CubicBezier_OvershootCurveActuallyOvershoots()
        {
            // The loading screen's gravity curve. Newton stalls in a region of this one, which
            // is why there is a bisection fallback -- a solver that quietly returns the wrong
            // root would make the bounce look like a stutter.
            var peak = 0f;
            for (var x = 0f; x <= 1f; x += 0.005f) peak = Mathf.Max(peak, Easing.CubicBezier(0.3f, 1.5f, 0.5f, 1f, x));
            Assert.That(peak, Is.GreaterThan(1f), "the overshoot curve never exceeded 1");
        }

        [Test]
        public void CubicBezier_ClampsOutsideZeroToOne()
        {
            Assert.That(Easing.CubicBezier(0.4f, 0f, 0.2f, 1f, -2f), Is.EqualTo(0f));
            Assert.That(Easing.CubicBezier(0.4f, 0f, 0.2f, 1f, 2f), Is.EqualTo(1f));
        }

        [Test]
        public void Spring_SettlesOnItsTarget()
        {
            var value = 0f;
            var velocity = 0f;
            for (var i = 0; i < 400; i++) value = Easing.Spring(value, 1f, ref velocity, 240f, 26f, 1f / 72f);
            Assert.That(value, Is.EqualTo(1f).Within(1e-3f));
            Assert.That(Mathf.Abs(velocity), Is.LessThan(1e-2f));
        }

        [Test]
        public void Spring_SurvivesALongFrame()
        {
            // One 200ms hitch integrated in a single Euler step sends a stiff spring to
            // infinity. Substepping caps the error rather than the symptom.
            var value = 0f;
            var velocity = 0f;
            value = Easing.Spring(value, 1f, ref velocity, 420f, 18f, 0.2f);
            Assert.IsFalse(float.IsNaN(value) || float.IsInfinity(value));
            Assert.That(Mathf.Abs(value), Is.LessThan(10f));
        }

        [Test]
        public void Spring_DoesNotMoveWhenAlreadyThere()
        {
            var value = 1f;
            var velocity = 0f;
            Assert.That(Easing.Spring(value, 1f, ref velocity, 240f, 26f, 1f / 72f), Is.EqualTo(1f).Within(1e-5f));
        }

        [Test]
        public void Squash_StartsAndEndsAtUnitScale()
        {
            var impact = new Vector2(1.10f, 0.82f);
            var rebound = new Vector2(0.96f, 1.05f);
            Assert.That(Vector2.Distance(Easing.Squash(impact, rebound, 0f), Vector2.one), Is.LessThan(1e-4f));
            Assert.That(Vector2.Distance(Easing.Squash(impact, rebound, 1f), Vector2.one), Is.LessThan(1e-4f));
        }

        [Test]
        public void Squash_WidensOnImpact()
        {
            var impact = new Vector2(1.10f, 0.82f);
            var rebound = new Vector2(0.96f, 1.05f);
            var atImpact = Easing.Squash(impact, rebound, 0.35f);
            Assert.That(atImpact.x, Is.GreaterThan(1f));
            Assert.That(atImpact.y, Is.LessThan(1f));
        }
    }
}
