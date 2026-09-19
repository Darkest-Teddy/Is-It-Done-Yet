using System.Collections.Generic;
using System.Text;
using OpenCVForUnity.CoreModule;
using UnityEngine;

namespace MRPerception
{
    /// <summary>
    /// On-device tuning. A world-locked panel, driven entirely from the right thumbstick.
    ///
    /// THREE DESIGN DECISIONS, each of which is the reason this works at all:
    ///
    /// <b>No Canvas, no EventSystem, no OVRRaycaster.</b> The conventional answer is a
    /// world-space uGUI Canvas with an XR raycaster and an input module. That needs scene
    /// authoring, a font asset, a correctly configured EventSystem, and a pointer setup that
    /// differs between OVR, XRI and the new Input System -- and when any one of those is wrong
    /// the panel renders perfectly and simply does not respond, which is a miserable thing to
    /// debug when you are ALSO debugging the vision stack. TextMesh and a Quad need none of it
    /// and cannot fail that way.
    ///
    /// <b>Thumbstick, not ray-pointing.</b> Aiming a laser at a small slider while wearing a
    /// headset is slow and imprecise, and you cannot do it while looking at the thing you are
    /// tuning. The whole point is to nudge a Canny threshold while watching the edge map change,
    /// so the control has to be eyes-free. Up/down picks the row, left/right moves the value.
    ///
    /// <b>The debug image is the feature.</b> Sliders are guesses without it. Seeing the live
    /// edge map is what turns "detection is not working" into "the edges are broken up, so
    /// dilate more" in about four seconds.
    ///
    /// Controls, right hand unless noted:
    ///   thumbstick up/down   select parameter
    ///   thumbstick L/R       adjust (hold to repeat, accelerates)
    ///   A                    cycle debug image: off, camera, edges
    ///   B                    reset the selected parameter
    ///   grip + B             reset everything
    ///   X (left)             summon the panel in front of you / hide it
    /// </summary>
    public sealed class PerceptionDebugUI : MonoBehaviour
    {
        [Header("Sources (optional -- readouts degrade gracefully)")]
        [SerializeField] private PassthroughCameraFeed feed;
        [SerializeField] private MRPerceptionManager manager;
        [SerializeField] private CameraPermissions permissions;

        [Header("Placement")]
        [SerializeField] private float summonDistance = 0.7f;
        [SerializeField] private float panelWidth = 0.42f;

        [Header("Input")]
        [Tooltip("Thumbstick deflection before a nudge registers.")]
        [SerializeField] private float deadZone = 0.5f;
        [SerializeField] private float firstRepeatDelay = 0.35f;
        [SerializeField] private float repeatInterval = 0.08f;

        private enum ImageMode { Off, Camera, Edges }

        private Transform _panel;
        private TextMesh _text;
        private MeshRenderer _imageQuad;
        private Texture2D _imageTexture;
        private Camera _head;

        private int _selected;
        private ImageMode _imageMode = ImageMode.Off;
        private float _nextRepeat;
        private int _lastVerticalDir;
        private float _statusTimer;
        private bool _dirty = true;

        private readonly StringBuilder _sb = new(2048);
        private readonly List<PerceptionTunables.Tunable> _rows = new();

        private float _smoothedFps = 72f;

        private void Start()
        {
            _head = Camera.main;
            _rows.AddRange(PerceptionTunables.All);
            Build();
            Summon();
        }

        private void OnDestroy()
        {
            // Persist on the way out. Losing an evening of tuning to a headset sleeping with the
            // app foregrounded is the failure this is guarding against.
            PerceptionTunables.Save();
            if (_imageTexture != null) Destroy(_imageTexture);
        }

        private void OnApplicationPause(bool paused)
        {
            if (paused) PerceptionTunables.Save();
        }

        private void Build()
        {
            var root = new GameObject("PerceptionDebugPanel");
            _panel = root.transform;
            _panel.SetParent(transform, false);

            // Backing plate: unlit dark quad. Without it the text is unreadable against a bright
            // real room, which is most rooms you would be demoing in.
            var plate = GameObject.CreatePrimitive(PrimitiveType.Quad);
            plate.name = "Plate";
            plate.transform.SetParent(_panel, false);
            plate.transform.localScale = new Vector3(panelWidth, panelWidth * 0.95f, 1f);
            plate.transform.localPosition = new Vector3(0f, 0f, 0.002f);
            Destroy(plate.GetComponent<Collider>());   // nothing raycasts against this
            plate.GetComponent<MeshRenderer>().material =
                MakeUnlit(new Color(0.03f, 0.04f, 0.05f, 0.88f), transparent: true);

            var textGo = new GameObject("Text");
            textGo.transform.SetParent(_panel, false);
            textGo.transform.localPosition = new Vector3(-panelWidth * 0.47f, panelWidth * 0.45f, 0f);
            _text = textGo.AddComponent<TextMesh>();
            _text.anchor = TextAnchor.UpperLeft;
            _text.alignment = TextAlignment.Left;
            _text.characterSize = 0.006f;
            _text.fontSize = 64;              // large then scaled down keeps glyphs crisp
            _text.lineSpacing = 1.05f;
            _text.color = new Color(0.91f, 0.93f, 0.95f);
            _text.GetComponent<MeshRenderer>().sortingOrder = 1;

            var quad = GameObject.CreatePrimitive(PrimitiveType.Quad);
            quad.name = "DebugImage";
            quad.transform.SetParent(_panel, false);
            // Bottom-right of the plate, 4:3 to match the capture aspect.
            quad.transform.localScale = new Vector3(panelWidth * 0.42f, panelWidth * 0.315f, 1f);
            quad.transform.localPosition =
                new Vector3(panelWidth * 0.25f, -panelWidth * 0.28f, -0.001f);
            Destroy(quad.GetComponent<Collider>());
            _imageQuad = quad.GetComponent<MeshRenderer>();
            _imageQuad.material = MakeUnlit(Color.white, transparent: false);
            _imageQuad.enabled = false;
        }

        private static Material MakeUnlit(Color color, bool transparent)
        {
            Shader shader = Shader.Find("Universal Render Pipeline/Unlit")
                            ?? Shader.Find("Unlit/Transparent")
                            ?? Shader.Find("Sprites/Default");
            var m = new Material(shader) { color = color };
            if (transparent)
            {
                // Works across pipelines: the names differ but setting both is harmless.
                m.SetFloat("_Surface", 1f);
                m.SetInt("_SrcBlend", (int)UnityEngine.Rendering.BlendMode.SrcAlpha);
                m.SetInt("_DstBlend", (int)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
                m.SetInt("_ZWrite", 0);
                m.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Transparent;
            }
            return m;
        }

        private void Update()
        {
            if (_head == null) _head = Camera.main;

            HandleInput();

            _smoothedFps += (1f / Mathf.Max(0.0001f, Time.unscaledDeltaTime) - _smoothedFps) * 0.05f;

            // The parameter list only changes on input; the status line changes constantly.
            // Rebuilding the whole string every frame would allocate a couple of kilobytes at
            // 72Hz for no reason, so the status line drives a slow timer and edits rebuild
            // immediately.
            _statusTimer -= Time.unscaledDeltaTime;
            if (_dirty || _statusTimer <= 0f)
            {
                _statusTimer = 0.25f;
                _dirty = false;
                Redraw();
            }

            UpdateDebugImage();
        }

        private void HandleInput()
        {
            Vector2 stick = OVRInput.Get(OVRInput.Axis2D.SecondaryThumbstick);

#if UNITY_EDITOR
            // Arrow keys, so the whole flow is exercisable without putting the headset on.
            if (Input.GetKey(KeyCode.UpArrow)) stick.y = 1f;
            if (Input.GetKey(KeyCode.DownArrow)) stick.y = -1f;
            if (Input.GetKey(KeyCode.LeftArrow)) stick.x = -1f;
            if (Input.GetKey(KeyCode.RightArrow)) stick.x = 1f;
#endif

            // Vertical selection is edge-triggered: a list that scrolls while you hold the stick
            // overshoots every time, because the list is short and the hold is never that brief.
            int vertical = Mathf.Abs(stick.y) > deadZone ? (int)Mathf.Sign(stick.y) : 0;
            if (vertical != 0 && vertical != _lastVerticalDir)
            {
                _selected = (_selected - vertical + _rows.Count) % _rows.Count;
                _dirty = true;
            }
            _lastVerticalDir = vertical;

            // Horizontal adjustment repeats, and accelerates past full deflection, because some
            // ranges take fifty steps to cross and nobody wants to click fifty times.
            int horizontal = Mathf.Abs(stick.x) > deadZone ? (int)Mathf.Sign(stick.x) : 0;
            if (horizontal == 0)
            {
                _nextRepeat = 0f;
            }
            else if (Time.unscaledTime >= _nextRepeat)
            {
                bool first = _nextRepeat == 0f;
                int magnitude = Mathf.Abs(stick.x) > 0.92f ? 5 : 1;
                PerceptionTunables.Nudge(_rows[_selected].Key, horizontal * magnitude);
                _nextRepeat = Time.unscaledTime + (first ? firstRepeatDelay : repeatInterval);
                _dirty = true;
            }

            if (OVRInput.GetDown(OVRInput.Button.One))
            {
                _imageMode = (ImageMode)(((int)_imageMode + 1) % 3);
                _imageQuad.enabled = _imageMode != ImageMode.Off;
                _dirty = true;
            }

            if (OVRInput.GetDown(OVRInput.Button.Two))
            {
                if (OVRInput.Get(OVRInput.Button.SecondaryHandTrigger)) PerceptionTunables.ResetAll();
                else PerceptionTunables.Reset(_rows[_selected].Key);
                PerceptionTunables.Save();
                _dirty = true;
            }

            if (OVRInput.GetDown(OVRInput.Button.Three))
            {
                if (_panel.gameObject.activeSelf) _panel.gameObject.SetActive(false);
                else Summon();
            }
        }

        /// <summary>
        /// Puts the panel in front of the viewer and leaves it there.
        ///
        /// World-locked rather than head-following on purpose: a panel that chases your gaze is
        /// impossible to look away from, and the entire job here is to look at the TABLE while
        /// adjusting a number. Summoning is an explicit act.
        /// </summary>
        private void Summon()
        {
            _panel.gameObject.SetActive(true);
            if (_head == null) return;

            Vector3 forward = _head.transform.forward;
            forward.y = 0f;
            if (forward.sqrMagnitude < 0.001f) forward = Vector3.forward;
            forward.Normalize();

            _panel.position = _head.transform.position + forward * summonDistance - Vector3.up * 0.15f;
            _panel.rotation = Quaternion.LookRotation(forward, Vector3.up);
            // Quads face -Z in Unity, so the panel has to be turned to face the viewer.
            _panel.Rotate(0f, 180f, 0f, Space.Self);
        }

        private void Redraw()
        {
            _sb.Clear();

            _sb.Append("PERCEPTION   ")
               .Append(Mathf.RoundToInt(_smoothedFps)).Append("fps");
            if (manager != null)
            {
                _sb.Append("   det ").Append(Mathf.RoundToInt(manager.LastDetectMs)).Append("ms")
                   .Append("   ").Append(manager.TrackedCount).Append(" obj");
            }
            _sb.Append('\n');

            string camera = feed == null ? "no feed" : feed.IsReady ? "camera ok" : "camera WAITING";
            string perm = permissions == null
                ? ""
                : permissions.HasResolved
                    ? (permissions.IsGranted ? "" : "  PERMISSION DENIED")
                    : "  permission pending";
            _sb.Append(camera).Append(perm)
               .Append("   image: ").Append(_imageMode).Append('\n');
            _sb.Append("----------------------------------------\n");

            string group = null;
            for (int i = 0; i < _rows.Count; i++)
            {
                PerceptionTunables.Tunable t = _rows[i];
                if (t.Group != group)
                {
                    group = t.Group;
                    _sb.Append('\n').Append(group).Append('\n');
                }

                bool selected = i == _selected;
                _sb.Append(selected ? "> " : "  ");
                _sb.Append(t.Label.PadRight(22));
                _sb.Append(PerceptionTunables.Format(t).PadLeft(6));
                // A marker rather than a colour, because TextMesh cannot colour one line and
                // rich text on a per-row basis is more trouble than a caret is worth.
                if (!Mathf.Approximately(t.Value, t.Default)) _sb.Append(" *");
                _sb.Append('\n');
            }

            _sb.Append("\nstick: select / adjust   A: image   B: reset");
            _text.text = _sb.ToString();
        }

        private void UpdateDebugImage()
        {
            if (_imageMode == ImageMode.Off || manager == null) return;

            Mat source = _imageMode == ImageMode.Camera
                ? manager.LastFrameMat
                : manager.LastEdgeMat;

            if (source == null || source.empty()) return;

            // Reallocate only when the shape changes. A Texture2D per frame at 72Hz is a
            // guaranteed GC stall, and a GC stall during a head turn is very visible.
            if (_imageTexture == null ||
                _imageTexture.width != source.cols() || _imageTexture.height != source.rows())
            {
                if (_imageTexture != null) Destroy(_imageTexture);
                _imageTexture = new Texture2D(source.cols(), source.rows(), TextureFormat.RGBA32, false);
                _imageQuad.material.mainTexture = _imageTexture;
            }

            using var rgba = new Mat();
            int channels = source.channels();
            if (channels == 1)
            {
                OpenCVForUnity.ImgprocModule.Imgproc.cvtColor(
                    source, rgba, OpenCVForUnity.ImgprocModule.Imgproc.COLOR_GRAY2RGBA);
            }
            else if (channels == 3)
            {
                OpenCVForUnity.ImgprocModule.Imgproc.cvtColor(
                    source, rgba, OpenCVForUnity.ImgprocModule.Imgproc.COLOR_RGB2RGBA);
            }
            else
            {
                source.copyTo(rgba);
            }

            OpenCVForUnity.UnityUtils.Utils.matToTexture2D(rgba, _imageTexture);
        }
    }
}
