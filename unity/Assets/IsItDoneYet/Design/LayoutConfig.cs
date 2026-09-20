using IsItDoneYet.Core;
using UnityEngine;

namespace IsItDoneYet.Design
{
    /// <summary>
    /// Where everything goes, in angles and metres, in one asset.
    ///
    /// One file on purpose. Spatial placement is the thing that gets tuned in the headset, at
    /// the venue, twenty minutes before a demo -- and a layout constant that lives next to the
    /// component that uses it is a constant nobody can find when the cook says "the score is
    /// behind my head". Every number here is on a slider.
    ///
    /// Angles are relative to the eye line: positive pitch is up, negative yaw is to the left.
    /// </summary>
    [CreateAssetMenu(menuName = "IsItDoneYet/Layout Config", fileName = "LayoutConfig")]
    public class LayoutConfig : ScriptableObject
    {
        [Header("Title")]
        [Tooltip("Above the eye line so it never sits between the cook and the board.")]
        public float TitlePitchDeg = 15f;
        public float TitleYawDeg = 0f;
        public float TitleDistanceM = 1.4f;

        [Header("Score")]
        [Tooltip("Top right, on an arc. Far enough out to be glanceable, near enough to read.")]
        public float ScoreYawDeg = 24f;
        public float ScorePitchDeg = 12f;
        public float ScoreDistanceM = 1.3f;

        [Header("Coach toasts")]
        [Tooltip("Below the eye line. The one thing that follows the head.")]
        public float ToastPitchDeg = -12f;
        public float ToastYawDeg = 0f;
        public float ToastDistanceM = 1.1f;
        [Tooltip("Head motion smaller than this moves nothing. Without it a toast jitters constantly.")]
        public float ToastDeadZoneDeg = 8f;
        [Tooltip("Fraction of the remaining error closed per second.")]
        public float ToastFollowSmoothing = 4f;
        public float ToastSpacingM = 0.09f;
        [Tooltip("Past this the oldest is dismissed. A wall of toasts is a wall nobody reads.")]
        public int ToastMaxStack = 3;
        public float ToastDismissSeconds = 6f;

        [Header("Side menu")]
        public float MenuCentreYawDeg = -52f;
        public float MenuRadiusM = 0.9f;
        public float MenuArcDeg = 34f;
        public float MenuItemHeightM = 0.085f;

        [Header("Grabbable panels")]
        public float PanelDistanceM = 0.8f;
        public float PanelMinDistanceM = 0.6f;
        public float PanelMaxDistanceM = 1.0f;
        public float RecipeBookYawDeg = 0f;
        public float RecipeBookPitchDeg = -4f;
        public float ChecklistYawDeg = 38f;
        public float ChecklistPitchDeg = -6f;
        public float TimelineYawDeg = 0f;
        public float TimelinePitchDeg = -18f;

        [Header("Leaderboard")]
        [Tooltip("Placed on a real wall via MRUK. These are the fallback when no wall is found.")]
        public float LeaderboardYawDeg = -14f;
        public float LeaderboardPitchDeg = 4f;
        public float LeaderboardDistanceM = 2.2f;

        [Header("Safe mode")]
        [Tooltip("The HUD collapses to one pill here. Small, calm, out of the way of the hands.")]
        public float SafePillPitchDeg = -8f;
        public float SafePillYawDeg = 0f;
        public float SafePillDistanceM = 1.0f;

        [Header("Comfort")]
        [Tooltip("Meta's documented comfortable field of view for primary content.")]
        public float ComfortFovDeg = 41f;
        [Tooltip("Meta's minimum body text size. Nothing may be set smaller.")]
        public float MinBodyTextDmm = 24f;
        public float MinTouchTargetDmm = 64f;

        /// <summary>
        /// The world pose for a named anchor. One switch rather than a component per element,
        /// so a reader can see the whole layout at once.
        /// </summary>
        public void Pose(LayoutAnchor anchor, Vector3 headPosition, Quaternion headRotation, out Vector3 position, out Quaternion rotation)
        {
            float yaw, pitch, distance;
            switch (anchor)
            {
                case LayoutAnchor.Title:       yaw = TitleYawDeg;       pitch = TitlePitchDeg;       distance = TitleDistanceM; break;
                case LayoutAnchor.Score:       yaw = ScoreYawDeg;       pitch = ScorePitchDeg;       distance = ScoreDistanceM; break;
                case LayoutAnchor.Toast:       yaw = ToastYawDeg;       pitch = ToastPitchDeg;       distance = ToastDistanceM; break;
                case LayoutAnchor.RecipeBook:  yaw = RecipeBookYawDeg;  pitch = RecipeBookPitchDeg;  distance = PanelDistanceM; break;
                case LayoutAnchor.Checklist:   yaw = ChecklistYawDeg;   pitch = ChecklistPitchDeg;   distance = PanelDistanceM; break;
                case LayoutAnchor.Timeline:    yaw = TimelineYawDeg;    pitch = TimelinePitchDeg;    distance = PanelDistanceM; break;
                case LayoutAnchor.Leaderboard: yaw = LeaderboardYawDeg; pitch = LeaderboardPitchDeg; distance = LeaderboardDistanceM; break;
                case LayoutAnchor.SafePill:    yaw = SafePillYawDeg;    pitch = SafePillPitchDeg;    distance = SafePillDistanceM; break;
                default:                       yaw = 0f;                pitch = 0f;                  distance = PanelDistanceM; break;
            }

            position = AngularLayout.PlaceFromHead(headPosition, headRotation, yaw, pitch, distance);
            rotation = AngularLayout.FacingHead(position, headPosition);
        }

        /// <summary>
        /// Converts a reference pixel size into world metres at a placement distance, with the
        /// minimum-legibility floor applied.
        ///
        /// The floor is not advisory. A 10px micro-label in the reference is below Meta's 24 dmm
        /// minimum at every distance this app uses, and raising it makes some rows taller than
        /// the mock -- which is the right trade, because a label nobody can read is not a smaller
        /// label, it is a missing one.
        /// </summary>
        public float TextHeightMetres(float referencePx, float distanceM, float referencePxPerDmm = 1.6f, bool applyFloor = true)
        {
            var dmm = referencePx / Mathf.Max(referencePxPerDmm, 1e-3f);
            if (applyFloor) dmm = Mathf.Max(dmm, MinBodyTextDmm);
            return AngularLayout.DmmToMetres(dmm, distanceM);
        }
    }

    public enum LayoutAnchor
    {
        Title, Score, Toast, RecipeBook, Checklist, Timeline, Leaderboard, SafePill,
    }
}
