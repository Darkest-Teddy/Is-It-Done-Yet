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

        [Tooltip(
            "Anything implementing IVisionProvider -- OpenAiVisionProvider, or leave empty to " +
            "fall back to the local detector's own label and run fully offline.")]
        [SerializeField] private MonoBehaviour visionProviderBehaviour;

        [Header("Prefabs")]
        [SerializeField] private GameObject foodBoundsPrefab;
        [SerializeField] private GameObject documentBoundsPrefab;

        [Header("Model")]
        [Tooltip("Relative to StreamingAssets. Export with: yolo export ... format=onnx opset=12")]
        [SerializeField] private string modelStreamingPath = "yolov8n.onnx";
        [Tooltip("Must match the imgsz the ONNX was exported at. Not tunable at runtime.")]
        [SerializeField] private int inputSize = 320;

        // Stability knobs, live from the registry so they are tunable in-headset rather than
        // through a rebuild.
        //
        // confirmFrames: consecutive sightings before a hologram appears. Raw detections
        // flicker, and a hologram that blinks is worse than none -- nobody can tell whether it
        // saw the object, so they stop believing all of it.
        //
        // forgetFrames sits higher than confirmFrames on purpose. The two lean opposite ways
        // because the costs do: appearing late is invisible, while vanishing and returning is
        // the failure everybody notices.
        private int confirmFrames => PerceptionTunables.GetInt(PerceptionTunables.ConfirmFrames);
        private int forgetFrames => PerceptionTunables.GetInt(PerceptionTunables.ForgetFrames);
        private float associationRadius => PerceptionTunables.Get(PerceptionTunables.AssocRadius);

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

        /// <summary>Position smoothing. Lower is steadier and laggier.</summary>
        private float smoothing => PerceptionTunables.Get(PerceptionTunables.Smoothing);

        private YoloFoodDetector _foodDetector;
        private DocumentContourDetector _documentDetector;
        private DocumentRectifier _rectifier;
        private IVisionProvider _vision;
        private RecipeRunner _recipe;
        private readonly List<string> _visibleLabels = new();

        /// <summary>
        /// The running recipe. Read by RecipeRailUI; there is exactly one, and the manager owns
        /// it because it is the thing holding the label stream that drives it.
        /// </summary>
        public RecipeRunner Recipe => _recipe;

        private Mat _workerMat;
        private volatile bool _busy;
        private CapturedFrame _workerFrame;

        // Results cross the thread boundary through this, guarded. It is a single assignment of
        // a completed list, so the lock is never held for more than a reference swap.
        private readonly object _resultLock = new();
        private List<Detection2D> _pendingResults;
        private bool _hasPendingResults;

        private readonly List<TrackedObject> _tracked = new();

        /// <summary>How long the last detection pass took. The number that decides capture rate.</summary>
        public float LastDetectMs { get; private set; }

        public int TrackedCount => _tracked.Count;

        /// <summary>Round trip of the last identification. Sets the whole feel; show it.</summary>
        public float LastVisionMs { get; private set; }

        public string VisionProviderName => _vision?.Name ?? "none";

        /// <summary>
        /// Why the last detection was thrown away, and how many have been.
        ///
        /// On the debug panel because a detection that silently fails to appear is undiagnosable,
        /// and the natural reaction is to start lowering the confidence threshold -- which makes
        /// everything worse. "rejected: carrot at 0.78m" is readable in one glance.
        /// </summary>
        public string LastRejection { get; private set; } = "";

        public int RejectedCount => _rejected;

        private int _rejected;

        /// <summary>
        /// The frame the detectors last ran on, and the edge map they produced, for the debug
        /// panel. Both are live buffers owned by other objects -- read only, never dispose.
        /// </summary>
        public Mat LastFrameMat => _workerMat;

        public Mat LastEdgeMat => _documentDetector?.LastEdges;

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

            /// <summary>What to show. The vision provider's answer once it arrives, else the
            /// local detector's class name.</summary>
            public string DisplayLabel;
            public bool IdentifyPending;
            public bool Identified;
            /// <summary>The vision provider looked and said there is nothing here.</summary>
            public bool Vetoed;
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

            _foodDetector = new YoloFoodDetector(path, inputSize);
            _documentDetector = new DocumentContourDetector();
            _rectifier = new DocumentRectifier();
            _recipe = new RecipeRunner(MRPerception.Recipe.Shakshuka());

            _vision = visionProviderBehaviour as IVisionProvider;
            if (_vision == null)
            {
                // Offline by default rather than broken by default. Master spec 5.2.3 wants the
                // whole demo runnable with no network, and rehearsed that way at least once.
                _vision = new LocalHintProvider();
                if (visionProviderBehaviour != null)
                {
                    Debug.LogWarning(
                        $"[Perception] {visionProviderBehaviour.GetType().Name} does not " +
                        "implement IVisionProvider; using local labels.");
                }
            }

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
            var stopwatch = System.Diagnostics.Stopwatch.StartNew();
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
                LastDetectMs = (float)stopwatch.Elapsed.TotalMilliseconds;
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

                // The filter a 2D pipeline cannot have. A "banana" 90cm long is a worktop, and
                // no confidence score will ever say so -- but the depth raycast just told us
                // how big it actually is, and that is decisive. Utensils are dropped here too:
                // a knife is useful context, never a subject.
                if (d.Kind == DetectionKind.Food)
                {
                    if (FoodPlausibility.RoleOf(d.Label) == FoodPlausibility.Role.Ignore) continue;
                    if (!FoodPlausibility.PlausibleSize(d.Label, placed.SizeMeters))
                    {
                        LastRejection = FoodPlausibility.Explain(d.Label, placed.SizeMeters);
                        _rejected++;
                        continue;
                    }
                }

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
            RequestIdentification(results);
            DriveRecipe();
        }

        /// <summary>
        /// Hands the current label set to the recipe.
        ///
        /// This is the inversion that makes the whole thing robust. Without a recipe, perception
        /// has to answer "what is on this counter" -- an open question, against a model that
        /// knows ten foods, on a wooden surface that generates false positives all day. With
        /// one, it answers "has the pan arrived yet": closed, expected, and easy. Anything that
        /// is not what the step is waiting for simply does not matter.
        /// </summary>
        private void DriveRecipe()
        {
            if (_recipe == null) return;

            _visibleLabels.Clear();
            foreach (TrackedObject t in _tracked)
            {
                if (t.Vetoed || t.Hits < confirmFrames) continue;
                // The identified name where there is one -- "pepper" beats "broccoli" for
                // matching a recipe, and the whole point of the vision provider is that it
                // knows words COCO does not.
                _visibleLabels.Add(string.IsNullOrEmpty(t.DisplayLabel) ? t.Label : t.DisplayLabel);
            }

            _recipe.Observe(_visibleLabels, Time.realtimeSinceStartup);
        }

        /// <summary>
        /// Asks the vision provider to name ONE unidentified object per capture.
        ///
        /// Once per object, not once per frame, and that is the whole reason a one-second cloud
        /// round trip is affordable here. A jar on a table does not become a different jar: the
        /// local detector holds the track at 5Hz and this fills in the name a second later,
        /// after which it sticks. Five objects in a session means five calls -- rather than one
        /// per frame, which at 5Hz for an hour would be eighteen thousand.
        ///
        /// One at a time, newest first. Newest because the object the user just put down is the
        /// one they are waiting to see named.
        /// </summary>
        private void RequestIdentification(List<Detection2D> results)
        {
            if (_vision == null || _vision.Busy || _workerMat == null) return;

            for (int i = _tracked.Count - 1; i >= 0; i--)
            {
                TrackedObject t = _tracked[i];
                if (t.Identified || t.IdentifyPending) continue;
                if (t.Hits < confirmFrames) continue;

                // Find the 2D box this track came from in THIS frame, so the crop matches what
                // was actually seen. A stale box crops the wrong pixels.
                int best = -1;
                float bestScore = float.MaxValue;
                for (int r = 0; r < results.Count; r++)
                {
                    if (results[r].Label != t.Label) continue;
                    float score = Mathf.Abs(results[r].PixelRect.width * results[r].PixelRect.height);
                    if (score < bestScore) { bestScore = score; best = r; }
                }
                if (best < 0) continue;

                Texture2D crop = CropToTexture(_workerMat, results[best].PixelRect);
                if (crop == null) continue;

                // A bowl is interesting for what is in it. This is the whole route to everything
                // COCO cannot see -- shredded cheese, chopped onion, flour, spices. None of them
                // has a shape a detector can localise; all of them sit in something that does.
                bool isContainer =
                    FoodPlausibility.RoleOf(t.Label) == FoodPlausibility.Role.Container;
                VisionSubject subject = isContainer ? VisionSubject.Contents : VisionSubject.Object;

                t.IdentifyPending = true;
                TrackedObject captured = t;
                _vision.Identify(crop, t.Label, subject, result =>
                {
                    Destroy(crop);
                    captured.IdentifyPending = false;
                    LastVisionMs = result.LatencyMs > 0f ? result.LatencyMs : LastVisionMs;

                    if (result.Rejected)
                    {
                        // An open-vocabulary veto. The local detector said broccoli, the model
                        // looked and said worktop. Believe the one that can see everything.
                        captured.Vetoed = true;
                        LastRejection = captured.Label + ": " +
                            (string.IsNullOrEmpty(result.Note) ? "not a subject" : result.Note);
                        _rejected++;
                        return;
                    }

                    if (!result.Ok) return;      // failure, not a verdict -- retry next capture

                    captured.Identified = true;
                    captured.DisplayLabel = isContainer
                        ? result.Label + " (in " + captured.Label + ")"
                        : result.Label;
                });
                return;   // one per capture
            }
        }

        /// <summary>Lifts a pixel rect out of a Mat as a Texture2D. Caller destroys it.</summary>
        private static Texture2D CropToTexture(Mat frame, UnityEngine.Rect rect)
        {
            int x = Mathf.Clamp(Mathf.FloorToInt(rect.x), 0, frame.cols() - 1);
            int y = Mathf.Clamp(Mathf.FloorToInt(rect.y), 0, frame.rows() - 1);
            int w = Mathf.Clamp(Mathf.CeilToInt(rect.width), 1, frame.cols() - x);
            int h = Mathf.Clamp(Mathf.CeilToInt(rect.height), 1, frame.rows() - y);
            if (w < 8 || h < 8) return null;

            using var roi = new Mat(frame, new OpenCVForUnity.CoreModule.Rect(x, y, w, h));
            return DocumentRectifier.ToTexture(roi);
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
                    DisplayLabel = placed.Source.Label,
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
                string shown = match.DisplayLabel;
                string instruction = _recipe?.InstructionFor(shown)
                                     ?? _recipe?.InstructionFor(match.Label);
                if (!string.IsNullOrEmpty(instruction)) shown = instruction;
                match.Visualizer.Apply(match.Position, match.Rotation, scale, shown);
            }
        }

        private void Retire()
        {
            for (int i = _tracked.Count - 1; i >= 0; i--)
            {
                TrackedObject t = _tracked[i];

                // A veto retires the track immediately rather than waiting out forgetFrames.
                // The local detector will keep re-finding the same wood grain every capture, so
                // letting it age out normally means it simply respawns.
                if (t.Vetoed)
                {
                    if (t.Instance != null) Destroy(t.Instance);
                    if (t.Visualizer != null) Destroy(t.Visualizer.gameObject);
                    _tracked.RemoveAt(i);
                    continue;
                }

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
