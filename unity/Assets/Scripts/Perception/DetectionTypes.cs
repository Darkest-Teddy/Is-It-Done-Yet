using UnityEngine;

namespace MRPerception
{
    /// <summary>
    /// A frame, plus the camera pose that was true when it was captured.
    ///
    /// The pose is the important half and it is the half normally left out. Between the shutter
    /// and a usable detection you spend a GPU readback (1-3 frames) and an inference (40-90ms on
    /// XR2). At 72Hz with a head turning at a modest 60 deg/sec that is 6-10 degrees of rotation,
    /// which at one metre is 10-17cm of placement error. Using the CURRENT pose to unproject a
    /// box from a frame that old produces holograms that sit still while you hold still and swim
    /// when you turn -- which reads as broken tracking, so people go and tune the wrong thing.
    ///
    /// Carrying the pose with the pixels makes that mistake unavailable.
    /// </summary>
    public readonly struct CapturedFrame
    {
        public readonly Vector3 CameraPosition;
        public readonly Quaternion CameraRotation;
        /// <summary>Time.realtimeSinceStartup at the moment the GPU copy was issued.</summary>
        public readonly float CaptureTime;
        /// <summary>Size of the DOWNSCALED image the detectors actually see.</summary>
        public readonly int Width;
        public readonly int Height;

        public CapturedFrame(Vector3 position, Quaternion rotation, float time, int width, int height)
        {
            CameraPosition = position;
            CameraRotation = rotation;
            CaptureTime = time;
            Width = width;
            Height = height;
        }
    }

    /// <summary>One detected thing, still in 2D pixel space of the captured frame.</summary>
    public readonly struct Detection2D
    {
        public readonly Rect PixelRect;
        public readonly string Label;
        public readonly float Confidence;
        public readonly DetectionKind Kind;
        /// <summary>
        /// The four corners, for documents. Ordered TL, TR, BR, BL. Null for food.
        /// </summary>
        public readonly Vector2[] Corners;

        public Detection2D(Rect rect, string label, float confidence, DetectionKind kind, Vector2[] corners = null)
        {
            PixelRect = rect;
            Label = label;
            Confidence = confidence;
            Kind = kind;
            Corners = corners;
        }

        /// <summary>
        /// Where the object meets a surface, which is what you actually want to raycast.
        ///
        /// The centre of a box floats inside the object and its ray lands BEYOND it, on the far
        /// side, by roughly half the object's depth. For a bowl on a table that is several
        /// centimetres of consistent forward bias that no smoothing removes. The bottom-centre
        /// pixel is the one point on the box that lies on the supporting surface.
        ///
        /// Documents are the exception: they ARE the surface, so their centre is correct.
        /// </summary>
        public Vector2 AnchorPixel =>
            Kind == DetectionKind.Document
                ? PixelRect.center
                : new Vector2(PixelRect.center.x, PixelRect.yMax);
    }

    public enum DetectionKind
    {
        Food,
        Document
    }

    /// <summary>A detection that has been placed in the world.</summary>
    public readonly struct Detection3D
    {
        public readonly Vector3 Position;
        public readonly Quaternion Rotation;
        /// <summary>Metres. Estimated from the 2D box and the hit distance.</summary>
        public readonly Vector2 SizeMeters;
        public readonly Detection2D Source;

        public Detection3D(Vector3 position, Quaternion rotation, Vector2 sizeMeters, Detection2D source)
        {
            Position = position;
            Rotation = rotation;
            SizeMeters = sizeMeters;
            Source = source;
        }
    }
}
