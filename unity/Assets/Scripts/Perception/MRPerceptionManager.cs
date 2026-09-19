using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using OpenCVForUnity.CoreModule;
using OpenCVForUnity.UnityUtils;
using UnityEngine;

namespace MRPerception
{
    /// <summary>
    /// Orchestrates the whole thing and owns the threading.
    ///
    /// THE ONE RULE: inference never runs on the main thread. YOLOv8n at 320x320 on an XR2 Gen 2
    /// costs 40-90ms. The frame budget at 72Hz is 13.9ms. Running it in Update() does not make
    /// the app slow, it makes it a slideshow that also breaks reprojection, and on a headset
    /// that is not a performance complaint -- it is nausea.
    ///
    /// So detection runs on a single background thread. This is safe because OpenCV Mats are
    /// native memory and nothing in the detectors calls into Unity. It is ONE thread rather than
    /// a pool because a Net is not re-entrant, and because two concurrent inferences on a
    /// 4-big-core mobile chip do not finish twice as fast -- they finish at the same time as
    /// each other, twice as late, having also evicted the render thread from cache.
    ///
    /// The Mat handed to the worker is COPIED first. The feed reuses its buffer every capture,
    /// so handing the original across the boundary means it is being overwritten while the
    /// detector reads it -- a race that shows up as occasional torn detections and is
    /// essentially impossible to reproduce on demand.
    /// </summary>
    public sealed class MRPerceptionManager : MonoBehaviour
    {
        [Header("Wiring")]
        [SerializeField] private PassthroughCameraFeed feed;
        [SerializeField] private DetectionRaycaster raycaster;

        [Header("Prefabs")]
        [SerializeField] private GameObject foodBoundsPrefab;
        [SerializeField] private GameObject documentBoundsPrefab;

        [Header("Model")]
        [Tooltip("Relative to StreamingAssets. Export with: yolo export ... format=onnx opset=12")]
        [SerializeField] private string modelStreamingPath = "yolov8n.onnx";
        [SerializeField] private int inputSize = 320;
        [SerializeField, Range(0.1f, 0.9f)] private float confidenceThreshold = 0.4f;

        [Header("Stability")]
        [Tooltip(
            "Consecutive sightings before a hologram appears. Raw detections flicker, and a " +
            "hologram that blinks is worse than none -- nobody can tell whether it saw the " +
            "object, so they stop believing all of it.")]
        [SerializeField] private int confirmFrames = 2;

        [Tooltip("Consecutive misses before it is removed. Higher than confirmFrames on purpose.")]
        [SerializeField] private int forgetFrames = 5;

        [Tooltip("Metres. Two sightings closer than this are the same object.")]
        [SerializeField] private float associationRadius = 0.12f;

        [Header("Documents")]
        [Tooltip("Rectify detected pages into an upright image, ready for OCR or a thumbnail.")]
        [SerializeField] private bool rectifyDocuments = true;

        /// <summary>
        /// Fires with a flattened, head-on image of a detected page. The subscriber OWNS the Mat
        /// and must Dispose it -- it is a fresh allocation per document, not a shared buffer.
        ///
        /// This is the hand-off point for OCR. See unity/README.md for why the engine choice is
        /// left to the caller rather than baked in here.
        /// </summary>
        public event System.Action<Mat> DocumentRectified;

        [Tooltip("Position smoothing. Lower is steadier and laggier.")]
        [SerializeField, Range(0.05f, 1f)] private float smoothing = 0.35f;

        private YoloFoodDetector _foodDetector;
        private DocumentContourDetector _documentDetector;
        private DocumentRectifier _rectifier;

        private Mat _workerMat;
        private volatile bool _busy;
        private CapturedFrame _workerFrame;

        // Results cross the thread boundary through this, guarded. It is a single assignment of
        // a completed list, so the lock is never held for more than a reference swap.
        private readonly object _resultLock = new();
        private List<Detection2D> _pendingResults;
        private bool _hasPendingResults;

        private readonly List<TrackedObject> _tracked = new();

        private sealed class TrackedObject
        {
            public string Label;
            public DetectionKind Kind;
            public Vector3 Position;
            public Quaternion Rotation;
            public Vector2 Size;
            public int Hits;
            public int Misses;
            public bool Seen;
            public GameObject Instance;
            public DetectionVisualizer Visualizer;
        }

        private void Start()
        {
            string path = Utils.getFilePath(modelStreamingPath);
            if (string.IsNullOrEmpty(path))
            {
                Debug.LogError($"[Perception] model not found in StreamingAssets: {modelStreamingPath}");
                enabled = false;
                return;
            }

            _foodDetector = new YoloFoodDetector(path, inputSize, confidenceThreshold);
            _documentDetector = new DocumentContourDetector();
            _rectifier = new DocumentRectifier();

            feed.FrameReady += OnFrameReady;
        }

        private void OnDestroy()
        {
            if (feed != null) feed.FrameReady -= OnFrameReady;
            // Let an in-flight inference finish before the Mats under it are freed.
            SpinWait.SpinUntil(() => !_busy, 2000);
            _foodDetector?.Dispose();
            _documentDetector?.Dispose();
            _rectifier?.Dispose();
            _workerMat?.Dispose();
        }

        private void OnFrameReady(Mat rgba, CapturedFrame frame)
        {
            if (_busy) return;   // still working; skip this capture rather than queue it

            if (_workerMat == null || _workerMat.cols() != rgba.cols() || _workerMat.rows() != rgba.rows())
            {
                _workerMat?.Dispose();
                _workerMat = new Mat(rgba.rows(), rgba.cols(), rgba.type());
            }
            // The copy that prevents the race. See the class comment.
            rgba.copyTo(_workerMat);
            _workerFrame = frame;

            _busy = true;
            Task.Run(RunDetectors);
        }

        private void RunDetectors()
        {
            try
            {
                var results = new List<Detection2D>();
                results.AddRange(_foodDetector.Detect(_workerMat));
                results.AddRange(_documentDetector.Detect(_workerMat));

                lock (_resultLock)
                {
                    _pendingResults = results;
                    _hasPendingResults = true;
                }
            }
            catch (Exception e)
            {
                // Never let a worker exception disappear. A silently dead detection thread
                // presents as "the app stopped seeing things" with nothing in the log.
                Debug.LogError($"[Perception] detector thread failed: {e}");
            }
            finally
            {
                _busy = false;
            }
        }

        private void Update()
        {
            List<Detection2D> results = null;
            lock (_resultLock)
            {
                if (_hasPendingResults)
                {
                    results = _pendingResults;
                    _pendingResults = null;
                    _hasPendingResults = false;
                }
            }
            if (results == null) return;

            // Raycasting has to happen here: MRUK and the Depth API are Unity APIs and are
            // main-thread only. It is cheap -- a handful of rays -- so this is not a problem,
            // but it is why placement is not simply done in the worker alongside detection.
            foreach (var t in _tracked) t.Seen = false;

            foreach (Detection2D d in results)
            {
                if (!raycaster.TryPlace(d, _workerFrame, feed, out Detection3D placed)) continue;
                Integrate(placed);

                // Rectification reads from the worker Mat, which is only valid until the next
                // capture starts. Doing it here rather than in the worker keeps that lifetime
                // obvious, and a perspective warp is a single sampling pass -- cheap enough to
                // sit on the main thread for the one or two pages in view.
                if (rectifyDocuments && d.Kind == DetectionKind.Document
                    && DocumentRectified != null)
                {
                    Mat flat = _rectifier.Rectify(_workerMat, d);
                    if (flat != null) DocumentRectified.Invoke(flat);
                }
            }

            Retire();
        }

        private void Integrate(in Detection3D placed)
        {
            TrackedObject match = null;
            float best = associationRadius;

            foreach (TrackedObject t in _tracked)
            {
                if (t.Seen) continue;
                if (t.Label != placed.Source.Label) continue;
                float d = Vector3.Distance(t.Position, placed.Position);
                if (d < best)
                {
                    best = d;
                    match = t;
                }
            }

            if (match == null)
            {
                _tracked.Add(new TrackedObject
                {
                    Label = placed.Source.Label,
                    Kind = placed.Source.Kind,
                    Position = placed.Position,
                    Rotation = placed.Rotation,
                    Size = placed.SizeMeters,
                    Hits = 1,
                    Misses = 0,
                    Seen = true
                });
                return;
            }

            // Exponential smoothing on every continuous quantity. Snapping to each new
            // measurement makes a hologram twitch even when the detection is perfectly good,
            // because the depth raycast itself is noisy at the millimetre level.
            match.Position = Vector3.Lerp(match.Position, placed.Position, smoothing);
            match.Rotation = Quaternion.Slerp(match.Rotation, placed.Rotation, smoothing);
            match.Size = Vector2.Lerp(match.Size, placed.SizeMeters, smoothing);
            match.Hits++;
            match.Misses = 0;
            match.Seen = true;

            if (match.Instance == null && match.Visualizer == null && match.Hits >= confirmFrames)
            {
                GameObject prefab = match.Kind == DetectionKind.Document
                    ? documentBoundsPrefab
                    : foodBoundsPrefab;

                if (prefab != null)
                {
                    match.Instance = Instantiate(prefab, match.Position, match.Rotation, transform);
                }
                else
                {
                    // No prefab authored yet. Fall back to a runtime wireframe rather than
                    // drawing nothing -- a correctly working detector that displays nothing is
                    // an unhelpful thing to be staring at while establishing whether detection
                    // works at all.
                    match.Visualizer = DetectionVisualizer.Create(transform, match.Kind);
                }
            }

            // Thickness is a guess; only the two measured axes are real.
            var scale = new Vector3(match.Size.x, 0.02f, match.Size.y);

            if (match.Instance != null)
            {
                match.Instance.transform.SetPositionAndRotation(match.Position, match.Rotation);
                match.Instance.transform.localScale = scale;
            }
            else if (match.Visualizer != null)
            {
                match.Visualizer.Apply(match.Position, match.Rotation, scale, match.Label);
            }
        }

        private void Retire()
        {
            for (int i = _tracked.Count - 1; i >= 0; i--)
            {
                TrackedObject t = _tracked[i];
                if (t.Seen) continue;

                t.Misses++;
                if (t.Misses < forgetFrames) continue;

                if (t.Instance != null) Destroy(t.Instance);
                if (t.Visualizer != null) Destroy(t.Visualizer.gameObject);
                _tracked.RemoveAt(i);
            }
        }
    }
}
