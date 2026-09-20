using IsItDoneYet.Audio;
using IsItDoneYet.Design;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace IsItDoneYet.App.Editor
{
    /// <summary>
    /// Wires the app into SampleScene, from code, without touching anything already in it.
    ///
    /// Every component of this application existed and the scene referenced none of them, so the
    /// build ran and showed an empty room. This assembles the rig and fills in the serialized
    /// references.
    ///
    /// Built from code for the same reason the Design Gallery is: a hand-assembled rig drifts,
    /// and a rig with one unassigned reference fails as a NullReference on the device rather
    /// than at edit time. Re-running this is the repair.
    ///
    /// It is <b>additive and idempotent</b>. Everything it creates lives under one root; that
    /// root is deleted and rebuilt on each run, and nothing outside it is read except the Camera
    /// Rig's centre-eye anchor, which it needs for the head pose. The Camera Rig, Passthrough
    /// and hand-tracking building blocks are never modified.
    /// </summary>
    public static class SceneBuilder
    {
        const string ScenePath = "Assets/Scenes/SampleScene.unity";
        const string RootName = "[IsItDoneYet] App";
        const string LayoutPath = "Assets/IsItDoneYet/Design/Resources/LayoutConfig.asset";
        const string TokensPath = "Assets/IsItDoneYet/Design/Resources/DesignTokens.asset";

        [MenuItem("IsItDoneYet/Build App Scene")]
        public static void BuildMenu()
        {
            if (Build()) Debug.Log("[Scene] SampleScene wired");
        }

        /// <summary>Batchmode entry point.</summary>
        public static void BuildBatch()
        {
            if (!Build()) EditorApplication.Exit(1);
        }

        static bool Build()
        {
            var tokens = AssetDatabase.LoadAssetAtPath<DesignTokens>(TokensPath);
            if (tokens == null)
            {
                Debug.LogError("[Scene] no DesignTokens asset -- run IsItDoneYet/Design/Import Tokens first");
                return false;
            }

            var layout = EnsureLayoutConfig();
            var scene = EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);

            // Rebuilt, never appended to. Appending would leave a second ApiClient and a second
            // RunController in the scene, which is exactly the "duplicate systems" failure.
            var existing = GameObject.Find(RootName);
            if (existing != null) Object.DestroyImmediate(existing);

            var head = FindHead();
            if (head == null)
            {
                Debug.LogError("[Scene] no CenterEyeAnchor -- is the Camera Rig building block still in the scene?");
                return false;
            }

            /*
             * Built INACTIVE, activated at the very end.
             *
             * GlassPanel, Label, IconQuad, ArcGauge and ThemeManager are all [ExecuteAlways],
             * so their OnEnable and Awake fire the instant AddComponent runs -- on a half-built
             * object, in edit mode, before its references exist. Constructing the whole rig
             * inactive means no lifecycle callback sees a partial hierarchy.
             */
            var root = new GameObject(RootName);
            root.SetActive(false);

            // ---- systems -------------------------------------------------------------------
            var systems = Child(root.transform, "Systems");

            var theme = systems.gameObject.AddComponent<ThemeManager>();
            Wire(theme, "_tokens", tokens);

            systems.gameObject.AddComponent<TweenRunner>();
            systems.gameObject.AddComponent<SoundManager>();

            var api = systems.gameObject.AddComponent<ApiClient>();
            var uploader = systems.gameObject.AddComponent<FrameUploader>();
            uploader.Api = api;

            // Both sources are present and the bootstrap picks one by platform. The device one
            // adds PassthroughCameraAccess itself when it starts.
            var deviceSource = Child(systems, "PassthroughSource").gameObject.AddComponent<PassthroughFrameSource>();
            var editorSource = Child(systems, "EditorFrameSource").gameObject.AddComponent<ImageFolderFrameSource>();
            editorSource.PoseProxy = head;

            // ---- HUD -----------------------------------------------------------------------
            var hudGo = Child(root.transform, "HUD");
            var hud = hudGo.gameObject.AddComponent<HudRoot>();
            hud.Layout = layout;
            hud.Head = head;

            hud.Title = BuildTitle(hudGo);
            var score = BuildScore(hudGo, layout, head);
            hud.Score = score.transform;
            hud.SafePill = BuildSafePill(hudGo);

            var toasts = BuildToasts(hudGo, layout, head);
            var rail = BuildStepRail(hudGo);
            hud.StepRail = rail.transform;
            hud.CameraIndicator = BuildCameraIndicator(hudGo, uploader).transform;

            // ---- panels --------------------------------------------------------------------
            var panels = Child(root.transform, "Panels");

            var book = BuildRecipeBook(panels, api, layout);
            hud.RecipeBook = book.transform;

            var checklist = BuildChecklist(panels, api, uploader);
            hud.Checklist = checklist.transform;

            var leaderboard = BuildLeaderboard(panels, api, layout, head);
            hud.Leaderboard = leaderboard.transform;

            var timeline = BuildReplay(panels, api);
            hud.Timeline = timeline.transform;

            BuildScanCard(panels, api, uploader);

            // ---- run -----------------------------------------------------------------------
            var run = Child(root.transform, "Run").gameObject.AddComponent<RunController>();
            run.Api = api;
            run.Uploader = uploader;
            run.Rail = rail;
            run.Toasts = toasts;
            run.Score = score;

            // ---- onboarding ----------------------------------------------------------------
            var onboarding = BuildOnboarding(root.transform, uploader, deviceSource);
            hud.Onboarding = onboarding.transform;

            // ---- dev -----------------------------------------------------------------------
            var devGo = Child(root.transform, "Dev");
            var stats = BuildStats(devGo, hud, uploader);
            var debug = devGo.gameObject.AddComponent<DebugMenu>();
            debug.Run = run;
            debug.Uploader = uploader;
            debug.Stats = stats;
            debug.Layout = layout;
            debug.Hud = hud;

            // ---- bootstrap -----------------------------------------------------------------
            var boot = root.AddComponent<AppBootstrap>();
            boot.Api = api;
            boot.Uploader = uploader;
            boot.Run = run;
            boot.Book = book;
            boot.Checklist = checklist;
            boot.Leaderboard = leaderboard;
            boot.Onboarding = onboarding;
            boot.Hud = hud;
            boot.DeviceSource = deviceSource;
            boot.EditorSource = editorSource;

            root.SetActive(true);

            EditorSceneManager.MarkSceneDirty(scene);
            EditorSceneManager.SaveScene(scene, ScenePath);
            AssetDatabase.SaveAssets();
            return true;
        }

        /// <summary>
        /// The centre-eye anchor, which is the only thing this reads from the existing scene.
        ///
        /// Found by name because that is what the Camera Rig building block calls it. Reaching
        /// for <c>Camera.main</c> instead picks up whichever camera happens to be tagged, and in
        /// an XR rig that is frequently not the one tracking the head.
        /// </summary>
        static Transform FindHead()
        {
            var byName = GameObject.Find("CenterEyeAnchor");
            if (byName != null) return byName.transform;

            var rig = Object.FindAnyObjectByType<OVRCameraRig>();
            return rig != null ? rig.centerEyeAnchor : null;
        }

        /// <summary>
        /// The layout asset, created on first run with the defaults declared on LayoutConfig.
        ///
        /// Every spatial number lives there rather than next to the component that uses it,
        /// because placement is what gets tuned in a headset twenty minutes before a demo, and a
        /// constant beside its component is a constant nobody can find.
        /// </summary>
        static LayoutConfig EnsureLayoutConfig()
        {
            var layout = AssetDatabase.LoadAssetAtPath<LayoutConfig>(LayoutPath);
            if (layout != null) return layout;

            layout = ScriptableObject.CreateInstance<LayoutConfig>();
            AssetDatabase.CreateAsset(layout, LayoutPath);
            AssetDatabase.SaveAssets();
            Debug.Log($"[Scene] created {LayoutPath}");
            return layout;
        }

        // ------------------------------------------------------------------------------------
        // Builders. Each returns the component the rig has to hold on to.
        // ------------------------------------------------------------------------------------

        static Transform BuildTitle(Transform parent)
        {
            var label = NewLabel(parent, "Title", "IS IT DONE YET?", "screenTitle", ColorRole.TextOnDark);
            label.ViewDistanceM = 1.4f;
            label.SizeM = new Vector2(0.6f, 0.12f);
            label.Alignment = TextAlignmentOptions.Center;
            label.Refresh();
            return label.transform;
        }

        static ScoreHud BuildScore(Transform parent, LayoutConfig layout, Transform head)
        {
            var go = Child(parent, "Score");
            var score = go.gameObject.AddComponent<ScoreHud>();
            score.Layout = layout;
            score.Head = head;

            var counterLabel = NewLabel(go, "Counter", "0", "scoreValue", ColorRole.TextOnDark);
            counterLabel.SizeM = new Vector2(0.22f, 0.1f);
            counterLabel.Alignment = TextAlignmentOptions.Center;
            counterLabel.Refresh();
            var roll = counterLabel.gameObject.AddComponent<NumberRoll>();
            Wire(roll, "_label", counterLabel);
            score.Counter = roll;

            var combo = NewGauge(go, "Combo");
            combo.transform.localPosition = new Vector3(0f, -0.08f, 0f);
            combo.Segments = 4;
            combo.DiameterM = 0.07f;
            combo.Refresh();
            score.ComboMeter = combo;

            var dock = NewLabel(go, "DockReason", string.Empty, "caption", ColorRole.TextOnDarkMuted);
            dock.transform.localPosition = new Vector3(0f, -0.14f, 0f);
            dock.SizeM = new Vector2(0.3f, 0.05f);
            dock.Alignment = TextAlignmentOptions.Center;
            dock.Refresh();
            score.DockReason = dock;
            dock.gameObject.SetActive(false);

            score.Burst = BuildBurst(Child(go, "Burst"));
            return score;
        }

        /// <summary>
        /// The gain burst. Tiny, and capped hard.
        ///
        /// Particles on a mobile chip are a fill-rate cost, and a burst that is generous on a
        /// desktop is a dropped frame here. Twenty-four is the ceiling, and emission is entirely
        /// manual so nothing emits on its own.
        /// </summary>
        static ParticleSystem BuildBurst(Transform parent)
        {
            var system = parent.gameObject.AddComponent<ParticleSystem>();
            var main = system.main;
            main.duration = 0.6f;
            main.loop = false;
            main.playOnAwake = false;
            main.startLifetime = 0.5f;
            main.startSpeed = 0.35f;
            main.startSize = 0.008f;
            main.maxParticles = 24;
            main.simulationSpace = ParticleSystemSimulationSpace.Local;

            var emission = system.emission;
            emission.enabled = false;

            var shape = system.shape;
            shape.shapeType = ParticleSystemShapeType.Sphere;
            shape.radius = 0.02f;

            var renderer = parent.GetComponent<ParticleSystemRenderer>();
            renderer.renderMode = ParticleSystemRenderMode.Billboard;
            renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            renderer.receiveShadows = false;

            var shader = Shader.Find("IsItDoneYet/Icon");
            if (shader != null) renderer.sharedMaterial = new Material(shader) { name = "IsItDoneYet/Burst" };
            return system;
        }

        static Transform BuildSafePill(Transform parent)
        {
            var go = Child(parent, "SafePill");
            var panel = NewPanel(go, "Panel", new Vector2(0.24f, 0.07f), ColorRole.Accent2, "panel");
            panel.RadiusPx = 999f;
            panel.Refresh();

            var label = NewLabel(go, "Label", "SAFE STEP", "panelTitle", ColorRole.TextPrimary);
            label.OnFill = ColorRole.Accent2;
            label.SizeM = new Vector2(0.24f, 0.06f);
            label.Alignment = TextAlignmentOptions.Center;
            label.transform.localPosition = new Vector3(0f, 0f, -0.002f);
            label.Refresh();

            go.gameObject.SetActive(false);
            return go;
        }

        static ToastStack BuildToasts(Transform parent, LayoutConfig layout, Transform head)
        {
            var go = Child(parent, "Toasts");
            var stack = go.gameObject.AddComponent<ToastStack>();
            stack.Layout = layout;
            stack.Head = head;
            stack.Prototype = BuildToastPrototype(go);
            return stack;
        }

        /// <summary>
        /// The toast the stack clones.
        ///
        /// Left INACTIVE, so the prototype itself never renders. An active prototype is a
        /// permanent empty toast hanging below the cook's eye line for the whole session.
        /// </summary>
        static Toast BuildToastPrototype(Transform parent)
        {
            var go = Child(parent, "ToastPrototype");
            var toast = go.gameObject.AddComponent<Toast>();

            var panel = NewPanel(go, "Panel", new Vector2(0.34f, 0.09f), ColorRole.Surface, "card");
            panel.RadiusPx = 22f;
            panel.Refresh();

            var glyph = NewIcon(go, "Glyph", "status-unsure", 0.03f);
            glyph.transform.localPosition = new Vector3(-0.13f, 0f, -0.002f);

            var message = NewLabel(go, "Message", "...", "body", ColorRole.TextPrimary);
            message.SizeM = new Vector2(0.24f, 0.06f);
            message.Alignment = TextAlignmentOptions.Left;
            message.transform.localPosition = new Vector3(0.01f, 0.005f, -0.002f);
            message.Refresh();

            var pipRoot = Child(go, "Pips");
            pipRoot.localPosition = new Vector3(-0.1f, -0.03f, -0.002f);

            Wire(toast, "_panel", panel);
            Wire(toast, "_message", message);
            Wire(toast, "_glyph", glyph);
            Wire(toast, "_pipRoot", pipRoot);

            go.gameObject.SetActive(false);
            return toast;
        }

        static StepRail BuildStepRail(Transform parent)
        {
            var go = Child(parent, "StepRail");
            go.localPosition = new Vector3(-0.28f, 0f, 0.9f);
            var rail = go.gameObject.AddComponent<StepRail>();

            var timer = NewGauge(go, "Timer");
            timer.DiameterM = 0.075f;
            timer.transform.localPosition = new Vector3(0f, 0.12f, 0f);
            timer.Refresh();

            Wire(rail, "_timer", timer);
            Wire(rail, "_rowRoot", Child(go, "Rows"));
            return rail;
        }

        static CameraIndicator BuildCameraIndicator(Transform parent, FrameUploader uploader)
        {
            var go = Child(parent, "CameraIndicator");
            go.localPosition = new Vector3(0.26f, 0.2f, 1.2f);
            var indicator = go.gameObject.AddComponent<CameraIndicator>();
            indicator.Uploader = uploader;
            indicator.Glyph = NewIcon(go, "Glyph", "camera-active", 0.028f);
            indicator.Glyph.Tinted = false;
            indicator.Glyph.Refresh();
            return indicator;
        }

        static RecipeBook BuildRecipeBook(Transform parent, ApiClient api, LayoutConfig layout)
        {
            var go = Child(parent, "RecipeBook");
            var book = go.gameObject.AddComponent<RecipeBook>();
            book.Api = api;
            book.Layout = layout;
            book.Shelf = Child(go, "Shelf");
            book.Prototype = BuildCardPrototype(go);
            return book;
        }

        static Card BuildCardPrototype(Transform parent)
        {
            var go = Child(parent, "CardPrototype");
            var card = go.gameObject.AddComponent<Card>();

            var panel = NewPanel(go, "Panel", new Vector2(0.17f, 0.22f), ColorRole.Surface, "card");
            panel.RadiusPx = 24f;
            panel.Refresh();

            var artWell = NewPanel(go, "ArtWell", new Vector2(0.14f, 0.085f), ColorRole.Warning, "flat");
            artWell.RadiusPx = 18f;
            artWell.Refresh();

            var icon = NewIcon(go, "Icon", "patty", 0.06f);
            icon.Tinted = false;
            icon.transform.localPosition = new Vector3(0f, 0.055f, -0.003f);
            icon.Refresh();

            var title = NewLabel(go, "Title", "Recipe", "displaySm", ColorRole.TextPrimary);
            title.SizeM = new Vector2(0.15f, 0.045f);
            title.transform.localPosition = new Vector3(0f, -0.02f, -0.002f);
            title.Refresh();

            var footnote = NewLabel(go, "Footnote", string.Empty, "labelTight", ColorRole.TextMuted);
            footnote.SizeM = new Vector2(0.15f, 0.03f);
            footnote.transform.localPosition = new Vector3(0f, -0.09f, -0.002f);
            footnote.Refresh();

            var chipA = BuildChip(Child(go, "ChipA"), new Vector3(-0.035f, -0.06f, -0.002f));
            var chipB = BuildChip(Child(go, "ChipB"), new Vector3(0.035f, -0.06f, -0.002f));

            Wire(card, "_panel", panel);
            Wire(card, "_artWell", artWell);
            Wire(card, "_icon", icon);
            Wire(card, "_title", title);
            Wire(card, "_footnote", footnote);
            Wire(card, "_chipA", chipA);
            Wire(card, "_chipB", chipB);

            go.gameObject.SetActive(false);
            return card;
        }

        static Chip BuildChip(Transform go, Vector3 localPosition)
        {
            go.localPosition = localPosition;
            var chip = go.gameObject.AddComponent<Chip>();
            var panel = NewPanel(go, "Panel", new Vector2(0.06f, 0.022f), ColorRole.Info, "chip");
            var label = NewLabel(go, "Label", "CHIP", "labelTight", ColorRole.InfoInk);
            label.transform.localPosition = new Vector3(0f, 0f, -0.002f);

            // Wired explicitly rather than left to Chip's own GetComponentInChildren fallback.
            // The fallback works, but it takes the FIRST match in the hierarchy -- which is only
            // the right one for as long as nobody nests another panel inside a chip.
            Wire(chip, "_panel", panel);
            Wire(chip, "_label", label);
            return chip;
        }

        static ChecklistPanel BuildChecklist(Transform parent, ApiClient api, FrameUploader uploader)
        {
            var go = Child(parent, "Checklist");

            var panel = NewPanel(go, "Panel", new Vector2(0.36f, 0.3f), ColorRole.Surface, "panel");
            panel.RadiusPx = 26f;
            panel.Refresh();

            var title = NewLabel(go, "Title", "ON YOUR COUNTER", "panelTitle", ColorRole.TextPrimary);
            title.SizeM = new Vector2(0.32f, 0.05f);
            title.transform.localPosition = new Vector3(0f, 0.12f, -0.002f);
            title.Refresh();

            var checklist = go.gameObject.AddComponent<ChecklistPanel>();
            checklist.Api = api;
            checklist.Uploader = uploader;
            var rows = Child(go, "Rows");
            rows.localPosition = new Vector3(0f, 0.07f, -0.002f);
            checklist.RowRoot = rows;
            return checklist;
        }

        static LeaderboardPanel BuildLeaderboard(Transform parent, ApiClient api, LayoutConfig layout, Transform head)
        {
            var go = Child(parent, "Leaderboard");
            var board = go.gameObject.AddComponent<LeaderboardPanel>();
            board.Api = api;
            board.Layout = layout;
            board.Head = head;

            board.Panel = NewPanel(go, "Panel", new Vector2(0.5f, 0.42f), ColorRole.Surface, "panel");
            board.Panel.RadiusPx = 26f;
            board.Panel.Refresh();

            board.Title = NewLabel(go, "Title", "LEADERBOARD", "panelTitle", ColorRole.TextPrimary);
            board.Title.SizeM = new Vector2(0.44f, 0.06f);
            board.Title.transform.localPosition = new Vector3(0f, 0.17f, -0.002f);
            board.Title.Refresh();

            var rows = Child(go, "Rows");
            rows.localPosition = new Vector3(0f, 0.1f, -0.002f);
            board.RowRoot = rows;

            var podium = Child(go, "Podium");
            podium.localPosition = new Vector3(0f, -0.17f, -0.002f);
            board.PodiumRoot = podium;
            return board;
        }

        static ReplayPanel BuildReplay(Transform parent, ApiClient api)
        {
            var go = Child(parent, "Replay");
            var replay = go.gameObject.AddComponent<ReplayPanel>();
            replay.Api = api;

            replay.Track = NewPanel(go, "Track", new Vector2(0.42f, 0.012f), ColorRole.SurfaceSunken, "flat");
            replay.Playhead = NewPanel(go, "Playhead", new Vector2(0.008f, 0.03f), ColorRole.Accent, "chip");

            replay.Thumbnail = NewIcon(go, "Thumbnail", "patty", 0.12f);
            replay.Thumbnail.Tinted = false;
            replay.Thumbnail.transform.localPosition = new Vector3(0f, 0.09f, -0.002f);
            replay.Thumbnail.Refresh();

            replay.Caption = NewLabel(go, "Caption", "0:00", "caption", ColorRole.TextOnDarkMuted);
            replay.Caption.transform.localPosition = new Vector3(0f, -0.04f, -0.002f);
            replay.Caption.Refresh();

            replay.MarkerRoot = Child(go, "Markers");

            go.gameObject.SetActive(false);
            return replay;
        }

        static ScanCardPanel BuildScanCard(Transform parent, ApiClient api, FrameUploader uploader)
        {
            var go = Child(parent, "ScanCard");
            var scan = go.gameObject.AddComponent<ScanCardPanel>();
            scan.Api = api;
            scan.Uploader = uploader;
            scan.Viewfinder = NewPanel(go, "Viewfinder", new Vector2(0.26f, 0.18f), ColorRole.Surface, "flat");
            scan.SweepBar = NewPanel(go, "Sweep", new Vector2(0.26f, 0.004f), ColorRole.Accent, "flat");

            scan.Status = NewLabel(go, "Status", string.Empty, "caption", ColorRole.TextOnDark);
            scan.Status.transform.localPosition = new Vector3(0f, -0.12f, -0.002f);
            scan.Status.Refresh();

            scan.Preview = NewLabel(go, "Preview", string.Empty, "caption", ColorRole.TextPrimary);
            scan.Preview.SizeM = new Vector2(0.24f, 0.14f);
            scan.Preview.Refresh();

            go.gameObject.SetActive(false);
            return scan;
        }

        static OnboardingFlow BuildOnboarding(Transform parent, FrameUploader uploader, PassthroughFrameSource deviceSource)
        {
            var go = Child(parent, "Onboarding");
            go.localPosition = new Vector3(0f, 0f, 1.1f);
            var flow = go.gameObject.AddComponent<OnboardingFlow>();
            flow.Uploader = uploader;
            flow.DeviceSource = deviceSource;

            flow.Panel = NewPanel(go, "Panel", new Vector2(0.52f, 0.34f), ColorRole.Surface, "hero");
            flow.Panel.RadiusPx = 34f;
            flow.Panel.Refresh();

            flow.TitleLabel = NewLabel(go, "Title", "Is it done yet?", "panelTitle", ColorRole.TextPrimary);
            flow.TitleLabel.SizeM = new Vector2(0.44f, 0.06f);
            flow.TitleLabel.transform.localPosition = new Vector3(0f, 0.1f, -0.002f);
            flow.TitleLabel.Refresh();

            flow.BodyLabel = NewLabel(go, "Body", string.Empty, "body", ColorRole.TextBody);
            flow.BodyLabel.SizeM = new Vector2(0.44f, 0.14f);
            flow.BodyLabel.Alignment = TextAlignmentOptions.TopLeft;
            flow.BodyLabel.transform.localPosition = new Vector3(0f, 0.01f, -0.002f);
            flow.BodyLabel.Refresh();

            flow.Icon = NewIcon(go, "Icon", "patty", 0.05f);
            flow.Icon.Tinted = false;
            flow.Icon.transform.localPosition = new Vector3(-0.2f, 0.11f, -0.003f);
            flow.Icon.Refresh();

            flow.NextButton = BuildButton(Child(go, "Next"), "CONTINUE", new Vector3(0.14f, -0.12f, -0.003f));
            flow.DeclineButton = BuildButton(Child(go, "Decline"), "NOT NOW", new Vector3(-0.06f, -0.12f, -0.003f));
            return flow;
        }

        static PillButton BuildButton(Transform go, string text, Vector3 localPosition)
        {
            go.localPosition = localPosition;
            var button = go.gameObject.AddComponent<PillButton>();

            var panel = NewPanel(go, "Panel", new Vector2(0.11f, 0.04f), ColorRole.Surface, "card");
            panel.RadiusPx = 999f;
            panel.Refresh();

            var label = NewLabel(go, "Label", text, "labelTight", ColorRole.TextPrimary);
            label.SizeM = new Vector2(0.12f, 0.04f);
            label.Alignment = TextAlignmentOptions.Center;
            label.transform.localPosition = new Vector3(0f, 0f, -0.002f);
            label.Refresh();

            Wire(button, "_panel", panel);
            Wire(button, "_label", label);
            return button;
        }

        static StatsOverlay BuildStats(Transform parent, HudRoot hud, FrameUploader uploader)
        {
            var go = Child(parent, "Stats", typeof(TextMeshPro), typeof(StatsOverlay));
            go.localPosition = new Vector3(-0.3f, 0.25f, 1f);
            var text = go.GetComponent<TextMeshPro>();
            text.fontSize = 0.16f;
            text.color = Color.white;
            text.rectTransform.sizeDelta = new Vector2(0.4f, 0.2f);

            var stats = go.GetComponent<StatsOverlay>();
            Wire(stats, "_text", text);
            Wire(stats, "_hud", hud);
            Wire(stats, "_uploader", uploader);
            go.gameObject.SetActive(false);
            return stats;
        }

        // ------------------------------------------------------------------------------------

        /// <summary>
        /// A child GameObject, with its components supplied to the CONSTRUCTOR.
        ///
        /// Not `new GameObject(name)` followed by `AddComponent`. Adding TextMeshPro to a bare
        /// GameObject during an edit-mode batch destroys the object out from under the builder --
        /// the next line gets a MissingReferenceException on a transform that was valid one
        /// statement earlier. Passing the types to the constructor adds them atomically and does
        /// not, which is also how the Design Gallery builds its samples.
        /// </summary>
        static Transform Child(Transform parent, string name, params System.Type[] components)
        {
            var go = new GameObject(name, components);
            go.transform.SetParent(parent, false);
            return go.transform;
        }

        static GlassPanel NewPanel(Transform parent, string name, Vector2 size, ColorRole fill, string shadow)
        {
            var go = Child(parent, name, typeof(MeshFilter), typeof(MeshRenderer), typeof(GlassPanel));
            var panel = go.GetComponent<GlassPanel>();
            panel.SizeM = size;
            panel.Fill = fill;
            panel.ShadowLevel = shadow;
            panel.Refresh();
            return panel;
        }

        static Label NewLabel(Transform parent, string name, string text, string role, ColorRole color)
        {
            var go = Child(parent, name, typeof(TextMeshPro), typeof(Label));
            var label = go.GetComponent<Label>();
            label.Text = text;
            label.TypeRole = role;
            label.Color = color;
            label.Refresh();
            return label;
        }

        static IconQuad NewIcon(Transform parent, string name, string icon, float size)
        {
            var go = Child(parent, name, typeof(MeshFilter), typeof(MeshRenderer), typeof(IconQuad));
            var quad = go.GetComponent<IconQuad>();
            quad.IconName = icon;
            quad.SizeM = size;
            quad.Refresh();
            return quad;
        }

        static ArcGauge NewGauge(Transform parent, string name)
        {
            return Child(parent, name, typeof(MeshFilter), typeof(MeshRenderer), typeof(ArcGauge))
                .GetComponent<ArcGauge>();
        }

        /// <summary>
        /// Assigns a private [SerializeField].
        ///
        /// Through SerializedObject rather than reflection, so the value is written the way the
        /// Inspector writes it and the scene records a proper reference. Setting a private field
        /// by reflection assigns the live object but never dirties the scene, so the reference is
        /// null again the next time it loads -- and that fails on the device only.
        /// </summary>
        static void Wire(Object target, string field, Object value)
        {
            var serialized = new SerializedObject(target);
            var property = serialized.FindProperty(field);
            if (property == null)
            {
                Debug.LogError($"[Scene] {target.GetType().Name} has no serialized field '{field}'");
                return;
            }
            property.objectReferenceValue = value;
            serialized.ApplyModifiedPropertiesWithoutUndo();
        }
    }
}
