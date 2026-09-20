using System.Collections.Generic;
using System.IO;
using IsItDoneYet.Design;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace IsItDoneYet.Design.Editor
{
    /// <summary>
    /// Builds the Design Gallery scene from code, and renders it to PNGs.
    ///
    /// From code rather than by hand for one reason: a gallery that is hand-assembled drifts.
    /// Somebody adds a component and forgets the gallery, and the one place that was supposed
    /// to show every state in every theme quietly stops showing all of them -- which is worse
    /// than not having it, because people trust it.
    ///
    /// The capture is the design-fidelity check. It renders each component beside the
    /// reference screenshots so the comparison is something anybody can look at, rather than a
    /// claim in a commit message. It is a development scene and is excluded from the build.
    /// </summary>
    public static class DesignGalleryBuilder
    {
        const string ScenePath = "Assets/IsItDoneYet/Design/Editor/DesignGallery.unity";
        const string PreviewDir = "design/previews";

        [MenuItem("IsItDoneYet/Design/Build Design Gallery")]
        public static void BuildMenu()
        {
            var scene = Build();
            EditorSceneManager.SaveScene(scene, ScenePath);
            Debug.Log($"[Design] gallery at {ScenePath}");
        }

        [MenuItem("IsItDoneYet/Capture Design Previews")]
        public static void CaptureMenu() => Capture();

        /// <summary>Batchmode: build the gallery, render it, assemble the contact sheet.</summary>
        public static void CaptureBatch()
        {
            if (!Capture()) EditorApplication.Exit(1);
        }

        static Scene Build()
        {
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var tokens = AssetDatabase.LoadAssetAtPath<DesignTokens>("Assets/IsItDoneYet/Design/Resources/DesignTokens.asset");
            if (tokens == null)
            {
                Debug.LogError("[Design] no DesignTokens asset -- import the tokens first");
                return scene;
            }

            var themeHost = new GameObject("ThemeManager");
            var theme = themeHost.AddComponent<ThemeManager>();
            theme.EditorBind(tokens, ThemeName.Normal);

            var cameraHost = new GameObject("Camera");
            var camera = cameraHost.AddComponent<Camera>();
            camera.clearFlags = CameraClearFlags.SolidColor;
            // The reference's own dark backdrop, so a capture sits against what the design was
            // drawn against rather than against Unity's default blue.
            camera.backgroundColor = Core.Srgb.ForShader(tokens.Palette(ThemeName.Normal).Get(ColorRole.Background));
            camera.orthographic = true;
            camera.orthographicSize = 0.46f;
            camera.transform.position = new Vector3(0f, 0f, -1f);
            camera.nearClipPlane = 0.01f;

            BuildRow(0.40f, "GlassPanel", new[] { "flat", "chip", "card", "panel", "hero" }, level =>
            {
                var root = new GameObject($"Panel-{level}");
                var panel = NewPanel("Panel", root.transform);
                panel.SizeM = new Vector2(0.11f, 0.07f);
                panel.ShadowLevel = level;
                panel.Refresh();

                Caption(root.transform, level.ToUpperInvariant(), -0.055f);
                return root;
            });

            BuildRow(0.24f, "PillButton", new[] { "Normal", "Hover", "Pressed", "Focused", "Disabled" }, state =>
            {
                var root = new GameObject($"Button-{state}");
                var panel = NewPanel("Panel", root.transform);
                panel.SizeM = new Vector2(0.105f, 0.038f);
                panel.RadiusPx = 999f;
                Caption(root.transform, state.ToUpperInvariant(), -0.038f);

                var button = root.AddComponent<PillButton>();
                button.SetInteractable(state != "Disabled");
                if (state == "Hover") button.SetHover(true);
                if (state == "Focused") button.SetFocused(true);
                if (state == "Pressed") { button.SetHover(true); button.SetPressed(true); }
                return root;
            });

            BuildRow(0.09f, "Chip", new[] { "Neutral", "Success", "Warning", "Danger", "Info", "Spice", "Accent" }, tone =>
            {
                var root = new GameObject($"Chip-{tone}");
                NewPanel("Panel", root.transform);
                NewLabel("Label", root.transform, tone.ToUpperInvariant(), "labelTight");
                var chip = root.AddComponent<Chip>();
                chip.Set(tone.ToUpperInvariant(), (Chip.ChipTone)System.Enum.Parse(typeof(Chip.ChipTone), tone));
                return root;
            });

            BuildRow(-0.06f, "ArcGauge", new[] { "timer", "combo", "heat-sure", "heat-unsure", "empty" }, kind =>
            {
                var root = new GameObject($"Gauge-{kind}");
                var host = new GameObject("Arc", typeof(MeshFilter), typeof(MeshRenderer), typeof(ArcGauge));
                host.transform.SetParent(root.transform, false);
                var gauge = host.GetComponent<ArcGauge>();
                gauge.DiameterM = 0.085f;
                switch (kind)
                {
                    case "timer": gauge.SetProgress(0.62f, true); gauge.ZoneStart = 0.4f; gauge.ZoneEnd = 1f; break;
                    case "combo": gauge.Segments = 4; gauge.SetProgress(0.75f, true); break;
                    case "heat-sure": gauge.SetProgress(0.55f, true); gauge.Uncertainty = 0.04f; break;
                    // The one that carries the argument: the same value, less certain.
                    case "heat-unsure": gauge.SetProgress(0.55f, true); gauge.Uncertainty = 0.22f; break;
                    default: gauge.SetProgress(0f, true); break;
                }
                gauge.Refresh();
                Caption(root.transform, kind.ToUpperInvariant(), -0.058f);
                return root;
            });

            BuildRow(-0.22f, "StatusMarks", new[] { "status-ok", "status-warn", "status-bad", "status-unsure", "camera-active" }, icon =>
            {
                var root = new GameObject($"Icon-{icon}");
                var panel = NewPanel("Panel", root.transform);
                panel.SizeM = new Vector2(0.07f, 0.07f);
                panel.Fill = ColorRole.Surface;
                panel.RadiusPx = 18f;
                panel.ShadowLevel = "chip";
                panel.Refresh();

                var host = new GameObject($"Icon-{icon}", typeof(MeshFilter), typeof(MeshRenderer), typeof(IconQuad));
                host.transform.SetParent(root.transform, false);
                host.transform.localPosition = new Vector3(0f, 0f, -0.002f);
                var quad = host.GetComponent<IconQuad>();
                quad.IconName = icon;
                quad.SizeM = 0.05f;
                quad.Tint = ColorRole.Ink;
                quad.Tinted = icon != "camera-active";
                quad.Refresh();

                Caption(root.transform, icon.Replace("status-", string.Empty).ToUpperInvariant(), -0.052f);
                return root;
            });

            /*
             * The type row sits on a cream panel, which is how it is actually used -- the first
             * capture put dark ink on the dark backdrop and the whole row was invisible. `hero`
             * is left out deliberately: at 132 reference pixels it is four times the width of
             * a cell, and a clipped sample of a display face tells you nothing about it.
             */
            BuildRow(-0.37f, "Type", new[] { "screenTitle", "panelTitle", "statValue", "body", "label" }, role =>
            {
                var root = new GameObject($"Type-{role}");
                var panel = NewPanel("Panel", root.transform);
                panel.SizeM = new Vector2(0.125f, 0.055f);
                panel.Fill = ColorRole.Surface;
                panel.ShadowLevel = "chip";
                panel.Refresh();

                var label = NewLabel("Label", root.transform, role, role);
                label.SizeM = new Vector2(0.13f, 0.055f);
                label.OnFill = ColorRole.Surface;
                label.transform.localPosition = new Vector3(0f, 0f, -0.002f);
                label.Refresh();
                return root;
            });

            return scene;
        }

        static void BuildRow(float y, string rowName, IReadOnlyList<string> variants, System.Func<string, GameObject> make)
        {
            var row = new GameObject(rowName);
            row.transform.position = new Vector3(0f, y, 0f);

            var spacing = 0.135f;
            var start = -(variants.Count - 1) * spacing * 0.5f;
            for (var i = 0; i < variants.Count; i++)
            {
                var item = make(variants[i]);
                item.transform.SetParent(row.transform, false);
                item.transform.localPosition = new Vector3(start + i * spacing, 0f, 0f);
            }
        }

        /// <summary>
        /// A caption BELOW the sample, on the dark ground, in the on-dark text colour.
        ///
        /// Below rather than inside, because a caption inside the sample is part of the sample
        /// and changes what is being shown. On the dark ground it needs the on-dark colour --
        /// the first capture put ink-coloured captions on a near-black backdrop and none of
        /// them were visible.
        ///
        /// The rect is deliberately generous. TextMeshPro truncates rather than overflowing,
        /// and because every label here is floored to Meta's 24 dmm minimum, a rect sized from
        /// the reference's 11px chip label is too short and the text vanishes entirely.
        /// </summary>
        static void Caption(Transform parent, string text, float y)
        {
            var label = NewLabel("Caption", parent, text, "labelTight");
            label.SizeM = new Vector2(0.135f, 0.05f);
            label.Color = ColorRole.TextOnDarkMuted;
            label.OnFill = ColorRole.Background;
            label.Alignment = TextAlignmentOptions.Top;
            label.transform.localPosition = new Vector3(0f, y, -0.002f);
            label.Refresh();
        }

        static GlassPanel NewPanel(string name, Transform parent = null)
        {
            var host = new GameObject(name, typeof(MeshFilter), typeof(MeshRenderer), typeof(GlassPanel));
            if (parent != null) host.transform.SetParent(parent, false);
            return host.GetComponent<GlassPanel>();
        }

        static Label NewLabel(string name, Transform parent, string text, string role)
        {
            var host = new GameObject(name, typeof(TextMeshPro), typeof(Label));
            if (parent != null) host.transform.SetParent(parent, false);
            var label = host.GetComponent<Label>();
            label.Text = text;
            label.TypeRole = role;
            label.Alignment = TextAlignmentOptions.Center;
            label.SizeM = new Vector2(0.12f, 0.04f);
            label.Refresh();
            return label;
        }

        /// <summary>
        /// Renders the gallery once per theme, then stacks the three into a contact sheet.
        ///
        /// Three themes in one image on purpose: the SAFE and PRACTICE palettes are derived,
        /// and a derivation is only checkable side by side with what it was derived from.
        /// </summary>
        public static bool Capture()
        {
            // The gallery's scene is built, rendered and discarded, so the materials TMP
            // instantiates for an outline go with it. Without this the previews would show
            // text with no outline -- the one treatment that keeps it readable over passthrough.
            Label.ForceOutlineInEditor = true;
            var scene = Build();
            var camera = Object.FindAnyObjectByType<Camera>();
            var theme = Object.FindAnyObjectByType<ThemeManager>();
            if (camera == null || theme == null)
            {
                Debug.LogError("[Design] gallery did not build");
                return false;
            }

            var outputDir = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "..", PreviewDir));
            Directory.CreateDirectory(outputDir);

            const int width = 1600;
            const int height = 900;
            var shots = new List<Texture2D>();

            foreach (ThemeName name in System.Enum.GetValues(typeof(ThemeName)))
            {
                theme.EditorBind(theme.Tokens, name);
                foreach (var panel in Object.FindObjectsByType<GlassPanel>()) panel.Refresh();
                foreach (var label in Object.FindObjectsByType<Label>()) label.Refresh();
                foreach (var gauge in Object.FindObjectsByType<ArcGauge>()) gauge.Refresh();
                foreach (var icon in Object.FindObjectsByType<IconQuad>()) icon.Refresh();

                camera.backgroundColor = Core.Srgb.ForShader(theme.Color(ColorRole.Background));

                var shot = Render(camera, width, height);
                shots.Add(shot);
                File.WriteAllBytes(Path.Combine(outputDir, $"gallery-{name.ToString().ToLowerInvariant()}.png"), shot.EncodeToPNG());
                Debug.Log($"[Design] captured {name}");
            }

            var sheet = Stack(shots, width, height);
            File.WriteAllBytes(Path.Combine(outputDir, "contact-sheet.png"), sheet.EncodeToPNG());
            Object.DestroyImmediate(sheet);
            foreach (var shot in shots) Object.DestroyImmediate(shot);

            Label.ForceOutlineInEditor = false;
            Debug.Log($"[Design] previews written to {PreviewDir}");
            return true;
        }

        static Texture2D Render(Camera camera, int width, int height)
        {
            // 24-bit depth and 4x MSAA: the SDF edges in the panel shader alias badly without
            // it, and a capture used to judge edge quality must not add its own.
            var target = RenderTexture.GetTemporary(width, height, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.Default, 4);
            var previous = camera.targetTexture;
            var previousActive = RenderTexture.active;

            camera.targetTexture = target;
            camera.Render();

            RenderTexture.active = target;
            var texture = new Texture2D(width, height, TextureFormat.RGBA32, false);
            texture.ReadPixels(new Rect(0, 0, width, height), 0, 0);
            texture.Apply();

            camera.targetTexture = previous;
            RenderTexture.active = previousActive;
            RenderTexture.ReleaseTemporary(target);
            return texture;
        }

        static Texture2D Stack(List<Texture2D> shots, int width, int height)
        {
            var sheet = new Texture2D(width, height * shots.Count, TextureFormat.RGBA32, false);
            for (var i = 0; i < shots.Count; i++)
            {
                // Bottom-up, because texture origin is bottom-left -- so the first theme ends
                // up at the TOP of the saved image, which is the order a reader expects.
                sheet.SetPixels(0, (shots.Count - 1 - i) * height, width, height, shots[i].GetPixels());
            }
            sheet.Apply();
            return sheet;
        }
    }
}
