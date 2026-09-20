using Meta.XR;
using UnityEngine;
using UnityEngine.Android;

namespace IsItDoneYet.App
{
    /// <summary>
    /// The device source: Meta's <c>PassthroughCameraAccess</c>.
    ///
    /// Two permissions, and BOTH are needed. <c>android.permission.CAMERA</c> is the familiar
    /// one; <c>horizonos.permission.HEADSET_CAMERA</c> is Horizon OS's own gate on the
    /// passthrough sensors, and without it the API succeeds and every frame is black. A black
    /// frame is not an error anywhere in the stack -- it uploads fine, the model describes an
    /// empty scene, and the app presents as bad at seeing rather than as unpermitted. That
    /// failure has cost this project's sibling an afternoon before, which is why the constant
    /// below is taken from the SDK rather than typed out.
    /// </summary>
    public class PassthroughFrameSource : MonoBehaviour, IFrameSource
    {
        [SerializeField] PassthroughCameraAccess _camera;
        [Tooltip("Left is the conventional choice; either works. Two instances are needed for both.")]
        [SerializeField] PassthroughCameraAccess.CameraPositionType _position = PassthroughCameraAccess.CameraPositionType.Left;

        /// <summary>
        /// From <c>OVRPermissionsRequester.PassthroughCameraAccessPermission</c> in the
        /// installed SDK, not from memory or a blog post. The string changed once already.
        /// </summary>
        public const string HeadsetCameraPermission = OVRPermissionsRequester.PassthroughCameraAccessPermission;
        public const string CameraPermission = "android.permission.CAMERA";

        bool _requested;
        Pose _poseAtCapture;

        public bool IsReady => _camera != null && _camera.IsPlaying && HasPermissions;
        public Vector2Int Resolution => _camera != null ? _camera.CurrentResolution : Vector2Int.zero;

        public static bool HasPermissions
        {
            get
            {
#if UNITY_ANDROID && !UNITY_EDITOR
                return Permission.HasUserAuthorizedPermission(CameraPermission)
                    && Permission.HasUserAuthorizedPermission(HeadsetCameraPermission);
#else
                // In the Editor there is nothing to grant and nothing to deny. Reporting true
                // would make the Editor take the device path and find no camera; reporting
                // false is honest and routes to the folder source.
                return false;
#endif
            }
        }

        /// <summary>
        /// Asks, once. Called from the consent screen, never on startup.
        ///
        /// A permission dialog thrown at somebody in the first second of putting a headset on
        /// is a dialog they dismiss without reading. The first-run consent card explains what
        /// the camera is for and what leaves the device, and only then does this run.
        /// </summary>
        public void RequestPermissions()
        {
            if (_requested) return;
            _requested = true;
#if UNITY_ANDROID && !UNITY_EDITOR
            var wanted = new[] { CameraPermission, HeadsetCameraPermission };
            Permission.RequestUserPermissions(wanted);
#endif
        }

        public void StartSource()
        {
            if (_camera == null)
            {
                _camera = GetComponent<PassthroughCameraAccess>();
                if (_camera == null) _camera = gameObject.AddComponent<PassthroughCameraAccess>();
            }
            _camera.CameraPosition = _position;
            // 1280x960 is the SDK default and is already far more than a 512px upload needs.
            // Requesting less does not obviously help: the sensor's supported list is short and
            // an unsupported request silently falls back anyway.
            _camera.enabled = true;
        }

        public void StopSource()
        {
            if (_camera != null) _camera.enabled = false;
        }

        public Texture GetTexture()
        {
            if (!IsReady) return null;
            // Snapped at the same moment as the texture, so the two agree. Reading the pose in
            // the callback that handles the RESPONSE is the mistake this exists to prevent.
            _poseAtCapture = _camera.GetCameraPose();
            return _camera.GetTexture();
        }

        public Pose GetPose() => _poseAtCapture;
    }
}
