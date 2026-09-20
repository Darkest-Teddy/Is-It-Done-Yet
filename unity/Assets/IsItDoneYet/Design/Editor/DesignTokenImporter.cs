using System;
using System.Collections.Generic;
using System.IO;
using IsItDoneYet.Core;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace IsItDoneYet.Design.Editor
{
    /// <summary>
    /// Turns design/tokens.json into the DesignTokens asset.
    ///
    /// One direction only. The JSON is the source of truth for this importer AND for the web
    /// tooling that measures the contrast ratios, and two hand-maintained copies of a palette
    /// diverge inside a day -- usually the day of the demo, usually in the one colour nobody
    /// looks at until it is on a wall.
    ///
    /// The import FAILS rather than filling gaps. A colour in the JSON with no matching
    /// <see cref="ColorRole"/>, a role with no colour, a malformed hex: each stops the import
    /// with a message naming the key. The alternative is a silent magenta on a panel somebody
    /// notices in a headset three hours later.
    /// </summary>
    public static class DesignTokenImporter
    {
        const string AssetPath = "Assets/IsItDoneYet/Design/Resources/DesignTokens.asset";
        const string TokensRelativePath = "../design/tokens.json";

        [MenuItem("IsItDoneYet/Design/Import Tokens %#t")]
        public static void ImportMenu()
        {
            var asset = Import();
            if (asset != null) Selection.activeObject = asset;
        }

        /// <summary>Entry point for batchmode: <c>-executeMethod ...DesignTokenImporter.ImportBatch</c>.</summary>
        public static void ImportBatch()
        {
            var asset = Import();
            if (asset == null)
            {
                // Batchmode swallows a Debug.LogError into a zero exit code, so a failed import
                // in CI would look like a successful one. Exiting non-zero is the only signal
                // that survives.
                EditorApplication.Exit(1);
                return;
            }
            Debug.Log($"[Design] imported {asset.Themes.Count} themes, {asset.TypeRoles.Count} type roles");
        }

        public static DesignTokens Import()
        {
            var path = Path.GetFullPath(Path.Combine(Application.dataPath, "..", TokensRelativePath));
            if (!File.Exists(path))
            {
                Debug.LogError($"[Design] no token file at {path}");
                return null;
            }

            JObject root;
            try
            {
                root = JObject.Parse(File.ReadAllText(path));
            }
            catch (Exception error)
            {
                Debug.LogError($"[Design] {TokensRelativePath} is not valid JSON: {error.Message}");
                return null;
            }

            var asset = AssetDatabase.LoadAssetAtPath<DesignTokens>(AssetPath);
            var created = asset == null;
            if (created)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(Application.dataPath, "..", AssetPath)) ?? ".");
                asset = ScriptableObject.CreateInstance<DesignTokens>();
            }

            try
            {
                Populate(asset, root);
            }
            catch (Exception error)
            {
                Debug.LogError($"[Design] token import failed: {error.Message}");
                return null;
            }

            asset.SourceFile = "design/tokens.json";
            asset.ImportedAt = DateTime.UtcNow.ToString("O");

            if (created) AssetDatabase.CreateAsset(asset, AssetPath);
            EditorUtility.SetDirty(asset);
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            return asset;
        }

        static void Populate(DesignTokens asset, JObject root)
        {
            var colors = Require<JObject>(root, "color");
            var baseColors = ReadPalette(colors);

            // --- geometry -------------------------------------------------------------------
            var radius = Require<JObject>(root, "radius");
            asset.RadiusXs = Num(radius, "xs", 5f);
            asset.RadiusSm = Num(radius, "sm", 9f);
            asset.RadiusMd = Num(radius, "md", 14f);
            asset.RadiusLg = Num(radius, "lg", 18f);
            asset.RadiusXl = Num(radius, "xl", 22f);
            asset.Radius2Xl = Num(radius, "2xl", 26f);
            asset.Radius3Xl = Num(radius, "3xl", 34f);

            var border = Require<JObject>(root, "border");
            asset.BorderHairline = Num(border, "hairline", 2f);
            asset.BorderThin = Num(border, "thin", 3f);
            asset.BorderBase = Num(border, "base", 4f);
            asset.BorderThick = Num(border, "thick", 5f);
            asset.BorderHeavy = Num(border, "heavy", 6f);

            // --- shadows ---------------------------------------------------------------------
            var shadow = Require<JObject>(root, "shadow");
            asset.Shadows.Clear();
            foreach (var entry in shadow)
            {
                if (entry.Value is not JObject level) continue;
                if (!level.ContainsKey("hardOffset")) continue;
                asset.Shadows.Add(new ShadowLevel
                {
                    Name = entry.Key,
                    HardOffsetPx = Vec2(level["hardOffset"]),
                    HardAlpha = (float?)level["hardAlpha"] ?? 0f,
                    BlurOffsetPx = Vec2(level["blurOffset"]),
                    BlurPx = (float?)level["blurPx"] ?? 0f,
                    BlurAlpha = (float?)level["blurAlpha"] ?? 0f,
                    LipAlpha = (float?)level["lipAlpha"] ?? 0f,
                    FootAlpha = (float?)level["footAlpha"] ?? 0f,
                });
            }
            asset.ShadowHardColor = Hex(shadow, "hardColor", "#46101A");
            asset.ShadowBlurColor = Hex(shadow, "blurColor", "#000000");
            asset.ShadowLipColor = Hex(shadow, "lipColor", "#FFFFFF");
            asset.ShadowFootColor = Hex(shadow, "footColor", "#784A2C");

            // --- type -------------------------------------------------------------------------
            var type = Require<JObject>(root, "type");
            var roles = Require<JObject>(type, "role");
            asset.TypeRoles.Clear();
            foreach (var entry in roles)
            {
                if (entry.Value is not JObject role) continue;
                var family = (string)role["family"] ?? "body";
                asset.TypeRoles.Add(new TypeRole
                {
                    Name = entry.Key,
                    Display = family == "display",
                    SizePx = (float?)role["size"] ?? 15f,
                    // A display face has one weight. Recording 400 for it rather than leaving
                    // zero means a component asking "is this bold" gets a real answer.
                    Weight = (float?)role["weight"] ?? 400f,
                    LineHeight = (float?)role["lineHeight"] ?? 1.2f,
                    TrackingEm = (float?)role["tracking"] ?? 0f,
                    Uppercase = (string)role["transform"] == "uppercase",
                });
            }

            // --- motion ------------------------------------------------------------------------
            var motion = Require<JObject>(root, "motion");
            asset.Durations.Clear();
            foreach (var entry in Require<JObject>(motion, "duration"))
            {
                asset.Durations.Add(new NamedDuration { Name = entry.Key, Seconds = (float?)entry.Value ?? 0.3f });
            }

            asset.Easings.Clear();
            foreach (var entry in Require<JObject>(motion, "easing"))
            {
                if (entry.Value is not JObject easing) continue;
                var controls = easing["cubicBezier"] as JArray;
                if (controls == null || controls.Count != 4) throw new Exception($"easing '{entry.Key}' needs four cubicBezier values");
                asset.Easings.Add(new EasingCurve
                {
                    Name = entry.Key,
                    CubicBezier = new Vector4((float)controls[0], (float)controls[1], (float)controls[2], (float)controls[3]),
                });
            }

            asset.Springs.Clear();
            if (motion["spring"] is JObject springs)
            {
                foreach (var entry in springs)
                {
                    if (entry.Value is not JObject spring) continue;
                    asset.Springs.Add(new SpringSetting
                    {
                        Name = entry.Key,
                        Stiffness = (float?)spring["stiffness"] ?? 200f,
                        Damping = (float?)spring["damping"] ?? 24f,
                    });
                }
            }

            if (motion["squash"] is JObject squash)
            {
                asset.SquashImpact = Vec2(squash["impactScale"]);
                asset.SquashRebound = Vec2(squash["reboundScale"]);
            }
            if (motion["safety"] is JObject safety) asset.MaxFlashHz = (float?)safety["maxFlashHz"] ?? 3f;

            // --- xr ---------------------------------------------------------------------------
            var xr = Require<JObject>(root, "xr");
            var distance = Require<JObject>(xr, "distanceM");
            var angle = Require<JObject>(xr, "angleDeg");
            asset.Xr = new XrTokens
            {
                MinBodyTextDmm = Num(xr, "minBodyTextDmm", 24f),
                MinTouchTargetDmm = Num(xr, "minTouchTargetDmm", 64f),
                TouchPaddingDmm = Num(xr, "touchPaddingDmm", 16f),
                PrimaryContentFovDeg = Num(xr, "primaryContentFovDeg", 41f),
                TargetHz = Num(xr, "targetHz", 72f),
                DirectHandM = Num(distance, "directHand", 0.45f),
                HybridM = Num(distance, "hybrid", 0.70f),
                IndirectM = Num(distance, "indirect", 1.0f),
                HudTitleM = Num(distance, "hudTitle", 1.4f),
                SideMenuRadiusM = Num(distance, "sideMenuRadius", 0.9f),
                GrabbablePanelMinM = Num(distance, "grabbablePanelMin", 0.6f),
                GrabbablePanelMaxM = Num(distance, "grabbablePanelMax", 1.0f),
                TitleAboveEyeDeg = Num(angle, "titleAboveEye", 15f),
                ToastBelowEyeDeg = Num(angle, "toastBelowEye", 12f),
                LazyFollowDeadZoneDeg = Num(angle, "lazyFollowDeadZone", 8f),
            };

            // --- contrast ----------------------------------------------------------------------
            asset.LargeTextOnly.Clear();
            if (root["contrast"] is JObject contrast && contrast["largeTextOnly"] is JArray restricted)
            {
                foreach (var item in restricted)
                {
                    var key = (string)item;
                    if (TryRole(key, out var role)) asset.LargeTextOnly.Add(role);
                    else throw new Exception($"contrast.largeTextOnly names '{key}', which is not a ColorRole");
                }
            }

            // --- themes -------------------------------------------------------------------------
            var themes = Require<JObject>(root, "themes");
            asset.Themes.Clear();
            foreach (var entry in themes)
            {
                if (entry.Value is not JObject theme) continue;
                if (!Enum.TryParse<ThemeName>(entry.Key, true, out var name))
                    throw new Exception($"theme '{entry.Key}' has no matching ThemeName");

                // Start from the base palette and apply the theme's overrides. A theme that
                // listed its whole palette would drift from the base the first time a colour
                // changed in only one of them.
                var palette = new ThemePalette { Name = name, Colors = new List<RoleColor>(baseColors) };

                if (theme["overrides"] is JObject overrides)
                {
                    foreach (var over in overrides)
                    {
                        if (!TryRole(over.Key, out var role))
                            throw new Exception($"theme '{entry.Key}' overrides '{over.Key}', which is not a ColorRole");
                        if (!Srgb.TryParseHex((string)over.Value, out var color))
                            throw new Exception($"theme '{entry.Key}' override '{over.Key}' is not #RRGGBB");

                        var index = palette.Colors.FindIndex(c => c.Role == role);
                        if (index >= 0) palette.Colors[index] = new RoleColor { Role = role, Srgb = color };
                        else palette.Colors.Add(new RoleColor { Role = role, Srgb = color });
                    }
                }

                palette.TypeScale = Num(theme, "typeScale", 1f);
                palette.MotionScale = Num(theme, "motionScale", 1f);
                palette.LoopingAnimation = (bool?)theme["loopingAnimation"] ?? true;
                palette.PanelOpacity = Num(theme, "panelOpacity", 0.94f);

                if (theme["badge"] is JObject badge)
                {
                    palette.HasBadge = true;
                    palette.BadgeText = (string)badge["text"] ?? string.Empty;
                    palette.BadgeFill = Hex(badge, "fill", "#F5230E");
                    palette.BadgeInk = Hex(badge, "ink", "#FFF3E4");
                }

                palette.Rebuild();
                asset.Themes.Add(palette);
            }

            if (asset.Themes.Count == 0) throw new Exception("no themes were imported");

            BindFonts(asset);
        }

        /// <summary>
        /// Every colour in the JSON, as roles, with both directions checked.
        ///
        /// A key with no role is a typo somebody made in the JSON. A role with no key is a
        /// colour the code expects and the design does not define. Both are errors, and both
        /// would otherwise surface as magenta on exactly one panel.
        /// </summary>
        static List<RoleColor> ReadPalette(JObject colors)
        {
            var result = new List<RoleColor>();
            var seen = new HashSet<ColorRole>();

            foreach (var entry in colors)
            {
                if (entry.Value is not JObject definition) continue;
                if (!TryRole(entry.Key, out var role))
                    throw new Exception($"color '{entry.Key}' has no matching ColorRole -- add it to the enum or fix the key");

                var hex = (string)definition["hex"];
                if (!Srgb.TryParseHex(hex, out var color))
                    throw new Exception($"color '{entry.Key}' has hex '{hex}', which is not #RRGGBB");

                result.Add(new RoleColor { Role = role, Srgb = color });
                seen.Add(role);
            }

            foreach (ColorRole role in Enum.GetValues(typeof(ColorRole)))
            {
                if (!seen.Contains(role))
                    throw new Exception($"ColorRole.{role} has no entry in design/tokens.json");
            }

            return result;
        }

        /// <summary>`accent-2` and `text-on-dark` become `Accent2` and `TextOnDark`.</summary>
        static bool TryRole(string key, out ColorRole role)
        {
            role = default;
            if (string.IsNullOrEmpty(key)) return false;
            var pascal = key.Replace("-", string.Empty);
            return Enum.TryParse(pascal, true, out role);
        }

        static void BindFonts(DesignTokens asset)
        {
            // Bound by path rather than by GUID because these are generated by the font tool
            // and their GUIDs change every time somebody regenerates them.
            var display = AssetDatabase.LoadAssetAtPath<TMPro.TMP_FontAsset>("Assets/IsItDoneYet/Design/Fonts/Ranchers-SDF.asset");
            var body = AssetDatabase.LoadAssetAtPath<TMPro.TMP_FontAsset>("Assets/IsItDoneYet/Design/Fonts/HankenGrotesk-SDF.asset");
            if (display != null) asset.DisplayFont = display;
            if (body != null) asset.BodyFont = body;
            if (display == null || body == null)
            {
                Debug.LogWarning("[Design] SDF font assets not found -- run IsItDoneYet/Design/Build Font Assets first. " +
                                 "Labels will fall back to the TMP default until then.");
            }
        }

        static T Require<T>(JObject parent, string key) where T : JToken
        {
            if (parent[key] is T value) return value;
            throw new Exception($"design/tokens.json is missing '{key}'");
        }

        static float Num(JObject parent, string key, float fallback) => (float?)parent[key] ?? fallback;

        static Color Hex(JObject parent, string key, string fallback)
        {
            var raw = (string)parent[key] ?? fallback;
            return Srgb.TryParseHex(raw, out var color) ? color : Color.magenta;
        }

        static Vector2 Vec2(JToken token)
        {
            if (token is JArray array && array.Count >= 2) return new Vector2((float)array[0], (float)array[1]);
            return Vector2.zero;
        }
    }
}
