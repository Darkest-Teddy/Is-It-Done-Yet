using IsItDoneYet.Core;
using IsItDoneYet.Design;
using UnityEngine;

namespace IsItDoneYet.App
{
    /// <summary>
    /// Places the HUD once, and leaves it there.
    ///
    /// This is the decision that makes the difference between an app that feels like it is in
    /// the room and one that feels like a phone strapped to your face. Everything except the
    /// toast stack is world-locked: the title stays where it was put, the score stays where it
    /// was put, and the cook turns their head away from them and back to them like objects.
    ///
    /// The escape hatch is a Recenter button. A cook who walks to the fridge and comes back
    /// facing the other way needs one press, not a HUD that chased them there.
    /// </summary>
    public class HudRoot : MonoBehaviour
    {
        [Header("Wiring")]
        public LayoutConfig Layout;
        public Transform Head;

        [Header("Anchors")]
        public Transform Title;
        public Transform Score;
        public Transform SafePill;
        public Transform RecipeBook;
        public Transform Checklist;
        public Transform Timeline;
        public Transform Leaderboard;
        [Tooltip("The first screen a cook sees. Unplaced, it sits at the rig origin -- on the floor.")]
        public Transform Onboarding;
        public Transform StepRail;
        public Transform CameraIndicator;

        [Header("Placement")]
        [Tooltip("Place as soon as the head pose is real. Without this the HUD lands at the rig origin.")]
        public bool PlaceOnStart = true;

        [Tooltip("A tracked head is never this low. Below it, the pose has not initialised yet.")]
        public float MinHeadHeightM = 0.3f;

        [Tooltip("Place anyway after this long, so a pose that never looks real still gets a HUD.")]
        public float PlaceTimeoutSeconds = 6f;

        bool _placed;
        float _waiting;

        void LateUpdate()
        {
            if (_placed || !PlaceOnStart || Head == null || Layout == null) return;

            _waiting += Time.unscaledDeltaTime;
            if (!PoseLooksReal(Head.position, MinHeadHeightM) && _waiting < PlaceTimeoutSeconds) return;

            Recenter();
        }

        /// <summary>
        /// Is this a pose a tracked head could actually be in?
        ///
        /// Height is the only reliable signal. Before tracking initialises, OVR reports the rig
        /// origin -- and a cook standing exactly on that origin has an x and z of nearly zero
        /// too, so "is the position non-zero" cannot tell the two apart. What it cannot be is
        /// low: a head on the floor is not a head.
        ///
        /// This was a real failure and it looked like the app had not changed at all. The HUD
        /// placed against a head at (0,0,0), which put the title at shin height and the
        /// onboarding card slightly BELOW the floor, while the scene's original text kept
        /// rendering where it always had.
        /// </summary>
        public static bool PoseLooksReal(Vector3 headPosition, float minHeightM) =>
            headPosition.y > minHeightM;

        /// <summary>Puts every anchor back in front of the cook, from where they are standing now.</summary>
        /// <summary>True once the HUD has been positioned against a real head pose.</summary>
        public bool Placed => _placed;

        public void Recenter()
        {
            if (Layout == null || Head == null) return;
            _placed = true;

            Place(Title, LayoutAnchor.Title);
            Place(Score, LayoutAnchor.Score);
            Place(SafePill, LayoutAnchor.SafePill);
            Place(RecipeBook, LayoutAnchor.RecipeBook);
            Place(Checklist, LayoutAnchor.Checklist);
            Place(Timeline, LayoutAnchor.Timeline);
            Place(Leaderboard, LayoutAnchor.Leaderboard);

            /*
             * These three were missing, and Onboarding is the one that mattered: unplaced, it
             * kept its authored local position under a root sitting at the rig's world origin,
             * which is the FLOOR. The first screen of the app was face-down at the cook's feet
             * while the HUD title floated correctly in front of them -- so the app looked like
             * it had not changed at all.
             */
            Place(Onboarding, LayoutAnchor.Onboarding);
            Place(StepRail, LayoutAnchor.StepRail);
            Place(CameraIndicator, LayoutAnchor.CameraIndicator);
        }

        void Place(Transform target, LayoutAnchor anchor)
        {
            if (target == null) return;
            Layout.Pose(anchor, Head.position, Head.rotation, out var position, out var rotation);
            target.SetPositionAndRotation(position, rotation);
        }

        /// <summary>
        /// Is everything still somewhere the cook could read it?
        ///
        /// Reported by the dev stats overlay rather than acted on. A HUD that silently
        /// repositioned itself when it drifted would be a HUD that moves for reasons the cook
        /// cannot see, which is worse than one that is briefly in the wrong place.
        /// </summary>
        public bool AnchorsWithinComfort()
        {
            if (Layout == null || Head == null) return true;
            return Within(Title) && Within(Score);
        }

        bool Within(Transform target) =>
            target == null || AngularLayout.WithinComfortFov(target.position, Head.position, Head.rotation, Layout.ComfortFovDeg);
    }
}
