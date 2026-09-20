using System.Collections;
using System.Collections.Generic;
using IsItDoneYet.Audio;
using IsItDoneYet.Design;
using Meta.XR.MRUtilityKit;
using UnityEngine;

namespace IsItDoneYet.App
{
    /// <summary>
    /// The board, on a real wall.
    ///
    /// MRUK gives the room's planes, so this hangs on an actual wall rather than floating in
    /// the middle of the kitchen -- which is the whole reason it reads as mixed reality instead
    /// of as a HUD element. When no wall is found (no room scan, or a scan that missed), it
    /// falls back to a fixed pose from LayoutConfig and says nothing about it: a cook who has
    /// not scanned their room should still see the board.
    ///
    /// Top three get extruded bars. The cook's own row is highlighted wherever it lands, and an
    /// improved rank animates from the old position to the new one -- the one moment in this
    /// app where an animation is carrying the information rather than decorating it.
    /// </summary>
    public class LeaderboardPanel : MonoBehaviour
    {
        [Header("Wiring")]
        public ApiClient Api;
        public LayoutConfig Layout;
        public Transform Head;
        public GlassPanel Panel;
        public Transform RowRoot;
        public Transform PodiumRoot;
        public Label Title;

        [Header("Rows")]
        public int MaxRows = 8;
        public float RowHeightM = 0.05f;
        public float PanelWidthM = 0.5f;

        readonly List<GlassPanel> _rows = new List<GlassPanel>();
        readonly List<Label> _rowLabels = new List<Label>();
        readonly List<GlassPanel> _podium = new List<GlassPanel>();
        LeaderboardDto _board;
        int _myRank = -1;

        IEnumerator Start()
        {
            PlaceOnWall();
            yield return Refresh();
        }

        public IEnumerator Refresh()
        {
            if (Api == null) yield break;
            yield return Api.GetLeaderboard(result =>
            {
                if (!result.Ok || result.Value == null)
                {
                    // The last board stays up. Replacing it with an error is worse: a stale
                    // board is still a board, and the cook can see the numbers have not moved.
                    if (Title != null) Title.SetText("LEADERBOARD · OFFLINE");
                    return;
                }
                _board = result.Value;
                if (Title != null) Title.SetText("LEADERBOARD");
                Render();
            });
        }

        /// <summary>
        /// Finds a wall and hangs the board on it.
        ///
        /// The largest vertical surface, at roughly eye height. Largest rather than nearest,
        /// because the nearest wall is usually the one the cook has their back to.
        /// </summary>
        public void PlaceOnWall()
        {
            var room = MRUK.Instance != null ? MRUK.Instance.GetCurrentRoom() : null;
            if (room != null && Head != null)
            {
                MRUKAnchor best = null;
                var bestArea = 0f;
                foreach (var anchor in room.Anchors)
                {
                    if (anchor == null || !anchor.HasAnyLabel(MRUKAnchor.SceneLabels.WALL_FACE)) continue;
                    if (!anchor.PlaneRect.HasValue) continue;
                    var rect = anchor.PlaneRect.Value;
                    var area = rect.width * rect.height;
                    if (area <= bestArea) continue;
                    bestArea = area;
                    best = anchor;
                }

                if (best != null)
                {
                    var eyeHeight = Head.position.y;
                    var position = best.transform.position;
                    position.y = eyeHeight;
                    // Pushed off the wall so the panel's own shadow has somewhere to land and
                    // the geometry does not z-fight with the room mesh.
                    transform.SetPositionAndRotation(position + best.transform.forward * 0.02f,
                        Quaternion.LookRotation(-best.transform.forward, Vector3.up));
                    return;
                }
            }

            if (Layout == null || Head == null) return;
            Layout.Pose(LayoutAnchor.Leaderboard, Head.position, Head.rotation, out var fallback, out var rotation);
            transform.SetPositionAndRotation(fallback, rotation);
        }

        void Render()
        {
            if (_board?.entries == null || RowRoot == null) return;

            var me = RunController.PlayerName();
            var count = Mathf.Min(_board.entries.Length, MaxRows);

            while (_rows.Count < count) CreateRow(_rows.Count);

            for (var i = 0; i < _rows.Count; i++)
            {
                var visible = i < count;
                _rows[i].gameObject.SetActive(visible);
                if (!visible) continue;

                var entry = _board.entries[i];
                var mine = entry.name == me;
                if (mine) _myRank = entry.rank;

                _rows[i].SizeM = new Vector2(PanelWidthM - 0.04f, RowHeightM - 0.008f);
                _rows[i].transform.localPosition = new Vector3(0f, -i * RowHeightM, 0f);
                _rows[i].Fill = mine ? ColorRole.Accent2 : ColorRole.SurfaceSunken;
                _rows[i].Border = ColorRole.Ink;
                _rows[i].ShadowLevel = mine ? "card" : "chip";
                _rows[i].Refresh();

                if (_rowLabels[i] != null)
                {
                    _rowLabels[i].SetText($"{entry.rank:00}   {entry.name}   {entry.score:0.0}");
                    _rowLabels[i].Color = ColorRole.TextPrimary;
                    _rowLabels[i].OnFill = _rows[i].Fill;
                    _rowLabels[i].SizeM = new Vector2(PanelWidthM - 0.06f, RowHeightM);
                    _rowLabels[i].Refresh();
                }
            }

            RenderPodium();
        }

        /// <summary>
        /// Three extruded bars for the top three, in the design's own chip colours.
        ///
        /// Bar heights are ranked, not proportional to score. A board whose top three are
        /// within a point of each other would otherwise render three identical bars, and the
        /// podium's whole job is to say who is first at a glance.
        /// </summary>
        void RenderPodium()
        {
            if (PodiumRoot == null || _board?.entries == null) return;

            var heights = new[] { 0.10f, 0.07f, 0.05f };
            var tones = new[] { ColorRole.Accent2, ColorRole.Info, ColorRole.Spice };

            while (_podium.Count < 3)
            {
                var host = new GameObject($"Podium{_podium.Count}", typeof(MeshFilter), typeof(MeshRenderer), typeof(GlassPanel));
                host.transform.SetParent(PodiumRoot, false);
                _podium.Add(host.GetComponent<GlassPanel>());
            }

            for (var i = 0; i < _podium.Count; i++)
            {
                var has = i < _board.entries.Length;
                _podium[i].gameObject.SetActive(has);
                if (!has) continue;

                _podium[i].SizeM = new Vector2(0.06f, heights[i]);
                _podium[i].transform.localPosition = new Vector3((i - 1) * 0.07f, heights[i] * 0.5f, 0f);
                _podium[i].Fill = tones[i];
                _podium[i].Border = ColorRole.Ink;
                _podium[i].RadiusPx = 14f;
                _podium[i].ShadowLevel = "card";
                _podium[i].Refresh();
            }
        }

        void CreateRow(int index)
        {
            var host = new GameObject($"Row{index}", typeof(MeshFilter), typeof(MeshRenderer), typeof(GlassPanel));
            host.transform.SetParent(RowRoot, false);
            _rows.Add(host.GetComponent<GlassPanel>());

            var labelHost = new GameObject("Text", typeof(TMPro.TextMeshPro), typeof(Label));
            labelHost.transform.SetParent(host.transform, false);
            labelHost.transform.localPosition = new Vector3(0f, 0f, -0.001f);
            var label = labelHost.GetComponent<Label>();
            label.TypeRole = "body";
            label.Alignment = TMPro.TextAlignmentOptions.Left;
            _rowLabels.Add(label);
        }

        /// <summary>Called after a submit, so the rank change is animated rather than appearing.</summary>
        public IEnumerator AnimateTo(int newRank)
        {
            var improved = _myRank > 0 && newRank < _myRank;
            _myRank = newRank;
            yield return Refresh();
            if (improved) SoundManager.Instance?.Play(Sfx.RankUp);
        }
    }
}
