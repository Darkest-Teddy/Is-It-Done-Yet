using System;
using System.Collections.Generic;
using OpenCVForUnity.CoreModule;
using OpenCVForUnity.DnnModule;
using OpenCVForUnity.ImgprocModule;
using OpenCVForUnity.UnityUtils;
using UnityEngine;

namespace MRPerception
{
    /// <summary>
    /// YOLOv8-nano through OpenCV's DNN module, parsed correctly.
    ///
    /// THE THING THAT CATCHES EVERYONE: YOLOv8's output tensor is NOT shaped like YOLOv5's, and
    /// almost every tutorial you will find online is written for v5.
    ///
    ///     YOLOv5:  [1, 25200, 85]   rows are detections; 85 = 4 box + 1 OBJECTNESS + 80 classes
    ///     YOLOv8:  [1, 84, 8400]    TRANSPOSED; 84 = 4 box + 80 classes, and NO objectness
    ///
    /// So you must transpose before iterating, and you must not multiply by an objectness score
    /// that does not exist. Getting either wrong does not throw -- it produces a handful of
    /// garbage boxes at low confidence, which reads as "the model is bad" and sends people off
    /// to retrain something that was fine.
    ///
    /// Export for this with opset 12, which is what OpenCV's importer handles cleanly:
    ///     yolo export model=yolov8n.pt format=onnx opset=12 imgsz=320
    /// </summary>
    public sealed class YoloFoodDetector : IDisposable
    {
        // COCO-80 indices. The edible cluster is contiguous, which makes the filter cheap.
        //   39 bottle   40 wine glass  41 cup       42 fork      43 knife
        //   44 spoon    45 bowl        46 banana    47 apple     48 sandwich
        //   49 orange   50 broccoli    51 carrot    52 hot dog   53 pizza
        //   54 donut    55 cake
        private const int FirstFoodClass = 46;   // banana
        private const int LastFoodClass = 55;    // cake
        private const int FirstTablewareClass = 39;

        private static readonly string[] CocoNames =
        {
            "person","bicycle","car","motorbike","aeroplane","bus","train","truck","boat",
            "traffic light","fire hydrant","stop sign","parking meter","bench","bird","cat",
            "dog","horse","sheep","cow","elephant","bear","zebra","giraffe","backpack",
            "umbrella","handbag","tie","suitcase","frisbee","skis","snowboard","sports ball",
            "kite","baseball bat","baseball glove","skateboard","surfboard","tennis racket",
            "bottle","wine glass","cup","fork","knife","spoon","bowl","banana","apple",
            "sandwich","orange","broccoli","carrot","hot dog","pizza","donut","cake","chair",
            "sofa","pottedplant","bed","diningtable","toilet","tvmonitor","laptop","mouse",
            "remote","keyboard","cell phone","microwave","oven","toaster","sink","refrigerator",
            "book","clock","vase","scissors","teddy bear","hair drier","toothbrush"
        };

        private readonly Net _net;
        private readonly int _inputSize;
        private readonly bool _includeTableware;

        // Reused across every inference. Allocating Mats per frame is how you end up with the
        // GC running during a head turn.
        private Mat _blob;
        private Mat _rgbMat;
        private Mat _letterboxed;

        /// <summary>
        /// Confidence and NMS are NOT constructor parameters. They live in
        /// <see cref="PerceptionTunables"/> and are read per inference, because they are two of
        /// the three knobs that genuinely have to be tuned on the device -- YOLO is
        /// systematically less confident on low-contrast passthrough than its defaults assume,
        /// and by how much depends on the room.
        /// </summary>
        public YoloFoodDetector(
            string modelFilePath,
            int inputSize = 320,
            bool includeTableware = true)
        {
            _inputSize = inputSize;
            _includeTableware = includeTableware;

            _net = Dnn.readNetFromONNX(modelFilePath);
            if (_net == null || _net.empty())
            {
                throw new InvalidOperationException($"Could not load ONNX model at {modelFilePath}");
            }

            // CPU, deliberately. OpenCV's OpenCL path on Adreno is unreliable -- on some driver
            // versions it silently falls back to CPU anyway, on others it produces wrong results,
            // and on none of them is it clearly faster for a model this small. Keeping the input
            // at 320 buys more than any backend change would.
            _net.setPreferableBackend(Dnn.DNN_BACKEND_OPENCV);
            _net.setPreferableTarget(Dnn.DNN_TARGET_CPU);
        }

        /// <summary>
        /// Runs inference. Safe to call off the main thread -- OpenCV Mats are native memory and
        /// nothing here touches the Unity API -- but only from ONE thread: a Net is not
        /// re-entrant, and two concurrent forwards on the same instance corrupt each other.
        /// </summary>
        public List<Detection2D> Detect(Mat rgbaFrame)
        {
            var results = new List<Detection2D>();
            if (rgbaFrame == null || rgbaFrame.empty()) return results;

            // Read live, every call. Caching these into locals at construction is what makes a
            // tuning slider appear to do nothing.
            float confThreshold = PerceptionTunables.Get(PerceptionTunables.YoloConfidence);
            float nmsThreshold = PerceptionTunables.Get(PerceptionTunables.YoloNms);

            int srcW = rgbaFrame.cols();
            int srcH = rgbaFrame.rows();

            _rgbMat ??= new Mat();
            Imgproc.cvtColor(rgbaFrame, _rgbMat, Imgproc.COLOR_RGBA2RGB);

            // Letterbox rather than stretch. A squashed aspect ratio shifts every box and costs
            // real accuracy on elongated objects -- a banana stretched to square stops looking
            // like a banana to a network that never saw one that shape.
            float scale = Mathf.Min(_inputSize / (float)srcW, _inputSize / (float)srcH);
            int newW = Mathf.RoundToInt(srcW * scale);
            int newH = Mathf.RoundToInt(srcH * scale);
            int padX = (_inputSize - newW) / 2;
            int padY = (_inputSize - newH) / 2;

            _letterboxed ??= new Mat(_inputSize, _inputSize, CvType.CV_8UC3);
            _letterboxed.setTo(new Scalar(114, 114, 114));   // the grey ultralytics trains with
            using (var roi = new Mat(_letterboxed, new OpenCVForUnity.CoreModule.Rect(padX, padY, newW, newH)))
            {
                Imgproc.resize(_rgbMat, roi, new Size(newW, newH), 0, 0, Imgproc.INTER_LINEAR);
            }

            // 1/255 scaling, no mean subtraction, and swapRB false because the Mat is already
            // RGB. Passing a BGR Mat with swapRB false is a silent accuracy loss, not an error.
            _blob?.Dispose();
            _blob = Dnn.blobFromImage(
                _letterboxed, 1.0 / 255.0, new Size(_inputSize, _inputSize),
                new Scalar(0, 0, 0), false, false);

            _net.setInput(_blob);

            using (Mat output = _net.forward())
            {
                ParseYolov8(output, results, scale, padX, padY, srcW, srcH,
                    confThreshold, nmsThreshold);
            }

            return results;
        }

        private void ParseYolov8(
            Mat output, List<Detection2D> results,
            float scale, int padX, int padY, int srcW, int srcH,
            float confThreshold, float nmsThreshold)
        {
            // [1, 84, 8400] -> 84 x 8400 -> transpose -> 8400 x 84.
            using Mat reshaped = output.reshape(1, output.size(1));
            using Mat candidates = new Mat();
            Core.transpose(reshaped, candidates);

            int rows = candidates.rows();
            int cols = candidates.cols();
            int classCount = cols - 4;

            var boxes = new List<OpenCVForUnity.CoreModule.Rect2d>();
            var scores = new List<float>();
            var classIds = new List<int>();

            // One bulk copy out of native memory. Reading row by row through the Mat accessor
            // costs a marshalled call per element -- at 8400 x 84 that is 700k interop
            // round-trips per frame, which dwarfs the inference itself.
            float[] data = new float[rows * cols];
            candidates.get(0, 0, data);

            for (int i = 0; i < rows; i++)
            {
                int offset = i * cols;

                int bestClass = -1;
                float bestScore = 0f;
                for (int c = 0; c < classCount; c++)
                {
                    float s = data[offset + 4 + c];
                    if (s > bestScore)
                    {
                        bestScore = s;
                        bestClass = c;
                    }
                }

                if (bestScore < confThreshold || bestClass < 0) continue;
                if (!IsWanted(bestClass)) continue;

                // Centre-form, in letterboxed input space. Undo the padding, then the scale.
                float cx = data[offset + 0];
                float cy = data[offset + 1];
                float w = data[offset + 2];
                float h = data[offset + 3];

                float x0 = (cx - w * 0.5f - padX) / scale;
                float y0 = (cy - h * 0.5f - padY) / scale;
                float bw = w / scale;
                float bh = h / scale;

                boxes.Add(new OpenCVForUnity.CoreModule.Rect2d(x0, y0, bw, bh));
                scores.Add(bestScore);
                classIds.Add(bestClass);
            }

            if (boxes.Count == 0) return;

            using var boxesMat = new MatOfRect2d(boxes.ToArray());
            using var scoresMat = new MatOfFloat(scores.ToArray());
            using var indices = new MatOfInt();
            Dnn.NMSBoxes(boxesMat, scoresMat, confThreshold, nmsThreshold, indices);

            foreach (int idx in indices.toArray())
            {
                var b = boxes[idx];
                // Clamp into frame. A box hanging off the edge produces an anchor pixel outside
                // the image, and the ray for it points somewhere arbitrary.
                float x = Mathf.Clamp((float)b.x, 0, srcW - 1);
                float y = Mathf.Clamp((float)b.y, 0, srcH - 1);
                float w = Mathf.Min((float)b.width, srcW - x);
                float h = Mathf.Min((float)b.height, srcH - y);
                if (w < 2 || h < 2) continue;

                results.Add(new Detection2D(
                    new UnityEngine.Rect(x, y, w, h),
                    CocoNames[classIds[idx]],
                    scores[idx],
                    DetectionKind.Food));
            }
        }

        private bool IsWanted(int classId)
        {
            if (classId >= FirstFoodClass && classId <= LastFoodClass) return true;
            return _includeTableware &&
                   classId >= FirstTablewareClass && classId < FirstFoodClass;
        }

        public void Dispose()
        {
            _blob?.Dispose();
            _rgbMat?.Dispose();
            _letterboxed?.Dispose();
            _net?.Dispose();
        }
    }
}
