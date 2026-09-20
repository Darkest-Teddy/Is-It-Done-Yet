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

        [Header("Placement")]
        [Tooltip("Place on the first frame the head pose is valid. Without this the HUD lands at the origin.")]
        public bool PlaceOnStart = true;

        bool _placed;

        void LateUpdate()
        {
            if (_placed || !PlaceOnStart || Head == null || Layout == null) return;
            // The head pose is identity for the first frame or two while tracking starts. A HUD
            // placed then lands at the world origin, which on a Quest is wherever the guardian
            // was drawn -- usually behind the cook.
            if (Head.position.sqrMagnitude < 1e-6f && Head.rotation == Quaternion.identity) return;
            Recenter();
        }

        /// <summary>Puts every anchor back in front of the cook, from where they are standing now.</summary>
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
