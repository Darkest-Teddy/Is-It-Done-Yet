using System.Collections;
using IsItDoneYet.Audio;
using IsItDoneYet.Design;
using UnityEngine;

namespace IsItDoneYet.App
{
    /// <summary>
    /// Starts the app. Nothing else did.
    ///
    /// Every piece of this application existed and none of it ran: no code called
    /// <see cref="FrameUploader.SetSource"/>, so no frame was ever captured, and no code called
    /// <see cref="RunController.Begin"/>, so no run ever started. The components were all
    /// correct and all inert. This is the glue, and it is deliberately only glue -- it owns no
    /// state, makes no decisions the other components already make, and duplicates nothing.
    ///
    /// Three jobs:
    ///  1. Pick a frame source for the platform actually being run on.
    ///  2. Carry the stored consent into the uploader at startup, since onboarding only runs once.
    ///  3. Turn controller input into the two calls the app needs: pick a recipe, advance a step.
    /// </summary>
    [DefaultExecutionOrder(100)]
    public class AppBootstrap : MonoBehaviour
    {
        [Header("Systems")]
        public ApiClient Api;
        public FrameUploader Uploader;
        public RunController Run;
        public RecipeBook Book;
        public ChecklistPanel Checklist;
        public LeaderboardPanel Leaderboard;
        public OnboardingFlow Onboarding;
        public HudRoot Hud;

        [Header("Frame sources")]
        [Tooltip("Used on the headset. Needs both camera permissions or every frame is black.")]
        public PassthroughFrameSource DeviceSource;
        [Tooltip("Used in the Editor and the simulator, which have no passthrough cameras.")]
        public ImageFolderFrameSource EditorSource;

        [Header("Input")]
        [Tooltip("Hold the right trigger to start the selected recipe.")]
        public bool ControllerInput = true;

        bool _runStarted;

        IEnumerator Start()
        {
            SoundManager.Instance?.ResetCooldowns();

            /*
             * The device source only exists on the headset. In the Editor there are no
             * passthrough cameras and never will be, so the folder source stands in -- which is
             * what makes the whole capture/encode/upload/vote/score path exercisable on a Mac.
             */
            IFrameSource source = null;
#if UNITY_ANDROID && !UNITY_EDITOR
            source = DeviceSource;
#else
            source = EditorSource;
#endif
            if (source != null && Uploader != null) Uploader.SetSource(source);

            /*
             * Consent is stored, and onboarding only runs on a first launch -- so without this
             * a returning cook would have granted consent once and then had a camera that never
             * turned on again. Onboarding overwrites it when it runs.
             */
            if (Uploader != null) Uploader.SetConsent(OnboardingFlow.HasConsent);

            if (Onboarding != null) Onboarding.gameObject.SetActive(OnboardingFlow.ShouldShow());

            // One frame, so the head pose is valid before the HUD is placed. Placing on the
            // first frame lands everything at the world origin, which on a Quest is wherever
            // the guardian was drawn -- usually behind the cook.
            yield return null;
            Hud?.Recenter();
        }

        void Update()
        {
            if (!ControllerInput) return;
            if (Onboarding != null && Onboarding.gameObject.activeSelf && !Onboarding.Finished) return;

            // OVRInput returns zero silently when there is no OVRManager in the scene, so this
            // does nothing rather than throwing in a scene that has not got the Camera Rig.
            if (!_runStarted)
            {
                if (OVRInput.GetDown(OVRInput.Button.PrimaryIndexTrigger)) StartSelectedRecipe();
                if (OVRInput.GetDown(OVRInput.Button.PrimaryThumbstickLeft)) Book?.Scroll(-1);
                if (OVRInput.GetDown(OVRInput.Button.PrimaryThumbstickRight)) Book?.Scroll(1);
                return;
            }

            if (OVRInput.GetDown(OVRInput.Button.One)) Run?.Advance();
            if (OVRInput.GetDown(OVRInput.Button.Two)) Hud?.Recenter();
        }

        /// <summary>Starts the selected recipe. Also the button the debug menu calls.</summary>
        public void StartSelectedRecipe(bool practice = false)
        {
            if (Run == null || Book == null || _runStarted) return;
            var recipe = Book.Selected;
            if (recipe == null) return;

            _runStarted = true;

            // The checklist is filled from the recipe the cook actually picked, rather than
            // holding a list from whatever was selected before.
            if (Checklist != null && recipe.ingredients != null)
            {
                var names = new string[recipe.ingredients.Length];
                for (var i = 0; i < names.Length; i++) names[i] = recipe.ingredients[i].name;
                Checklist.SetItems(names);
            }

            StartCoroutine(Run.Begin(recipe, practice));
        }
    }
}
