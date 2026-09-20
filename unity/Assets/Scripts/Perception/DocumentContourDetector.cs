using System;
using System.Collections.Generic;
using OpenCVForUnity.CoreModule;
using OpenCVForUnity.ImgprocModule;
using UnityEngine;
using Rect = UnityEngine.Rect;

namespace MRPerception
{
    /// <summary>
    /// Finds paper and screens as 4-point convex quadrilaterals.
    ///
    /// Classical, and deliberately so: a rectangle is a shape, not a category, and asking a
    /// neural network to find one costs 40ms to answer a question that Canny and
    /// <c>approxPolyDP</c> answer in 3ms with better corner precision. The corners are the
    /// point -- a YOLO box gives you an axis-aligned rectangle around a document that is almost
    /// never axis-aligned, which is useless for placing a hologram flush against it.
    ///
    /// The pipeline and why each step is there:
    ///
    ///   grey -> blur -> Canny -> DILATE -> findContours -> approxPolyDP -> convexity + area
    ///
    /// The dilate is the step that is usually missing and it is the one that makes this work at
    /// all. Canny returns edges with gaps wherever contrast dips -- a shadow across a page
    /// corner, a highlight on a screen bezel -- and <c>findContours</c> needs a CLOSED loop. One
    /// 3x3 dilate bridges those gaps. Without it you get three disconnected arcs where a sheet
    /// of paper is, and no quadrilateral at all.
    /// </summary>
    public sealed class DocumentContourDetector : IDisposable
    {
        private Mat _grey;
        private Mat _blurred;
        private Mat _edges;
        private Mat _kernel;
        private int _kernelPx;

        /// <summary>
        /// The live edge map, for the debug panel. Seeing this is worth more than any slider:
        /// it turns "detection is not working" into "the edges are broken up, dilate more" in
        /// about four seconds.
        ///
        /// Read from the main thread while the worker writes it, and this is NOT benign, which
        /// an earlier version of this comment claimed. Imgproc.Canny calls Mat::create, so it
        /// REALLOCATES the native buffer whenever the frame size or type changes -- the first
        /// frames, a resolution change, a camera switch. A reallocation between a reader
        /// checking rows()/cols() and copying the pixels is a read of freed native memory: a
        /// hard crash, not a torn frame.
        ///
        /// Left as-is because it only bites on a size change and this is a debug view. Do not
        /// build anything load-bearing on it, and do not widen the window.
        /// </summary>
        public Mat LastEdges => _edges;

        /// <summary>
        /// Off-main-thread safe, same caveat as the detector: one thread at a time, because the
        /// scratch Mats are instance state.
        /// </summary>
        public List<Detection2D> Detect(Mat rgbaFrame)
        {
            var results = new List<Detection2D>();
            if (rgbaFrame == null || rgbaFrame.empty()) return results;

            int w = rgbaFrame.cols();
            int h = rgbaFrame.rows();
            double frameArea = w * (double)h;

            float minAreaFraction = PerceptionTunables.Get(PerceptionTunables.DocMinArea);
            float maxAreaFraction = PerceptionTunables.Get(PerceptionTunables.DocMaxArea);
            float epsilonFraction = PerceptionTunables.Get(PerceptionTunables.DocEpsilon);
            float lowMult = PerceptionTunables.Get(PerceptionTunables.CannyLowMult);
            float highMult = PerceptionTunables.Get(PerceptionTunables.CannyHighMult);
            int dilatePx = Mathf.Max(1, PerceptionTunables.GetInt(PerceptionTunables.DocDilate) | 1);

            _grey ??= new Mat();
            _blurred ??= new Mat();
            _edges ??= new Mat();
            if (_kernel == null || _kernelPx != dilatePx)
            {
                _kernel?.Dispose();
                _kernel = Imgproc.getStructuringElement(
                    Imgproc.MORPH_RECT, new Size(dilatePx, dilatePx));
                _kernelPx = dilatePx;
            }

            Imgproc.cvtColor(rgbaFrame, _grey, Imgproc.COLOR_RGBA2GRAY);

            // Blur before Canny, always. Canny differentiates, and differentiating sensor noise
            // produces a field of one-pixel edges that bury the real ones.
            Imgproc.GaussianBlur(_grey, _blurred, new Size(5, 5), 0);

            // Thresholds from the image's own median rather than fixed numbers. Passthrough
            // exposure swings hard between a lit desk and a dim room, and a pair of constants
            // tuned in one produces either a solid white edge map or an empty one in the other.
            double median = MedianOf(_blurred);
            double lower = Math.Max(0, lowMult * median);
            double upper = Math.Min(255, highMult * median);
            Imgproc.Canny(_blurred, _edges, lower, upper);

            // Close the gaps. See the class comment -- this is the load-bearing line.
            Imgproc.dilate(_edges, _edges, _kernel);

            var contours = new List<MatOfPoint>();
            using var hierarchy = new Mat();
            Imgproc.findContours(_edges, contours, hierarchy,
                Imgproc.RETR_EXTERNAL, Imgproc.CHAIN_APPROX_SIMPLE);

            foreach (MatOfPoint contour in contours)
            {
                using (contour)
                {
                    double area = Imgproc.contourArea(contour);
                    if (area < frameArea * minAreaFraction) continue;
                    if (area > frameArea * maxAreaFraction) continue;

                    using var curve = new MatOfPoint2f(contour.toArray());
                    double perimeter = Imgproc.arcLength(curve, true);
                    if (perimeter <= 0) continue;

                    using var approx = new MatOfPoint2f();
                    // Epsilon as a FRACTION of perimeter, not an absolute pixel count. A fixed
                    // epsilon over-simplifies a small quad into a triangle and under-simplifies
                    // a large one into a twelve-sided blob, so the detector would work at
                    // exactly one distance from the page.
                    Imgproc.approxPolyDP(curve, approx, epsilonFraction * perimeter, true);

                    if (approx.rows() != 4) continue;

                    using var approxInt = new MatOfPoint(approx.toArray());
                    // Convexity rejects the self-intersecting bowties that approxPolyDP happily
                    // returns for a folded page or a partly occluded one.
                    if (!Imgproc.isContourConvex(approxInt)) continue;

                    Point[] pts = approx.toArray();
                    Vector2[] corners = OrderCorners(pts);
                    if (!PlausibleQuad(corners)) continue;

                    results.Add(new Detection2D(
                        BoundsOf(corners),
                        "document",
                        Mathf.Clamp01((float)(area / frameArea) * 4f),
                        DetectionKind.Document,
                        corners));
                }
            }

            // Biggest first: the page you are holding up is the one you mean.
            results.Sort((a, b) =>
                (b.PixelRect.width * b.PixelRect.height)
                .CompareTo(a.PixelRect.width * a.PixelRect.height));
            return results;
        }

        /// <summary>
        /// Puts the four corners in a consistent order: top-left, top-right, bottom-right,
        /// bottom-left.
        ///
        /// findContours returns them in whatever winding it walked, which varies with where the
        /// contour started. Every consumer -- a perspective warp, a quad mesh, a hologram's
        /// orientation -- needs a known order, and the trick is neat: for an axis-ish
        /// quadrilateral the sum x+y is smallest at the top-left and largest at the
        /// bottom-right, while the difference x-y separates the other two.
        /// </summary>
        private static Vector2[] OrderCorners(Point[] pts)
        {
            var v = new Vector2[4];
            for (int i = 0; i < 4; i++) v[i] = new Vector2((float)pts[i].x, (float)pts[i].y);

            int tl = 0, br = 0, tr = 0, bl = 0;
            float minSum = float.MaxValue, maxSum = float.MinValue;
            float minDiff = float.MaxValue, maxDiff = float.MinValue;

            for (int i = 0; i < 4; i++)
            {
                float sum = v[i].x + v[i].y;
                float diff = v[i].x - v[i].y;
                if (sum < minSum) { minSum = sum; tl = i; }
                if (sum > maxSum) { maxSum = sum; br = i; }
                if (diff < minDiff) { minDiff = diff; bl = i; }
                if (diff > maxDiff) { maxDiff = diff; tr = i; }
            }

            return new[] { v[tl], v[tr], v[br], v[bl] };
        }

        /// <summary>
        /// Rejects quads that are technically convex but are not documents.
        ///
        /// Two filters. Opposite sides of a real rectangle stay comparable under perspective
        /// unless you are looking at it almost edge-on, at which point there is nothing useful
        /// to place anyway; and a sliver with an extreme aspect ratio is a table edge, a door
        /// frame or a shadow line, all of which pass every earlier test.
        /// </summary>
        private static bool PlausibleQuad(Vector2[] c)
        {
            float top = Vector2.Distance(c[0], c[1]);
            float right = Vector2.Distance(c[1], c[2]);
            float bottom = Vector2.Distance(c[2], c[3]);
            float left = Vector2.Distance(c[3], c[0]);

            if (top < 8 || right < 8 || bottom < 8 || left < 8) return false;

            float hRatio = Mathf.Max(top, bottom) / Mathf.Min(top, bottom);
            float vRatio = Mathf.Max(left, right) / Mathf.Min(left, right);
            if (hRatio > 3f || vRatio > 3f) return false;

            float aspect = (top + bottom) / (left + right);
            return aspect > 0.15f && aspect < 7f;
        }

        private static Rect BoundsOf(Vector2[] c)
        {
            float minX = Mathf.Min(Mathf.Min(c[0].x, c[1].x), Mathf.Min(c[2].x, c[3].x));
            float maxX = Mathf.Max(Mathf.Max(c[0].x, c[1].x), Mathf.Max(c[2].x, c[3].x));
            float minY = Mathf.Min(Mathf.Min(c[0].y, c[1].y), Mathf.Min(c[2].y, c[3].y));
            float maxY = Mathf.Max(Mathf.Max(c[0].y, c[1].y), Mathf.Max(c[2].y, c[3].y));
            return new Rect(minX, minY, maxX - minX, maxY - minY);
        }

        /// <summary>
        /// Median intensity via a 256-bin histogram.
        ///
        /// Sorting the pixels would be the obvious way and costs an O(n log n) pass over 76k
        /// values every frame. A histogram is one linear pass plus a walk over 256 bins, and
        /// the answer is exact for 8-bit data.
        /// </summary>
        private static double MedianOf(Mat greyscale)
        {
            using var hist = new Mat();
            var images = new List<Mat> { greyscale };
            Imgproc.calcHist(images, new MatOfInt(0), new Mat(), hist,
                new MatOfInt(256), new MatOfFloat(0, 256));

            float[] bins = new float[256];
            hist.get(0, 0, bins);

            double total = greyscale.total();
            double running = 0;
            for (int i = 0; i < 256; i++)
            {
                running += bins[i];
                if (running >= total * 0.5) return i;
            }
            return 128;
        }

        public void Dispose()
        {
            _grey?.Dispose();
            _blurred?.Dispose();
            _edges?.Dispose();
            _kernel?.Dispose();
        }
    }
}
