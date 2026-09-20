using System.Collections.Generic;
using System.IO;
using UnityEngine;

namespace IsItDoneYet.App
{
    /// <summary>
    /// A folder of photographs standing in for the passthrough cameras.
    ///
    /// This is what makes the perception path developable on a Mac. Everything downstream --
    /// downscale, JPEG encode, upload, response parse, three-frame vote, scoring, toast -- runs
    /// identically against a still of somebody's actual countertop, in Play mode, with the
    /// simulator, in under a second per iteration.
    ///
    /// It is a development tool and says so: it only loads from <c>Application.dataPath</c>, it
    /// never ships a frame the cook did not choose, and it is excluded from release builds along
    /// with the Design Gallery.
    /// </summary>
    public class ImageFolderFrameSource : MonoBehaviour, IFrameSource
    {
        [Tooltip("Relative to the project folder. JPEGs or PNGs of a countertop.")]
        public string FolderRelativeToProject = "dev-frames";

        [Tooltip("Seconds per image, so a sequence plays like a slow camera.")]
        public float SecondsPerImage = 3f;

        [Tooltip("Stands in for the camera pose. The Editor has no headset to ask.")]
        public Transform PoseProxy;

        readonly List<Texture2D> _frames = new List<Texture2D>();
        int _index;
        float _nextAdvance;
        bool _started;

        public bool IsReady => _started && _frames.Count > 0;
        public Vector2Int Resolution => IsReady ? new Vector2Int(_frames[_index].width, _frames[_index].height) : Vector2Int.zero;

        public void StartSource()
        {
            if (_started) return;
            _started = true;

            var folder = Path.GetFullPath(Path.Combine(Application.dataPath, "..", FolderRelativeToProject));
            if (!Directory.Exists(folder))
            {
                Debug.LogWarning($"[Frames] no dev frame folder at {folder}. " +
                                 "Drop a few countertop photos there to exercise the coach in the Editor.");
                return;
            }

            foreach (var file in Directory.GetFiles(folder))
            {
                var extension = Path.GetExtension(file).ToLowerInvariant();
                if (extension != ".jpg" && extension != ".jpeg" && extension != ".png") continue;

                // Non-readable would be cheaper, but the uploader has to read these pixels back
                // and a non-readable texture fails that at runtime rather than here.
                var texture = new Texture2D(2, 2, TextureFormat.RGBA32, false);
                if (texture.LoadImage(File.ReadAllBytes(file))) _frames.Add(texture);
                else Destroy(texture);
            }

            Debug.Log($"[Frames] {_frames.Count} development frame(s) from {folder}");
        }

        public void StopSource()
        {
            foreach (var frame in _frames) Destroy(frame);
            _frames.Clear();
            _started = false;
        }

        void Update()
        {
            if (!IsReady || _frames.Count < 2) return;
            if (Time.time < _nextAdvance) return;
            _nextAdvance = Time.time + Mathf.Max(0.2f, SecondsPerImage);
            _index = (_index + 1) % _frames.Count;
        }

        public Texture GetTexture() => IsReady ? _frames[_index] : null;

        public Pose GetPose() =>
            PoseProxy != null ? new Pose(PoseProxy.position, PoseProxy.rotation) : new Pose(Vector3.zero, Quaternion.identity);
    }
}
