using System;
using OpenCVForUnity.CoreModule;
using OpenCVForUnity.ImgprocModule;
using UnityEngine;

namespace MRPerception
{
    /// <summary>
    /// Flattens a detected quadrilateral into a head-on rectangle.
    ///
    /// This is the missing half of document detection. Finding the page tells you where it is;
    /// rectifying it is what makes the page READABLE -- by OCR, by a barcode decoder, or by a
    /// human looking at a captured thumbnail.
    ///
    /// The reason it matters so much for OCR specifically: a page on a desk seen from a headset
    /// is a trapezoid, and every OCR engine ever built assumes text runs along horizontal lines
    /// of constant height. Feeding it a trapezoid means the character heights vary continuously
    /// across the image and the baseline is not straight -- Tesseract's line finder either
    /// refuses the whole thing or segments it into nonsense. A perspective warp removes the
    /// problem completely rather than mitigating it, which is why it beats every amount of
    /// preprocessing applied to the unwarped crop.
    ///
    /// It is also nearly free: <c>getPerspectiveTransform</c> solves an 8x8 system once, and
    /// <c>warpPerspective</c> is a single sampling pass over the output pixels.
    /// </summary>
    public sealed class DocumentRectifier : IDisposable
    {
        private readonly int _maxOutputEdge;
        private Mat _transform;

        /// <param name="maxOutputEdge">
        /// Caps the rectified image. Tesseract wants roughly 30-40px of x-height and gains
        /// nothing above that, so a 4000px-wide warp of a page filling the frame is pure cost.
        /// </param>
        public DocumentRectifier(int maxOutputEdge = 1024)
        {
            _maxOutputEdge = maxOutputEdge;
        }

        /// <summary>
        /// Warps the quad in <paramref name="detection"/> out of <paramref name="sourceFrame"/>
        /// into a new upright Mat. The caller owns the result and must Dispose it.
        ///
        /// Returns null for anything that is not a four-cornered detection, rather than
        /// guessing corners from a bounding box -- a box around a rotated page includes a great
        /// deal of desk, and rectifying that produces a confident, perfectly sharp image of the
        /// wrong region.
        /// </summary>
        public Mat Rectify(Mat sourceFrame, in Detection2D detection)
        {
            if (sourceFrame == null || sourceFrame.empty()) return null;
            if (detection.Corners == null || detection.Corners.Length != 4) return null;

            Vector2[] c = detection.Corners;   // TL, TR, BR, BL

            // Output size from the quad's own edges, so the aspect ratio of the real page
            // survives. Taking the LONGER of each opposing pair rather than the average: under
            // perspective the near edge is the one closer to its true length, and the far edge
            // is foreshortened. Averaging them systematically shrinks the page and throws away
            // resolution on the half that was nearest and sharpest.
            float widthTop = Vector2.Distance(c[0], c[1]);
            float widthBottom = Vector2.Distance(c[3], c[2]);
            float heightLeft = Vector2.Distance(c[0], c[3]);
            float heightRight = Vector2.Distance(c[1], c[2]);

            float width = Mathf.Max(widthTop, widthBottom);
            float height = Mathf.Max(heightLeft, heightRight);
            if (width < 8f || height < 8f) return null;

            float scale = Mathf.Min(1f, _maxOutputEdge / Mathf.Max(width, height));
            int outW = Mathf.Max(8, Mathf.RoundToInt(width * scale));
            int outH = Mathf.Max(8, Mathf.RoundToInt(height * scale));

            using var src = new MatOfPoint2f(
                new Point(c[0].x, c[0].y),
                new Point(c[1].x, c[1].y),
                new Point(c[2].x, c[2].y),
                new Point(c[3].x, c[3].y));

            using var dst = new MatOfPoint2f(
                new Point(0, 0),
                new Point(outW - 1, 0),
                new Point(outW - 1, outH - 1),
                new Point(0, outH - 1));

            _transform?.Dispose();
            _transform = Imgproc.getPerspectiveTransform(src, dst);

            var output = new Mat(outH, outW, sourceFrame.type());
            // INTER_LINEAR is the right call here even though the OCR crop path uses CUBIC.
            // A warp both stretches and squeezes across one image; cubic overshoots at the
            // squeezed end and rings around high-contrast glyph edges, which is exactly the
            // artefact that turns clean text into speckle.
            Imgproc.warpPerspective(sourceFrame, output, _transform, new Size(outW, outH),
                Imgproc.INTER_LINEAR, Core.BORDER_REPLICATE, new Scalar(0, 0, 0, 0));

            return output;
        }

        /// <summary>
        /// Prepares a rectified page for OCR: greyscale, local contrast, and an upscale to
        /// Tesseract's comfortable x-height. The caller owns the result.
        ///
        /// Note what is deliberately NOT here: a threshold. Tesseract runs its own Otsu
        /// binarisation and is good at it, with more information than any threshold applied
        /// from out here would have. Handing it a pre-binarised image usually makes results
        /// worse. Give it clean, large greyscale and stop.
        /// </summary>
        public static Mat PrepareForOcr(Mat rectified, int targetTextPx = 32)
        {
            if (rectified == null || rectified.empty()) return null;

            var grey = new Mat();
            int channels = rectified.channels();
            if (channels == 4) Imgproc.cvtColor(rectified, grey, Imgproc.COLOR_RGBA2GRAY);
            else if (channels == 3) Imgproc.cvtColor(rectified, grey, Imgproc.COLOR_RGB2GRAY);
            else rectified.copyTo(grey);

            // CLAHE rather than equalizeHist. Global equalisation lets one specular highlight on
            // a glossy page drag the whole curve and crush the text into a handful of levels;
            // CLAHE works in tiles and leaves the rest of the page alone.
            using (CLAHE clahe = Imgproc.createCLAHE(2.0, new Size(8, 8)))
            {
                clahe.apply(grey, grey);
            }

            // A rectified page is many lines tall, so estimate a line height rather than
            // treating the whole image as one line the way a single-label crop would.
            float estimatedLinePx = grey.rows() / 25f;
            float upscale = Mathf.Clamp(targetTextPx / Mathf.Max(1f, estimatedLinePx * 0.5f), 1f, 3f);
            if (upscale > 1.01f)
            {
                Imgproc.resize(grey, grey, new Size(0, 0), upscale, upscale, Imgproc.INTER_CUBIC);
            }

            return grey;
        }

        /// <summary>
        /// Copies a Mat into a Texture2D for display or for handing to an OCR service.
        ///
        /// Allocates a texture per call, so it is for debug views and one-shot captures, never
        /// for a per-frame path.
        /// </summary>
        public static Texture2D ToTexture(Mat mat)
        {
            if (mat == null || mat.empty()) return null;
            var tex = new Texture2D(mat.cols(), mat.rows(), TextureFormat.RGBA32, false);
            using var rgba = new Mat();
            int channels = mat.channels();
            if (channels == 1) Imgproc.cvtColor(mat, rgba, Imgproc.COLOR_GRAY2RGBA);
            else if (channels == 3) Imgproc.cvtColor(mat, rgba, Imgproc.COLOR_RGB2RGBA);
            else mat.copyTo(rgba);
            OpenCVForUnity.UnityUtils.Utils.matToTexture2D(rgba, tex);
            return tex;
        }

        public void Dispose()
        {
            _transform?.Dispose();
            _transform = null;
        }
    }
}
