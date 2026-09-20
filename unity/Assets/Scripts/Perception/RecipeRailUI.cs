using System.Text;
using UnityEngine;

namespace MRPerception
{
    /// <summary>
    /// The step rail and the "you need" checklist, as seen in the reference concept.
    ///
    /// Two panels' worth of information and no Canvas, for the same reasons as
    /// <see cref="PerceptionDebugUI"/>: TextMesh and a Quad need no scene authoring, no font
    /// asset and no EventSystem, and cannot fail by rendering perfectly while silently not
    /// responding.
    ///
    /// LAZY FOLLOW, NOT RIGID LOCK. A step rail wants to be ambient -- always there, never in
    /// the way -- which argues for head-locking it. But rigidly head-locked UI in a headset is
    /// genuinely nauseating: it never moves relative to your eye, so your vestibular system gets
    /// no parallax and concludes something is wrong. The fix is a dead zone. The panel stays
    /// world-fixed while you look around normally, and only catches up once you have turned far
    /// enough that it would otherwise leave view. You can look at the board without it chasing
    /// you, and it is still there when you look back.
    /// </summary>
    public sealed class RecipeRailUI : MonoBehaviour
    {
        [Header("Wiring")]
        [SerializeField] private MRPerceptionManager manager;

        [Header("Placement")]
        [SerializeField] private float distance = 0.65f;
        [Tooltip("Metres left of centre. Negative puts it on the right.")]
        [SerializeField] private float lateralOffset = -0.28f;
        [SerializeField] private float verticalOffset = -0.12f;

        [Tooltip(
            "Degrees the head may turn before the panel follows. Below about 12 the panel feels " +
            "glued to your face; above about 35 it is gone when you look back for it.")]
        [SerializeField, Range(5f, 60f)] private float followDeadZoneDeg = 22f;

        [SerializeField] private float followSpeed = 3.5f;

        [Header("Style")]
        [SerializeField] private Color activeColor = new(1f, 1f, 1f);
        [SerializeField] private Color doneColor = new(0.42f, 0.46f, 0.52f);
        [SerializeField] private Color pendingColor = new(0.62f, 0.66f, 0.72f);
        [SerializeField] private Color accent = new(1f, 0.35f, 0.16f);

        private Transform _panel;
        private TextMesh _rail;
        private TextMesh _checklist;
        private Camera _head;
        private Vector3 _targetPos;
        private Quaternion _targetRot;

        private readonly StringBuilder _sb = new(1024);

        private RecipeRunner Runner => manager != null ? manager.Recipe : null;

        private void Start()
        {
            _head = Camera.main;
            Build();
            SnapToTarget();
        }

        private void Build()
        {
            var root = new GameObject("RecipeRail");
            _panel = root.transform;
            _panel.SetParent(transform, false);

            _rail = MakeText(_panel, new Vector3(0f, 0f, 0f), TextAnchor.LowerLeft, 44);
            _checklist = MakeText(_panel, new Vector3(0.42f, 0.30f, 0f), TextAnchor.UpperLeft, 40);
        }

        private static TextMesh MakeText(Transform parent, Vector3 local, TextAnchor anchor, int size)
        {
            var go = new GameObject("Text");
            go.transform.SetParent(parent, false);
            go.transform.localPosition = local;
            var tm = go.AddComponent<TextMesh>();
            tm.anchor = anchor;
            tm.alignment = TextAlignment.Left;
            tm.characterSize = 0.005f;
            tm.fontSize = size;         // oversized then scaled down, so glyphs stay crisp
            tm.lineSpacing = 1.15f;
            tm.color = Color.white;
            return tm;
        }

        private void Update()
        {
            if (_head == null) { _head = Camera.main; return; }

            RecipeRunner runner = Runner;
            if (runner == null) return;

            HandleInput(runner);
            Follow();
            Redraw(runner);
        }

        private void HandleInput(RecipeRunner runner)
        {
            float now = Time.realtimeSinceStartup;

            // Triggers rather than face buttons: A and B belong to the debug panel, and a
            // trigger reads as "confirm" without being explained.
            bool forward = OVRInput.GetDown(OVRInput.Button.SecondaryIndexTrigger);
            bool back = OVRInput.GetDown(OVRInput.Button.PrimaryIndexTrigger);

#if UNITY_EDITOR
            forward |= Input.GetKeyDown(KeyCode.Space);
            back |= Input.GetKeyDown(KeyCode.Backspace);
#endif

            if (forward) runner.AdvanceManually(now);
            if (back) runner.Back(now);
        }

        /// <summary>
        /// Follows the head only once it has turned past the dead zone. See the class comment --
        /// this is the difference between ambient and nauseating.
        /// </summary>
        private void Follow()
        {
            Vector3 forward = _head.transform.forward;
            forward.y = 0f;
            if (forward.sqrMagnitude < 0.0001f) return;
            forward.Normalize();

            Vector3 toPanel = _panel.position - _head.transform.position;
            toPanel.y = 0f;

            bool outside = toPanel.sqrMagnitude < 0.0001f
                           || Vector3.Angle(forward, toPanel.normalized) > followDeadZoneDeg;

            if (outside)
            {
                Vector3 right = Vector3.Cross(Vector3.up, forward).normalized;
                _targetPos = _head.transform.position
                             + forward * distance
                             + right * lateralOffset
                             + Vector3.up * verticalOffset;
                _targetRot = Quaternion.LookRotation(forward, Vector3.up);
            }

            if (_targetPos == Vector3.zero) return;
            float t = 1f - Mathf.Exp(-followSpeed * Time.unscaledDeltaTime);
            _panel.position = Vector3.Lerp(_panel.position, _targetPos, t);
            _panel.rotation = Quaternion.Slerp(_panel.rotation, _targetRot, t);
        }

        private void SnapToTarget()
        {
            if (_head == null) return;
            Vector3 forward = _head.transform.forward;
            forward.y = 0f;
            if (forward.sqrMagnitude < 0.0001f) forward = Vector3.forward;
            forward.Normalize();
            Vector3 right = Vector3.Cross(Vector3.up, forward).normalized;
            _targetPos = _head.transform.position + forward * distance
                         + right * lateralOffset + Vector3.up * verticalOffset;
            _targetRot = Quaternion.LookRotation(forward, Vector3.up);
            _panel.SetPositionAndRotation(_targetPos, _targetRot);
        }

        private void Redraw(RecipeRunner runner)
        {
            float now = Time.realtimeSinceStartup;

            // --- the rail ---------------------------------------------------------
            _sb.Clear();
            RecipeStep[] steps = runner.Recipe.Steps;
            for (int i = 0; i < steps.Length; i++)
            {
                // Past steps stay visible and dim. The reference keeps them, and it is the right
                // call: seeing what you already did is most of what tells you where you are.
                Color c = i < runner.Index ? doneColor
                    : i == runner.Index ? activeColor
                    : pendingColor;
                _sb.Append("<color=#").Append(ColorUtility.ToHtmlStringRGB(c)).Append('>');
                _sb.Append(steps[i].Rail);

                if (i == runner.Index)
                {
                    float progress = runner.StepProgress(now);
                    if (progress >= 0f)
                    {
                        // A visible countdown. An instruction that changes without warning reads
                        // as a glitch; one that fills up reads as the system waiting for you.
                        int filled = Mathf.RoundToInt(progress * 8f);
                        _sb.Append("  ").Append(new string('=', filled))
                           .Append(new string('.', 8 - filled));
                    }
                }
                _sb.Append("</color>\n");
            }
            _rail.text = _sb.ToString();

            // --- the checklist ----------------------------------------------------
            _sb.Clear();
            _sb.Append("<color=#").Append(ColorUtility.ToHtmlStringRGB(accent))
               .Append(">you need</color>\n");

            foreach (Ingredient ing in runner.Recipe.Ingredients)
            {
                bool have = runner.HasIngredient(ing);
                // Bright means STILL NEEDED, dim means found -- the same polarity as the
                // reference, where the two un-struck lines are the two things not yet on the
                // counter. It reads as a shopping list, which is what it is.
                Color c = have ? doneColor : activeColor;
                _sb.Append("<color=#").Append(ColorUtility.ToHtmlStringRGB(c)).Append('>')
                   .Append(have ? "- " : "  ")
                   .Append(ing.Text)
                   .Append("</color>\n");
            }
            _checklist.text = _sb.ToString();
        }
    }
}
