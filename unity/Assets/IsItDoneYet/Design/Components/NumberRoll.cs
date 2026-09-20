using System.Text;
using TMPro;
using UnityEngine;

namespace IsItDoneYet.Design
{
    /// <summary>
    /// A counter whose digits roll, punch on change, and never allocate.
    ///
    /// The allocation matters more than it sounds. A score that updates every frame and builds
    /// its string with <c>value.ToString()</c> produces one garbage string per frame per
    /// counter; on a mobile chip that is a collection every few seconds, and a collection is a
    /// dropped frame you feel through your face. <see cref="TMP_Text.SetText(StringBuilder)"/>
    /// with a reused builder produces none.
    ///
    /// The punch is scaled by how big the change was, so a +10 is a nudge and a +500 is an
    /// event. A fixed punch makes every gain feel the same, which makes none of them feel like
    /// anything.
    /// </summary>
    [ExecuteAlways]
    public class NumberRoll : MonoBehaviour
    {
        [SerializeField] Label _label;

        [Header("Format")]
        public int Decimals = 0;
        public bool ThousandsSeparator = true;
        public string Suffix = string.Empty;

        [Header("Feel")]
        [Tooltip("Seconds for the digits to travel to a new value.")]
        public float RollSeconds = 0.6f;
        [Tooltip("Peak extra scale for the largest expected change.")]
        public float PunchScale = 0.22f;
        [Tooltip("A change this size or larger gets the full punch.")]
        public float PunchReference = 200f;

        readonly StringBuilder _builder = new StringBuilder(24);
        float _target;
        float _displayed;
        float _velocity;
        float _punch;
        float _punchVelocity;
        Vector3 _restScale = Vector3.one;

        /// <summary>Raised when a gain lands, so the sparkle and the chime fire on the same beat.</summary>
        public System.Action<float> Gained;

        void OnEnable()
        {
            if (_label == null) _label = GetComponentInChildren<Label>();
            _restScale = transform.localScale;
            Render();
        }

        /// <summary>Jumps with no animation. Used when a panel first appears.</summary>
        public void SetImmediate(float value)
        {
            _target = value;
            _displayed = value;
            _velocity = 0f;
            Render();
        }

        public void SetValue(float value)
        {
            var delta = value - _target;
            _target = value;
            if (Mathf.Abs(delta) < 1e-4f) return;

            // Only a gain punches. A deduction gets its own treatment -- see the points-docked
            // animation -- because punching on a loss reads as a reward.
            if (delta > 0f)
            {
                _punch = Mathf.Min(1f, Mathf.Abs(delta) / Mathf.Max(PunchReference, 1e-3f));
                Gained?.Invoke(delta);
            }
        }

        void Update()
        {
            var changed = false;

            if (!Mathf.Approximately(_displayed, _target))
            {
                // Stiffness derived from the token duration rather than picked, so changing
                // `numberRoll` in tokens.json actually changes how this feels.
                var stiffness = 120f / Mathf.Max(RollSeconds, 0.05f);
                _displayed = Easing.Spring(_displayed, _target, ref _velocity, stiffness * 6f, stiffness * 1.6f, Time.deltaTime);
                if (Mathf.Abs(_displayed - _target) < 0.01f) { _displayed = _target; _velocity = 0f; }
                changed = true;
            }

            if (_punch > 0.0005f)
            {
                _punch = Easing.Spring(_punch, 0f, ref _punchVelocity, 300f, 22f, Time.deltaTime);
                transform.localScale = _restScale * (1f + _punch * PunchScale);
            }
            else if (_punch != 0f)
            {
                _punch = 0f;
                transform.localScale = _restScale;
            }

            if (changed) Render();
        }

        void Render()
        {
            if (_label == null || _label.Tmp == null) return;

            _builder.Clear();
            var value = Decimals <= 0 ? Mathf.Round(_displayed) : _displayed;

            if (ThousandsSeparator && Decimals <= 0)
            {
                AppendGrouped(_builder, (long)value);
            }
            else
            {
                // A fixed number of decimals, built by hand. `ToString("F1")` allocates and
                // also depends on the current culture, which turns 4.2 into 4,2 on a device
                // set to most of Europe.
                var negative = value < 0f;
                if (negative) { _builder.Append('-'); value = -value; }
                var scale = Mathf.Pow(10f, Decimals);
                var scaled = Mathf.RoundToInt(value * scale);
                _builder.Append(scaled / (long)scale);
                _builder.Append('.');
                var fraction = scaled % (long)scale;
                for (var d = Decimals - 1; d > 0; d--) if (fraction < Mathf.Pow(10f, d)) _builder.Append('0');
                _builder.Append(fraction);
            }

            if (!string.IsNullOrEmpty(Suffix)) _builder.Append(Suffix);
            _label.Tmp.SetText(_builder);
        }

        static void AppendGrouped(StringBuilder builder, long value)
        {
            if (value < 0) { builder.Append('-'); value = -value; }
            if (value < 1000) { builder.Append(value); return; }

            // Three passes at most for any score this app can produce, and no intermediate
            // strings.
            var millions = value / 1_000_000;
            var thousands = value / 1000 % 1000;
            var units = value % 1000;

            if (millions > 0)
            {
                builder.Append(millions).Append(',');
                Append3(builder, thousands);
                builder.Append(',');
            }
            else
            {
                builder.Append(thousands).Append(',');
            }
            Append3(builder, units);
        }

        static void Append3(StringBuilder builder, long value)
        {
            if (value < 100) builder.Append('0');
            if (value < 10) builder.Append('0');
            builder.Append(value);
        }
    }
}
