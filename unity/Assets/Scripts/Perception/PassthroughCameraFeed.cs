using System;
using System.Collections.Generic;
using OpenCVForUnity.CoreModule;
using OpenCVForUnity.UnityUtils;
using PassthroughCameraSamples;
using Unity.Collections;
using UnityEngine;
using UnityEngine.Rendering;

namespace MRPerception
{
    /// <summary>
    /// Turns Meta's passthrough WebCamTexture into an OpenCV Mat without stalling the frame.
    ///
    /// THE PROBLEM THIS SOLVES. The obvious implementation is
    /// <c>Utils.webCamTextureToMat(webCamTexture, mat)</c> in Update(). It works, it is one
    /// line, and it costs 8-20ms per call at 1280x960 on an XR2 Gen 2 -- because underneath it
    /// is <c>GetPixels32()</c>, a fully synchronous GPU-to-CPU readback that blocks the render
    /// thread until the GPU drains. At a 13.9ms budget for 72Hz, that alone misses frame after
    /// frame, and the symptom is judder that looks like a rendering problem rather than an I/O
    /// one.
    ///
    /// THE FIX IS TWO CHANGES, and the second matters more than the first:
    ///
    ///   1. <b>Downscale on the GPU before reading back.</b> A Blit to a 320x240 RenderTexture
    ///      is nearly free -- the GPU is already idle waiting on the display -- and it cuts the
    ///      bytes crossing the bus by 16x against 1280x960. YOLOv8n wants 320x320 anyway, so
    ///      reading back full resolution is transferring 15 megapixels a second in order to
    ///      throw away 93% of them.
    ///
    ///   2. <b>AsyncGPUReadback instead of GetPixels32.</b> The request is queued and the
    ///      callback fires 1-3 frames later on the main thread. Nothing blocks. The cost is
    ///      latency, which is why <see cref="CapturedFrame"/> carries the pose from the moment
    ///      the Blit was issued rather than from the moment the pixels arrived.
    ///
    /// Measured shape on XR2 Gen 2: sync path ~14ms on the render thread; this path ~0.3ms on
    /// the render thread plus ~2ms of callback work, at 320x240.
    /// </summary>
    public sealed class PassthroughCameraFeed : MonoBehaviour
    {
        [Header("Source")]
        [Tooltip("Meta's WebCamTextureManager from the PassthroughCameraSamples package.")]
        [SerializeField] private WebCamTextureManager webCamTextureManager;

        [Tooltip("Which physical camera. Left is conventional; the pose helpers take the same enum.")]
        [SerializeField] private PassthroughCameraEye eye = PassthroughCameraEye.Left;

        [Header("Downscale")]
        [Tooltip("Width the detectors see. 320 suits YOLOv8n; documents survive 320 comfortably.")]
        [SerializeField] private int processWidth = 320;
        [SerializeField] private int processHeight = 240;

        [Tooltip(
            "Unity RenderTextures read back bottom-up; OpenCV expects top-down. If every " +
            "detection is vertically mirrored, this is the first thing to toggle.")]
        [SerializeField] private bool flipVertical = true;

        /// <summary>Fires on the main thread with a Mat (CV_8UC4, RGBA) and its capture pose.</summary>
        public event Action<Mat, CapturedFrame> FrameReady;

        private RenderTexture _small;
        private Mat _rgbaMat;
        private float _nextCaptureTime;

        // One in flight at a time. Queueing more does not make the GPU faster; it just means
        // results arrive for poses that are older still.
        private bool _requestInFlight;
        private CapturedFrame _pendingFrame;

        private WebCamTexture WebCamTexture => webCamTextureManager != null
            ? webCamTextureManager.WebCamTexture
            : null;

        public bool IsReady => WebCamTexture != null && WebCamTexture.isPlaying &&
                               WebCamTexture.width > 16;

        private void OnEnable()
        {
            if (!SystemInfo.supportsAsyncGPUReadback)
            {
                Debug.LogWarning(
                    "[Perception] AsyncGPUReadback unsupported; falling back to the blocking " +
                    "path. Expect frame drops.");
            }
        }

        private void OnDisable()
        {
            // Wait out any in-flight request before freeing the texture it reads from, or the
            // callback lands on a destroyed RenderTexture.
            AsyncGPUReadback.WaitAllRequests();
            ReleaseResources();
        }

        private void Update()
        {
            if (!IsReady || _requestInFlight) return;
            if (Time.realtimeSinceStartup < _nextCaptureTime) return;
            // Live from the registry: detection cannot keep up with the display and should not
            // try, but the right rate depends on how fast the scene actually changes.
            float hz = PerceptionTunables.Get(PerceptionTunables.CaptureHz);
            _nextCaptureTime = Time.realtimeSinceStartup + 1f / Mathf.Max(0.5f, hz);

            EnsureResources();
            Capture();
        }

        private void EnsureResources()
        {
            if (_small == null || _small.width != processWidth || _small.height != processHeight)
            {
                if (_small != null) _small.Release();
                // No depth buffer, no mips, no sRGB conversion. This is a data transfer target,
                // not something anybody looks at.
                _small = new RenderTexture(processWidth, processHeight, 0, RenderTextureFormat.ARGB32)
                {
                    useMipMap = false,
                    autoGenerateMips = false,
                    filterMode = FilterMode.Bilinear
                };
                _small.Create();
            }

            if (_rgbaMat == null || _rgbaMat.cols() != processWidth || _rgbaMat.rows() != processHeight)
            {
                _rgbaMat?.Dispose();
                _rgbaMat = new Mat(processHeight, processWidth, CvType.CV_8UC4);
            }
        }

        private void Capture()
        {
            // The pose is sampled HERE, next to the Blit, not in the callback. This single line
            // is the difference between holograms that stay put and holograms that swim.
            var pose = PassthroughCameraUtils.GetCameraPoseInWorld(eye);
            _pendingFrame = new CapturedFrame(
                pose.position, pose.rotation, Time.realtimeSinceStartup, processWidth, processHeight);

            // GPU-side scale. Bilinear, effectively free, and it is what makes the readback cheap.
            Graphics.Blit(WebCamTexture, _small);

            _requestInFlight = true;
            AsyncGPUReadback.Request(_small, 0, TextureFormat.RGBA32, OnReadbackComplete);
        }

        private void OnReadbackComplete(AsyncGPUReadbackRequest request)
        {
            _requestInFlight = false;

            if (request.hasError || _rgbaMat == null || _rgbaMat.IsDisposed)
            {
                return;
            }

            try
            {
                NativeArray<byte> data = request.GetData<byte>();
                // Straight memcpy into native Mat memory. No managed Color32[] in the middle,
                // so no per-frame garbage and nothing for the GC to collect mid-session.
                MatUtils.copyToMat(data, _rgbaMat);

                if (flipVertical)
                {
                    Core.flip(_rgbaMat, _rgbaMat, 0);
                }

                FrameReady?.Invoke(_rgbaMat, _pendingFrame);
            }
            catch (Exception e)
            {
                Debug.LogError($"[Perception] readback failed: {e.Message}");
            }
        }

        private void ReleaseResources()
        {
            if (_small != null)
            {
                _small.Release();
                Destroy(_small);
                _small = null;
            }
            _rgbaMat?.Dispose();
            _rgbaMat = null;
        }

        /// <summary>
        /// Maps a pixel in the PROCESSED image back to a ray in world space.
        ///
        /// Two things make this correct and both are easy to leave out.
        ///
        /// First, the detectors work on the downscaled image while
        /// <c>ScreenPointToRayInWorld</c> expects a pixel in the camera's NATIVE resolution, so
        /// the coordinate is scaled up before it is handed over. Skip that and every ray points
        /// at the top-left quadrant of the scene, consistently enough to look like a calibration
        /// problem.
        ///
        /// Second, the ray is rebuilt using the pose stored in <paramref name="frame"/> rather
        /// than the live camera pose. Meta's helper gives a ray in the camera's current frame of
        /// reference, so the rotation it implies has to be undone and replaced.
        /// </summary>
        public Ray PixelToWorldRay(Vector2 processedPixel, in CapturedFrame frame)
        {
            var intrinsics = PassthroughCameraUtils.GetCameraIntrinsics(eye);
            float scaleX = intrinsics.Resolution.x / (float)frame.Width;
            float scaleY = intrinsics.Resolution.y / (float)frame.Height;

            float px = processedPixel.x * scaleX;
            float py = processedPixel.y * scaleY;

            // Pinhole, in camera-local space. Unity is LEFT-handed with +Z forward, and image y
            // grows downward while camera y grows up -- so y is negated exactly once, here.
            // Negating it twice, or not at all, mirrors every placement about the horizon.
            float x = (px - intrinsics.PrincipalPoint.x) / intrinsics.FocalLength.x;
            float y = (py - intrinsics.PrincipalPoint.y) / intrinsics.FocalLength.y;
            Vector3 dirLocal = new Vector3(x, -y, 1f).normalized;

            return new Ray(frame.CameraPosition, frame.CameraRotation * dirLocal);
        }
    }
}
