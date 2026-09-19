using System;
using UnityEngine;
#if UNITY_ANDROID && !UNITY_EDITOR
using UnityEngine.Android;
#endif

namespace MRPerception
{
    /// <summary>
    /// Requests the passthrough camera permission, which is NOT the normal Android camera one.
    ///
    /// THE FAILURE THIS PREVENTS, and it is the single most wasteful bug in this whole stack:
    /// without <c>horizonos.permission.HEADSET_CAMERA</c>, <c>WebCamTexture</c> starts happily,
    /// reports <c>isPlaying == true</c>, has a sensible width and height, and delivers
    /// <b>solid black frames forever</b>. No exception. No warning. Nothing in logcat.
    ///
    /// Every downstream symptom is a lie. The detector finds nothing, so you tune thresholds.
    /// The contour finder finds nothing, so you tune Canny. Eventually somebody dumps the Mat to
    /// a RawImage and discovers it has been black the entire time.
    ///
    /// Declaring it in the manifest is necessary and NOT sufficient -- Horizon OS treats it as a
    /// dangerous permission, so it must also be requested at runtime and granted by the user in
    /// a headset dialog.
    ///
    /// Call this before enabling <see cref="PassthroughCameraFeed"/>, and do it during a menu or
    /// a loading step: the dialog is modal and takes over the view, which is not something you
    /// want appearing the first time a judge points at a table.
    /// </summary>
    public sealed class CameraPermissions : MonoBehaviour
    {
        public const string HeadsetCameraPermission = "horizonos.permission.HEADSET_CAMERA";

        [Tooltip("Ask as soon as this component wakes. Turn off to drive it from your own flow.")]
        [SerializeField] private bool requestOnStart = true;

        [Tooltip("Enabled once permission is granted. Point this at the PassthroughCameraFeed.")]
        [SerializeField] private MonoBehaviour[] enableWhenGranted;

        /// <summary>Fires with the outcome, exactly once, on the main thread.</summary>
        public event Action<bool> PermissionResolved;

        public bool IsGranted { get; private set; }
        public bool HasResolved { get; private set; }

        private void Start()
        {
            if (requestOnStart) Request();
        }

        public void Request()
        {
            if (HasResolved) return;

#if UNITY_ANDROID && !UNITY_EDITOR
            if (Permission.HasUserAuthorizedPermission(HeadsetCameraPermission))
            {
                Resolve(true);
                return;
            }

            var callbacks = new PermissionCallbacks();
            callbacks.PermissionGranted += _ => Resolve(true);
            callbacks.PermissionDenied += _ => Resolve(false);
            // Treated as a denial: the user ticked "don't ask again", so there is no path to a
            // grant from inside the app and pretending otherwise just hangs the flow.
            callbacks.PermissionDeniedAndDontAskAgain += _ => Resolve(false);

            Permission.RequestUserPermission(HeadsetCameraPermission, callbacks);
#else
            // In the Editor there is no Horizon OS to ask. Resolve true so the rest of the
            // pipeline can be exercised against a desktop webcam or a recorded clip.
            Resolve(true);
#endif
        }

        private void Resolve(bool granted)
        {
            if (HasResolved) return;
            HasResolved = true;
            IsGranted = granted;

            if (granted)
            {
                foreach (MonoBehaviour behaviour in enableWhenGranted)
                {
                    if (behaviour != null) behaviour.enabled = true;
                }
            }
            else
            {
                Debug.LogError(
                    "[Perception] HEADSET_CAMERA denied. WebCamTexture will return black " +
                    "frames with no error. Check the manifest declares the permission AND that " +
                    "the user accepted the dialog.");
            }

            PermissionResolved?.Invoke(granted);
        }
    }
}
