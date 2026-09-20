using System;
using UnityEngine;
using UnityEngine.Events;

namespace IsItDoneYet.Design
{
    public enum ControlState { Normal, Hover, Pressed, Focused, Disabled }

    /// <summary>
    /// A button you push with a finger.
    ///
    /// The reference's hover state is <c>translate(-3px,-4px)</c> with a deeper shadow. In a
    /// headset "hover" is a distance, not a cursor, so the same gesture is a lift TOWARD the
    /// cook -- which reads identically head-on and, unlike a 2D offset, still reads from
    /// off-axis where most glances actually come from.
    ///
    /// Press is a depress: the pill travels back along its own normal and its shadow tightens,
    /// so the thing under your finger behaves like a thing under your finger. This is the whole
    /// reason to model the shadow as two hard offsets -- they are what sells the travel.
    ///
    /// Nothing here knows about Meta's Interaction SDK. A driver in the app layer calls
    /// <see cref="SetHover"/> and <see cref="SetPressed"/>; this component owns only what the
    /// button looks like, which is what lets it be exercised in the Design Gallery with no
    /// hands, no controllers and no headset.
    /// </summary>
    [ExecuteAlways]
    public class PillButton : MonoBehaviour
    {
        [Header("Look")]
        public ColorRole Fill = ColorRole.Surface;
        public ColorRole FillHover = ColorRole.Accent2;
        public ColorRole FillPressed = ColorRole.Accent2;
        public ColorRole FillDisabled = ColorRole.SurfaceSunken;
        public ColorRole Border = ColorRole.Ink;

        [Header("Travel (metres)")]
        [Tooltip("Toward the cook on hover. The reference's 3-4px lift, as a depth.")]
        public float HoverLiftM = 0.0015f;
        [Tooltip("Away from the cook on press. Slightly more than the lift, so press beats hover.")]
        public float PressDepthM = 0.004f;

        [Header("Behaviour")]
        public bool Interactable = true;
        public UnityEvent OnClick = new UnityEvent();

        [SerializeField] GlassPanel _panel;
        [SerializeField] Label _label;

        ControlState _state = ControlState.Normal;
        Vector3 _restLocalPosition;
        float _travel;
        float _travelVelocity;
        bool _pressed;
        bool _hovered;
        bool _focused;
        bool _captured;

        public ControlState State => _state;
        /// <summary>Raised on release, not on press. A finger that slides off is not a click.</summary>
        public event Action Clicked;

        void OnEnable()
        {
            if (_panel == null) _panel = GetComponentInChildren<GlassPanel>();
            if (_label == null) _label = GetComponentInChildren<Label>();
            _restLocalPosition = transform.localPosition;
            ThemeManager.AnyThemeChanged += ApplyVisual;
            ApplyVisual();
        }

        void OnDisable() => ThemeManager.AnyThemeChanged -= ApplyVisual;

        public void SetInteractable(bool value)
        {
            if (Interactable == value) return;
            Interactable = value;
            if (!value) { _hovered = false; _pressed = false; _captured = false; }
            Evaluate();
        }

        public void SetHover(bool hovered)
        {
            if (!Interactable || _hovered == hovered) return;
            _hovered = hovered;
            // Leaving while held cancels the press rather than firing it. Sliding a finger off
            // a button is the universal "actually, no" and it has to work here too.
            if (!hovered && _pressed) { _pressed = false; _captured = false; }
            Evaluate();
        }

        public void SetFocused(bool focused)
        {
            if (_focused == focused) return;
            _focused = focused;
            Evaluate();
        }

        public void SetPressed(bool pressed)
        {
            if (!Interactable) return;
            if (_pressed == pressed) return;

            if (pressed)
            {
                _pressed = true;
                _captured = true;
            }
            else
            {
                _pressed = false;
                // Only a press that started on this button counts, so a finger that arrives
                // already closed -- reaching past a button on the way to something else -- does
                // not trigger it.
                if (_captured && _hovered)
                {
                    Clicked?.Invoke();
                    OnClick?.Invoke();
                }
                _captured = false;
            }
            Evaluate();
        }

        void Evaluate()
        {
            var next = !Interactable ? ControlState.Disabled
                : _pressed ? ControlState.Pressed
                : _hovered ? ControlState.Hover
                : _focused ? ControlState.Focused
                : ControlState.Normal;

            if (next == _state) return;
            _state = next;
            ApplyVisual();
        }

        void ApplyVisual()
        {
            if (_panel == null) return;
            switch (_state)
            {
                case ControlState.Disabled:
                    _panel.Fill = FillDisabled;
                    _panel.OpacityScale = 0.6f;
                    _panel.GlowStrength = 0f;
                    break;
                case ControlState.Pressed:
                    _panel.Fill = FillPressed;
                    _panel.OpacityScale = 1f;
                    _panel.GlowStrength = 0f;
                    _panel.ShadowLevel = "chip";
                    break;
                case ControlState.Hover:
                    _panel.Fill = FillHover;
                    _panel.OpacityScale = 1f;
                    _panel.GlowStrength = 0.18f;
                    _panel.ShadowLevel = "card";
                    break;
                case ControlState.Focused:
                    _panel.Fill = Fill;
                    _panel.OpacityScale = 1f;
                    // Focus is a glow, never a colour change. Colour is how this design says
                    // "which kind of button"; reusing it for "which one is selected" makes the
                    // two unreadable together.
                    _panel.GlowStrength = 0.3f;
                    _panel.ShadowLevel = "card";
                    break;
                default:
                    _panel.Fill = Fill;
                    _panel.OpacityScale = 1f;
                    _panel.GlowStrength = 0f;
                    _panel.ShadowLevel = "card";
                    break;
            }
            _panel.Border = Border;
            _panel.Refresh();
            if (_label != null) _label.Refresh();
        }

        void Update()
        {
            var target = _state == ControlState.Pressed ? -PressDepthM
                : _state == ControlState.Hover || _state == ControlState.Focused ? HoverLiftM
                : 0f;

            // Sprung rather than tweened: a button's travel has to be interruptible mid-press,
            // and a duration-based tween restarted every time the state changes stutters.
            _travel = Easing.Spring(_travel, target, ref _travelVelocity, 420f, 34f, Time.deltaTime);
            // Local -Z is toward the cook: a panel is oriented by AngularLayout.FacingHead,
            // which points its +Z away from the head so the quad's front face is visible.
            transform.localPosition = _restLocalPosition + Vector3.back * _travel;
        }

        /// <summary>Re-reads where "at rest" is, after a layout pass has moved the button.</summary>
        public void MarkRestPose() => _restLocalPosition = transform.localPosition;
    }
}
