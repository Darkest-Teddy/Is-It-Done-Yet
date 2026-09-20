using IsItDoneYet.Design;
using UnityEngine;

namespace IsItDoneYet.App
{
    /// <summary>
    /// A small glyph that is visible whenever a frame is being captured, and invisible when
    /// none is.
    ///
    /// Not a legal checkbox. A headset camera is pointed at somebody's home and the people in
    /// it, and the person wearing it is the only one who can see what the app is doing. A
    /// persistent, honest indicator is the minimum -- and it is driven by whether the uploader
    /// is ACTUALLY capturing rather than by a flag somebody sets, so it cannot say "off" while
    /// frames are going out.
    ///
    /// It pulses, slowly, well under the 3Hz flash limit -- enough to catch the eye without
    /// becoming something you stop noticing.
    /// </summary>
    public class CameraIndicator : MonoBehaviour
    {
        public FrameUploader Uploader;
        public IconQuad Glyph;
        [Tooltip("Cycles per second. Held far below the 3Hz ceiling in the design tokens.")]
        public float PulseHz = 0.5f;

        void Update()
        {
            var capturing = Uploader != null && Uploader.IsCapturing;

            if (Glyph == null) return;
            if (Glyph.gameObject.activeSelf != capturing) Glyph.gameObject.SetActive(capturing);
            if (!capturing) return;

            var theme = ThemeManager.Instance;
            // SAFE mode stops looping motion everywhere else; the camera indicator keeps
            // working, at a steady opacity. A privacy indicator is not decoration and is not a
            // theme's to silence.
            var animated = theme == null || theme.LoopingAnimation;
            Glyph.Alpha = animated ? Mathf.Lerp(0.55f, 1f, Mathf.PingPong(Time.unscaledTime * PulseHz * 2f, 1f)) : 1f;
            Glyph.Refresh();
        }
    }
}
