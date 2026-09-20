using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using IsItDoneYet.App;
using IsItDoneYet.Audio;
using IsItDoneYet.Design;
using NUnit.Framework;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace IsItDoneYet.Tests
{
    /// <summary>
    /// That the app is actually in the scene, and that every MonoBehaviour can be put there.
    ///
    /// These exist because both failures are invisible everywhere else. The project compiled
    /// clean, 142 tests passed and an APK built while the scene referenced none of the
    /// application -- so it ran on a headset and showed an empty room. Nothing in a headless
    /// suite looks at a scene unless it is told to.
    /// </summary>
    public class MonoBehaviourFileNameTests
    {
        /// <summary>
        /// Unity resolves a MonoBehaviour by FILE name.
        ///
        /// A MonoBehaviour declared in a file called something else compiles perfectly and
        /// cannot be attached to a GameObject: AddComponent fails and the scene stores a null
        /// script reference. Silent at compile time, silent at edit time.
        ///
        /// It was true of <c>TweenRunner</c>, which lived in Tween.cs and drives every animation
        /// in the app -- so every toast, tick and number roll would have failed at runtime.
        /// </summary>
        [Test]
        public void EveryMonoBehaviourLivesInAFileNamedAfterIt()
        {
            var offenders = new List<string>();
            var declaration = new Regex(@"public\s+(?:sealed\s+)?class\s+([A-Za-z0-9_]+)\s*:\s*MonoBehaviour");

            foreach (var path in Directory.GetFiles("Assets/IsItDoneYet", "*.cs", SearchOption.AllDirectories))
            {
                // Editor-only types are never attached to a GameObject, so the rule does not
                // apply to them.
                if (path.Replace('\\', '/').Contains("/Editor/")) continue;

                var stem = Path.GetFileNameWithoutExtension(path);
                foreach (Match match in declaration.Matches(File.ReadAllText(path)))
                {
                    var type = match.Groups[1].Value;
                    if (type != stem) offenders.Add($"{type} declared in {path}");
                }
            }

            Assert.That(offenders, Is.Empty,
                "These MonoBehaviours cannot be attached to a GameObject:\n" + string.Join("\n", offenders));
        }
    }

    public class SceneWiringTests
    {
        const string ScenePath = "Assets/Scenes/SampleScene.unity";

        static Scene _scene;

        [OneTimeSetUp]
        public void OpenScene()
        {
            _scene = EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Additive);
        }

        [OneTimeTearDown]
        public void CloseScene()
        {
            if (_scene.IsValid()) EditorSceneManager.CloseScene(_scene, true);
        }

        static T Find<T>() where T : Object
        {
            foreach (var root in _scene.GetRootGameObjects())
            {
                var found = root.GetComponentInChildren<T>(true);
                if (found != null) return found;
            }
            return null;
        }

        [Test]
        public void TheSceneStillHasTheCameraRig()
        {
            // The builder is additive and must never disturb what was already there.
            Assert.IsNotNull(GameObject.Find("CenterEyeAnchor"), "the Camera Rig building block is gone");
        }

        [TestCase(typeof(ApiClient))]
        [TestCase(typeof(FrameUploader))]
        [TestCase(typeof(RunController))]
        [TestCase(typeof(AppBootstrap))]
        [TestCase(typeof(HudRoot))]
        [TestCase(typeof(ToastStack))]
        [TestCase(typeof(ScoreHud))]
        [TestCase(typeof(StepRail))]
        [TestCase(typeof(CameraIndicator))]
        [TestCase(typeof(RecipeBook))]
        [TestCase(typeof(ChecklistPanel))]
        [TestCase(typeof(LeaderboardPanel))]
        [TestCase(typeof(ReplayPanel))]
        [TestCase(typeof(ScanCardPanel))]
        [TestCase(typeof(OnboardingFlow))]
        [TestCase(typeof(PassthroughFrameSource))]
        [TestCase(typeof(ImageFolderFrameSource))]
        [TestCase(typeof(ThemeManager))]
        [TestCase(typeof(TweenRunner))]
        [TestCase(typeof(SoundManager))]
        [TestCase(typeof(StatsOverlay))]
        [TestCase(typeof(DebugMenu))]
        public void TheSceneContainsExactlyOne(System.Type type)
        {
            var count = 0;
            foreach (var root in _scene.GetRootGameObjects())
            {
                count += root.GetComponentsInChildren(type, true).Length;
            }

            // Exactly one, not "at least one". Two ApiClients or two RunControllers is the
            // failure a builder that appends instead of rebuilding produces, and it presents as
            // the app doing everything twice.
            Assert.That(count, Is.EqualTo(1), $"{type.Name} appears {count} times in the scene");
        }

        [Test]
        public void TheBootstrapCanReachEverythingItStarts()
        {
            var boot = Find<AppBootstrap>();
            Assert.IsNotNull(boot);

            // Without these two the app is inert in exactly the way it was: no frame is ever
            // captured and no run ever begins.
            Assert.IsNotNull(boot.Uploader, "nothing would ever capture a frame");
            Assert.IsNotNull(boot.Run, "no run would ever start");
            Assert.IsNotNull(boot.Book, "no recipe could be chosen");
            Assert.IsNotNull(boot.Hud);
            Assert.IsNotNull(boot.DeviceSource, "the headset would have no frame source");
            Assert.IsNotNull(boot.EditorSource, "the Editor would have no frame source");
        }

        [Test]
        public void TheRunControllerIsFullyWired()
        {
            var run = Find<RunController>();
            Assert.IsNotNull(run);
            Assert.IsNotNull(run.Api);
            Assert.IsNotNull(run.Uploader);
            Assert.IsNotNull(run.Rail);
            Assert.IsNotNull(run.Toasts);
            Assert.IsNotNull(run.Score);
        }

        [Test]
        public void TheHudKnowsWhereTheHeadIs()
        {
            var hud = Find<HudRoot>();
            Assert.IsNotNull(hud);
            Assert.IsNotNull(hud.Layout, "no LayoutConfig -- every anchor would land at the origin");
            Assert.IsNotNull(hud.Head, "no head transform -- the HUD cannot be placed");
            Assert.AreEqual("CenterEyeAnchor", hud.Head.name);

            Assert.IsNotNull(hud.Title);
            Assert.IsNotNull(hud.Score);
            Assert.IsNotNull(hud.RecipeBook);
            Assert.IsNotNull(hud.Checklist);
            Assert.IsNotNull(hud.Leaderboard);
        }

        [Test]
        public void TheToastStackHasSomethingToClone()
        {
            var stack = Find<ToastStack>();
            Assert.IsNotNull(stack);
            Assert.IsNotNull(stack.Prototype, "no prototype -- the coach could never show a message");
            Assert.IsFalse(stack.Prototype.gameObject.activeSelf,
                "an active prototype is a permanent empty toast hanging below the eye line");
        }

        [Test]
        public void TheRecipeBookHasACardToClone()
        {
            var book = Find<RecipeBook>();
            Assert.IsNotNull(book);
            Assert.IsNotNull(book.Prototype, "no prototype -- the shelf could never show a recipe");
            Assert.IsNotNull(book.Shelf);
            Assert.IsFalse(book.Prototype.gameObject.activeSelf);
        }

        [Test]
        public void TheThemeManagerHasItsTokens()
        {
            var theme = Find<ThemeManager>();
            Assert.IsNotNull(theme);
            // Without tokens every component falls back to magenta.
            Assert.IsNotNull(theme.Tokens, "no DesignTokens -- the whole UI renders magenta");
        }

        [Test]
        public void TheOfflineRecipeBundleExistsAndParses()
        {
            // RecipeBook loads this FIRST so the shelf is never empty, not even for the second
            // before a request resolves. The file simply did not exist.
            var text = Resources.Load<TextAsset>("bundled-recipes");
            Assert.IsNotNull(text, "Resources/bundled-recipes.json is missing -- the shelf is empty offline");

            var parsed = JsonUtility.FromJson<RecipeListDto>(text.text);
            Assert.IsNotNull(parsed?.recipes);
            Assert.That(parsed.recipes.Length, Is.GreaterThan(0));

            // Every card draws its cover from these three values and never from an image.
            foreach (var recipe in parsed.recipes)
            {
                Assert.IsNotEmpty(recipe.slug);
                Assert.IsNotEmpty(recipe.title);
                Assert.IsNotNull(recipe.cover, $"{recipe.slug} has no cover tint");
                Assert.IsTrue(Core.Srgb.TryParseHex(recipe.cover.tint, out _), $"{recipe.slug} cover tint is not a colour");
            }
        }

        [Test]
        public void SomeBundledStepIsFlaggedHotOrKnife()
        {
            /*
             * SAFE mode is driven entirely by these flags, so if no bundled recipe carries one
             * the feature can never fire on a cold start -- which was true until the server's
             * step schema stopped dropping them.
             */
            var text = Resources.Load<TextAsset>("bundled-recipes");
            var parsed = JsonUtility.FromJson<RecipeListDto>(text.text);
            var flagged = parsed.recipes.SelectMany(r => r.steps).Count(s => s.hot || s.knife);
            Assert.That(flagged, Is.GreaterThan(0), "no bundled step is hot or knife -- SAFE mode could never trigger");
        }
    }
}
