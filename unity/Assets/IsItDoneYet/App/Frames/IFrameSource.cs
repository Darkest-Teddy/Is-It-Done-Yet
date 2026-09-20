using UnityEngine;

namespace IsItDoneYet.App
{
    /// <summary>
    /// Where a frame comes from.
    ///
    /// Two implementations, and the second one is the reason this interface exists. On the
    /// device the frames come from the passthrough cameras. On a Mac, in the Editor, there are
    /// no passthrough cameras and never will be -- so without a second source, the entire
    /// perception path (downscale, encode, upload, parse, vote, score) could only ever be
    /// exercised by putting the headset on. That is a ten-minute iteration loop for a bug in a
    /// JSON field name.
    ///
    /// <see cref="ImageFolderFrameSource"/> makes the whole pipeline testable in Play mode with
    /// a folder of kitchen photographs.
    /// </summary>
    public interface IFrameSource
    {
        /// <summary>False until permission is granted and a first frame has arrived.</summary>
        bool IsReady { get; }

        /// <summary>Resolution of whatever <see cref="GetTexture"/> returns.</summary>
        Vector2Int Resolution { get; }

        /// <summary>
        /// The latest frame. Never cached by the caller -- the underlying buffer is reused every
        /// capture, so a reference held across a frame boundary points at different pixels than
        /// it did when it was taken.
        /// </summary>
        Texture GetTexture();

        /// <summary>
        /// The camera pose AT THE MOMENT OF THE FRAME, not now.
        ///
        /// Between a capture and its answer there is a readback, an encode, an upload and an
        /// inference -- comfortably a second. Anything placed using the live pose lands where
        /// the cook is looking now rather than where the camera was looking then.
        /// </summary>
        Pose GetPose();

        void StartSource();
        void StopSource();
    }
}
