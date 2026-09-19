using UnityEngine;

namespace MRPerception
{
    /// <summary>
    /// A wireframe bounding box and a label, built entirely at runtime.
    ///
    /// Exists so the pipeline has something to draw before anybody opens the Unity editor to
    /// author a prefab. <see cref="MRPerceptionManager"/> skips instantiation when its prefab
    /// fields are null, which means a correctly working detector shows you absolutely nothing --
    /// an unhelpful failure to be staring at while you are trying to establish whether the
    /// detection half works.
    ///
    /// Wireframe rather than a solid box, and that is a visibility decision rather than an
    /// aesthetic one. A translucent solid over passthrough dims the real object underneath,
    /// which is precisely what the user is trying to look at. Edges mark the extent and leave
    /// the middle alone.
    ///
    /// Everything here uses APIs that exist in both the built-in pipeline and URP, so it drops
    /// into a project without a render-pipeline conversation.
    /// </summary>
    public sealed class DetectionVisualizer : MonoBehaviour
    {
        [SerializeField] private Color foodColor = new Color(0.56f, 0.88f, 0.42f);
        [SerializeField] private Color documentColor = new Color(0.42f, 0.78f, 0.88f);
        [SerializeField] private float lineWidth = 0.004f;
        [SerializeField] private float labelHeight = 0.03f;

        private LineRenderer _lines;
        private TextMesh _label;
        private Transform _labelTransform;
        private Camera _mainCamera;

        /// <summary>
        /// Builds one visualizer under <paramref name="parent"/>.
        ///
        /// Static factory rather than a prefab reference so the manager can fall back to this
        /// with no scene setup at all.
        /// </summary>
        public static DetectionVisualizer Create(Transform parent, DetectionKind kind)
        {
            var go = new GameObject($"Detection_{kind}");
            go.transform.SetParent(parent, false);
            var vis = go.AddComponent<DetectionVisualizer>();
            vis.Build(kind);
            return vis;
        }

        private void Build(DetectionKind kind)
        {
            Color color = kind == DetectionKind.Document ? documentColor : foodColor;

            _lines = gameObject.AddComponent<LineRenderer>();
            _lines.useWorldSpace = false;
            _lines.loop = false;
            _lines.widthMultiplier = lineWidth;
            _lines.numCapVertices = 2;
            // Unlit and unaffected by scene lighting: an MR overlay that dims when the user
            // turns away from a window is an overlay that looks like a bug.
            _lines.material = new Material(FindUnlitShader()) { color = color };
            _lines.startColor = color;
            _lines.endColor = color;
            _lines.positionCount = BoxPath.Length;
            _lines.SetPositions(BoxPath);
            // Shadows on a wireframe are pure cost for no pixels anybody sees.
            _lines.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            _lines.receiveShadows = false;

            var labelGo = new GameObject("Label");
            _labelTransform = labelGo.transform;
            _labelTransform.SetParent(transform, false);
            _label = labelGo.AddComponent<TextMesh>();
            _label.characterSize = 0.01f;
            _label.fontSize = 96;          // large then scaled down, so glyphs stay crisp
            _label.anchor = TextAnchor.LowerCenter;
            _label.alignment = TextAlignment.Center;
            _label.color = color;

            _mainCamera = Camera.main;
        }

        /// <summary>
        /// Positions, orients and scales the box, and points the label at the viewer.
        ///
        /// The label is a child but is billboarded in WORLD space and given an unscaled
        /// transform, because it is parented to a box whose scale is the object's real size --
        /// inheriting that would stretch the text by however wide the banana happens to be.
        /// </summary>
        public void Apply(Vector3 position, Quaternion rotation, Vector3 size, string text)
        {
            transform.SetPositionAndRotation(position, rotation);
            transform.localScale = size;

            if (_labelTransform != null)
            {
                // Sit just above the top face, in local units, then undo the parent's scale.
                _labelTransform.localPosition = new Vector3(0f, 0.5f + labelHeight / Mathf.Max(0.001f, size.y), 0f);
                Vector3 lossy = transform.lossyScale;
                _labelTransform.localScale = new Vector3(
                    1f / Mathf.Max(0.0001f, lossy.x),
                    1f / Mathf.Max(0.0001f, lossy.y),
                    1f / Mathf.Max(0.0001f, lossy.z));

                if (_mainCamera == null) _mainCamera = Camera.main;
                if (_mainCamera != null)
                {
                    // Face the viewer, upright. LookRotation straight at the camera would tilt
                    // the text whenever the user looks up or down at the table.
                    Vector3 toCamera = _labelTransform.position - _mainCamera.transform.position;
                    toCamera.y = 0f;
                    if (toCamera.sqrMagnitude > 0.0001f)
                    {
                        _labelTransform.rotation = Quaternion.LookRotation(toCamera.normalized, Vector3.up);
                    }
                }
            }

            if (_label != null && _label.text != text) _label.text = text;
        }

        public void SetVisible(bool visible)
        {
            if (gameObject.activeSelf != visible) gameObject.SetActive(visible);
        }

        /// <summary>
        /// A unit cube's twelve edges as one continuous polyline.
        ///
        /// One LineRenderer rather than twelve, because each renderer is a draw call and a
        /// handful of tracked objects would otherwise put fifty draw calls on the frame. The
        /// path doubles back along a few edges to stay connected, which costs four extra
        /// vertices and saves eleven draw calls.
        /// </summary>
        private static readonly Vector3[] BoxPath =
        {
            new(-0.5f, -0.5f, -0.5f), new( 0.5f, -0.5f, -0.5f),
            new( 0.5f, -0.5f,  0.5f), new(-0.5f, -0.5f,  0.5f),
            new(-0.5f, -0.5f, -0.5f),
            new(-0.5f,  0.5f, -0.5f), new( 0.5f,  0.5f, -0.5f),
            new( 0.5f, -0.5f, -0.5f), new( 0.5f,  0.5f, -0.5f),
            new( 0.5f,  0.5f,  0.5f), new( 0.5f, -0.5f,  0.5f),
            new( 0.5f,  0.5f,  0.5f), new(-0.5f,  0.5f,  0.5f),
            new(-0.5f, -0.5f,  0.5f), new(-0.5f,  0.5f,  0.5f),
            new(-0.5f,  0.5f, -0.5f)
        };

        /// <summary>URP and the built-in pipeline disagree on shader names; try both.</summary>
        private static Shader FindUnlitShader()
        {
            return Shader.Find("Universal Render Pipeline/Unlit")
                   ?? Shader.Find("Unlit/Color")
                   ?? Shader.Find("Sprites/Default");
        }
    }
}
