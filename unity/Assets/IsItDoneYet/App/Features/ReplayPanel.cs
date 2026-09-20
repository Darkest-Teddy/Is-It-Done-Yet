using System.Collections;
using System.Collections.Generic;
using IsItDoneYet.Design;
using UnityEngine;

namespace IsItDoneYet.App
{
    /// <summary>
    /// The run, afterwards: a timeline with a marker wherever points were lost, scrubbed by
    /// pinch-drag, with the thumbnail from that moment.
    ///
    /// Plays from the stored session and needs no network once it has loaded. That is the point
    /// of storing events rather than a video: the whole replay is a few hundred small records
    /// and twenty JPEGs, so it works at a booth where nothing else does.
    ///
    /// The markers are where points were LOST, not everywhere something happened. A timeline
    /// with a marker per event is a timeline nobody reads; the cook came here to find out what
    /// went wrong.
    /// </summary>
    public class ReplayPanel : MonoBehaviour
    {
        [Header("Wiring")]
        public ApiClient Api;
        public GlassPanel Track;
        public GlassPanel Playhead;
        public IconQuad Thumbnail;
        public Label Caption;
        public Transform MarkerRoot;

        [Header("Layout")]
        public float TrackWidthM = 0.42f;
        public float TrackHeightM = 0.012f;

        readonly List<GlassPanel> _markers = new List<GlassPanel>();
        readonly List<int> _markerTimes = new List<int>();
        StoredSessionDto _session;
        Texture2D _thumbTexture;
        float _scrub;

        public bool Loaded => _session != null;
        public float Scrub => _scrub;

        public IEnumerator Load(string sessionId)
        {
            if (Api == null) yield break;
            yield return Api.GetSession(sessionId, result =>
            {
                if (!result.Ok || result.Value == null)
                {
                    if (Caption != null) Caption.SetText("That replay is out of reach.");
                    return;
                }
                _session = result.Value;
                BuildMarkers();
                SetScrub(0f);
            });
        }

        void BuildMarkers()
        {
            _markerTimes.Clear();
            if (_session?.events == null) return;

            foreach (var evt in _session.events)
            {
                // Only losses. An event log has a hundred entries and three of them are why
                // the score is what it is.
                var lost = evt.points < 0f
                    || evt.status == "bad"
                    || evt.status == "warn";
                if (lost) _markerTimes.Add(evt.atMs);
            }

            while (_markers.Count < _markerTimes.Count && MarkerRoot != null)
            {
                var host = new GameObject($"Marker{_markers.Count}", typeof(MeshFilter), typeof(MeshRenderer), typeof(GlassPanel));
                host.transform.SetParent(MarkerRoot, false);
                _markers.Add(host.GetComponent<GlassPanel>());
            }

            var duration = Mathf.Max(1, _session.durationMs);
            for (var i = 0; i < _markers.Count; i++)
            {
                var visible = i < _markerTimes.Count;
                _markers[i].gameObject.SetActive(visible);
                if (!visible) continue;

                var t = Mathf.Clamp01((float)_markerTimes[i] / duration);
                _markers[i].SizeM = new Vector2(0.005f, TrackHeightM * 2.2f);
                _markers[i].transform.localPosition = new Vector3((t - 0.5f) * TrackWidthM, 0f, -0.001f);
                _markers[i].Fill = ColorRole.Danger;
                _markers[i].Border = ColorRole.Ink;
                _markers[i].BorderPx = 2f;
                _markers[i].RadiusPx = 3f;
                _markers[i].ShadowLevel = "flat";
                _markers[i].Refresh();
            }
        }

        /// <param name="t">0..1 along the run. Driven by a pinch-drag from the app layer.</param>
        public void SetScrub(float t)
        {
            _scrub = Mathf.Clamp01(t);
            if (_session == null) return;

            if (Track != null)
            {
                Track.SizeM = new Vector2(TrackWidthM, TrackHeightM);
                Track.Fill = ColorRole.SurfaceSunken;
                Track.Refresh();
            }

            if (Playhead != null)
            {
                Playhead.SizeM = new Vector2(0.008f, TrackHeightM * 2.6f);
                Playhead.transform.localPosition = new Vector3((_scrub - 0.5f) * TrackWidthM, 0f, -0.002f);
                Playhead.Fill = ColorRole.Accent;
                Playhead.Refresh();
            }

            ShowNearestThumbnail(Mathf.RoundToInt(_scrub * Mathf.Max(1, _session.durationMs)));
        }

        /// <summary>
        /// The thumbnail closest to the scrub point.
        ///
        /// Nearest rather than "the last one before", so scrubbing to the very start shows the
        /// first frame instead of nothing -- an empty preview at t=0 reads as broken.
        /// </summary>
        void ShowNearestThumbnail(int atMs)
        {
            if (_session?.thumbnails == null || _session.thumbnails.Length == 0 || Thumbnail == null) return;

            var best = 0;
            var bestDistance = int.MaxValue;
            for (var i = 0; i < _session.thumbnails.Length; i++)
            {
                var distance = Mathf.Abs(_session.thumbnails[i].atMs - atMs);
                if (distance >= bestDistance) continue;
                bestDistance = distance;
                best = i;
            }

            var jpeg = System.Convert.FromBase64String(_session.thumbnails[best].jpeg);
            // One texture, reloaded in place. Creating one per scrub frame would allocate a
            // texture per frame while somebody drags, which is a fast way to run out of memory
            // on a headset.
            if (_thumbTexture == null) _thumbTexture = new Texture2D(2, 2, TextureFormat.RGBA32, false);
            if (_thumbTexture.LoadImage(jpeg)) Thumbnail.Refresh();

            if (Caption != null)
            {
                var seconds = _session.thumbnails[best].atMs / 1000;
                Caption.SetText($"{seconds / 60}:{seconds % 60:00}");
            }
        }

        void OnDestroy()
        {
            if (_thumbTexture != null) Destroy(_thumbTexture);
        }
    }
}
