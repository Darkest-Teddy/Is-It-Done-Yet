using System;
using System.Collections.Generic;
using IsItDoneYet.Core;
using UnityEngine;

namespace IsItDoneYet.Design
{
    /// <summary>
    /// The live theme, and the crossfade between two of them.
    ///
    /// Switching is a fade rather than a swap because the switch happens at the worst possible
    /// moment: SAFE mode engages as the cook picks up a knife or turns on a burner. A palette
    /// that changes between two frames, in the corner of the eye, while somebody is reaching for
    /// something hot, is a startle. Three hundred and fifty milliseconds of crossfade is enough
    /// for the eye to read it as the room adjusting rather than as something going wrong.
    ///
    /// Components subscribe to <see cref="Changed"/> and re-read their colours. They do not
    /// cache -- a cached colour makes the crossfade skip that element, which looks like a bug in
    /// that element rather than in the theme system.
    /// </summary>
    [DefaultExecutionOrder(-100)]
    public class ThemeManager : MonoBehaviour
    {
        static ThemeManager _instance;
        public static ThemeManager Instance => _instance;

        [SerializeField] DesignTokens _tokens;
        [SerializeField] ThemeName _startTheme = ThemeName.Normal;

        /// <summary>Fires every frame of a crossfade, not just at the end.</summary>
        public event Action Changed;

        /// <summary>
        /// The same signal, but static, so a component can subscribe before any manager exists.
        ///
        /// A panel higher in the hierarchy than the manager runs its OnEnable first, finds
        /// Instance null, subscribes to nothing and never repaints. The static event has no
        /// such window. Components MUST unsubscribe in OnDisable -- a static event holds its
        /// subscribers alive, which for a MonoBehaviour means leaking the whole GameObject.
        /// </summary>
        public static event Action AnyThemeChanged;

        ThemePalette _from;
        ThemePalette _to;
        float _blend = 1f;
        float _blendDuration;
        float _blendElapsed;
        Vector4 _blendEasing = new Vector4(0.4f, 0f, 0.2f, 1f);

        readonly Dictionary<ColorRole, Color> _resolved = new Dictionary<ColorRole, Color>();

        public DesignTokens Tokens => _tokens;
        public ThemeName Current { get; private set; }
        public bool IsBlending => _blend < 1f;

        void Awake()
        {
            if (_instance != null && _instance != this) { Destroy(this); return; }
            _instance = this;
            if (_tokens == null) _tokens = Resources.Load<DesignTokens>("DesignTokens");
            Apply(_startTheme, immediate: true);
        }

        void OnDestroy()
        {
            if (_instance == this) _instance = null;
        }

        /// <summary>
        /// Switch to a theme. Re-applying the current theme is a no-op rather than a restarted
        /// fade -- SAFE mode is evaluated per step, so this gets called with the same value
        /// repeatedly and a restart would make the palette pulse.
        /// </summary>
        public void Apply(ThemeName theme, bool immediate = false)
        {
            if (_tokens == null) return;
            if (Current == theme && _blend >= 1f && _to != null) return;

            var next = _tokens.Palette(theme);
            if (next == null) return;
            next.Rebuild();

            _from = _to ?? next;
            _to = next;
            Current = theme;

            _blendDuration = immediate ? 0f : _tokens.Duration("themeCrossfade", 0.35f);
            _blendElapsed = 0f;
            _blend = _blendDuration <= 0f ? 1f : 0f;
            _blendEasing = _tokens.Easing("standard");

            // TimeScale follows the theme, so SAFE mode slows every tween in the app by
            // changing one number rather than by each component checking the theme.
            TweenRunner.TimeScale = next.MotionScale;

            Resolve();
            Raise();
        }

        void Raise()
        {
            Changed?.Invoke();
            AnyThemeChanged?.Invoke();
        }

        void Update()
        {
            if (_blend >= 1f) return;

            _blendElapsed += Time.unscaledDeltaTime;
            var t = _blendDuration <= 0f ? 1f : Mathf.Clamp01(_blendElapsed / _blendDuration);
            _blend = Easing.CubicBezier(_blendEasing, t);
            Resolve();
            Raise();
        }

        void Resolve()
        {
            if (_to == null) return;
            var roles = (ColorRole[])Enum.GetValues(typeof(ColorRole));
            for (var i = 0; i < roles.Length; i++)
            {
                var role = roles[i];
                _resolved[role] = _blend >= 1f || _from == null
                    ? _to.Get(role)
                    : Blend(_from.Get(role), _to.Get(role), _blend);
            }
        }

        /// <summary>
        /// The crossfade itself, as a pure function so it can be tested without a scene.
        ///
        /// Interpolated in LINEAR light and converted back, not in sRGB. Lerping two sRGB
        /// values directly passes through a darker, muddier midpoint -- the classic
        /// red-to-green through brown. Between this palette's red and gold that midpoint is a
        /// visibly dirty orange, and it is on screen for the whole fade.
        /// </summary>
        public static Color Blend(Color fromSrgb, Color toSrgb, float t)
        {
            t = Mathf.Clamp01(t);
            var a = Srgb.Linearise(fromSrgb);
            var b = Srgb.Linearise(toSrgb);
            var mixed = new Color(
                Mathf.Lerp(a.r, b.r, t),
                Mathf.Lerp(a.g, b.g, t),
                Mathf.Lerp(a.b, b.b, t),
                Mathf.Lerp(fromSrgb.a, toSrgb.a, t));
            var back = Srgb.Srgbise(mixed);
            back.a = mixed.a;
            return back;
        }

        /// <summary>The current sRGB value for a role, mid-crossfade included.</summary>
        public Color Color(ColorRole role)
        {
            if (_resolved.TryGetValue(role, out var value)) return value;
            return _to != null ? _to.Get(role) : UnityEngine.Color.magenta;
        }

        /// <summary>The same colour, converted for a shader uniform. Use this for panels.</summary>
        public Color ShaderColor(ColorRole role) => Srgb.ForShader(Color(role));

        public float TypeScale => _to?.TypeScale ?? 1f;
        public float MotionScale => _to?.MotionScale ?? 1f;
        public bool LoopingAnimation => _to?.LoopingAnimation ?? true;
        public float PanelOpacity => _to?.PanelOpacity ?? 0.94f;
        public bool HasBadge => _to?.HasBadge ?? false;
        public string BadgeText => _to?.BadgeText ?? string.Empty;

        /// <summary>
        /// Refuses a body-sized label on a fill that measured below AA.
        ///
        /// Called by the text component rather than left to a reviewer. Three of the reference's
        /// fills carry display type only, and the reference happens to respect that everywhere;
        /// this is what keeps it true when somebody adds a caption to a red panel at 2am.
        /// </summary>
        public bool AllowsBodyText(ColorRole fill) => _tokens == null || _tokens.AllowsBodyText(fill);

#if UNITY_EDITOR
        /// <summary>Lets the Design Gallery drive the theme without a running app.</summary>
        public void EditorBind(DesignTokens tokens, ThemeName theme)
        {
            _tokens = tokens;
            _to = null;
            Apply(theme, immediate: true);
        }
#endif
    }
}
