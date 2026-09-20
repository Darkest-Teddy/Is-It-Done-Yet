using IsItDoneYet.Core;
using UnityEngine;

namespace IsItDoneYet.Design
{
    /// <summary>
    /// The panel every other component is made of.
    ///
    /// One quad, one shared material, one MaterialPropertyBlock. Reading
    /// <c>renderer.material</c> anywhere in this project instantiates a copy -- per panel, per
    /// scene load, never freed -- and the symptom is a slow leak nobody attributes to a getter.
    /// <c>sharedMaterial</c> and an MPB is the whole discipline.
    ///
    /// The quad is deliberately LARGER than the panel: the shadow is drawn by the same shader
    /// and needs somewhere to land. <see cref="ShadowPaddingM"/> is that margin, and a shadow
    /// that looks clipped means it is too small.
    /// </summary>
    [ExecuteAlways]
    [RequireComponent(typeof(MeshRenderer), typeof(MeshFilter))]
    public class GlassPanel : MonoBehaviour
    {
        static readonly int FillId = Shader.PropertyToID("_Fill");
        static readonly int BorderId = Shader.PropertyToID("_Border");
        static readonly int BorderWidthId = Shader.PropertyToID("_BorderWidth");
        static readonly int RadiusId = Shader.PropertyToID("_Radius");
        static readonly int OpacityId = Shader.PropertyToID("_Opacity");
        static readonly int PanelSizeId = Shader.PropertyToID("_PanelSize");
        static readonly int QuadSizeId = Shader.PropertyToID("_QuadSize");
        static readonly int PanelOffsetId = Shader.PropertyToID("_PanelOffset");
        static readonly int ShadowHardId = Shader.PropertyToID("_ShadowHard");
        static readonly int HardOffsetId = Shader.PropertyToID("_HardOffset");
        static readonly int ShadowBlurId = Shader.PropertyToID("_ShadowBlur");
        static readonly int BlurOffsetId = Shader.PropertyToID("_BlurOffset");
        static readonly int BlurRadiusId = Shader.PropertyToID("_BlurRadius");
        static readonly int LipColorId = Shader.PropertyToID("_LipColor");
        static readonly int LipHeightId = Shader.PropertyToID("_LipHeight");
        static readonly int FootColorId = Shader.PropertyToID("_FootColor");
        static readonly int FootHeightId = Shader.PropertyToID("_FootHeight");
        static readonly int GlowColorId = Shader.PropertyToID("_GlowColor");
        static readonly int GlowWidthId = Shader.PropertyToID("_GlowWidth");
        static readonly int FrostAmountId = Shader.PropertyToID("_FrostAmount");
        static readonly int NoiseScaleId = Shader.PropertyToID("_NoiseScale");
        static readonly int NoiseAmountId = Shader.PropertyToID("_NoiseAmount");
        static readonly int DashedId = Shader.PropertyToID("_Dashed");
        static readonly int DashPeriodId = Shader.PropertyToID("_DashPeriod");
        static readonly int DashDutyId = Shader.PropertyToID("_DashDuty");

        /// <summary>
        /// Reference pixels per metre.
        ///
        /// The design is drawn at 1440x810 for a screen. Radii, borders and shadow offsets are
        /// all in those pixels, and every one of them has to become metres somewhere. Doing it
        /// once, here, is what keeps a 26px radius looking like a 26px radius on a panel of any
        /// size -- scaling the radius with the panel is the mistake that turns a card into a
        /// lozenge.
        /// </summary>
        public const float PixelsPerMetre = 1100f;

        public static float Px(float pixels) => pixels / PixelsPerMetre;

        [Header("Size")]
        public Vector2 SizeM = new Vector2(0.40f, 0.25f);
        public float RadiusPx = 26f;
        public float BorderPx = 5f;

        [Header("Colour")]
        public ColorRole Fill = ColorRole.Surface;
        public ColorRole Border = ColorRole.Ink;
        public ColorRole Glow = ColorRole.Surface;
        [Range(0f, 1f)] public float GlowStrength = 0f;
        [Tooltip("Multiplies the theme's panel opacity, so a theme can still darken everything.")]
        [Range(0f, 1f)] public float OpacityScale = 1f;
        public bool Dashed;

        [Header("Depth")]
        [Tooltip("chip | card | panel | hero -- the four shadow levels in design/tokens.json.")]
        public string ShadowLevel = "panel";
        [Range(0f, 1f)] public float Frost = 0.25f;

        MeshRenderer _renderer;
        MeshFilter _filter;
        MaterialPropertyBlock _block;
        static Mesh _sharedQuad;
        static Material _sharedMaterial;

        Vector2 _builtSize;
        float _shadowPadding;

        public float ShadowPaddingM => _shadowPadding;
        /// <summary>Extra world opacity applied on top of the theme's, for adaptive legibility.</summary>
        public float AdaptiveOpacity { get; set; } = 1f;

        void OnEnable()
        {
            _renderer = GetComponent<MeshRenderer>();
            _filter = GetComponent<MeshFilter>();
            _block ??= new MaterialPropertyBlock();

            _renderer.sharedMaterial = SharedMaterial();
            _renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            _renderer.receiveShadows = false;
            // Light probes cost a per-renderer SH upload for an unlit shader that ignores it.
            _renderer.lightProbeUsage = UnityEngine.Rendering.LightProbeUsage.Off;
            _renderer.reflectionProbeUsage = UnityEngine.Rendering.ReflectionProbeUsage.Off;

            // Subscribed to the STATIC event, not to the instance. A panel whose OnEnable runs
            // before the ThemeManager's Awake would otherwise find no instance, subscribe to
            // nothing, and stay magenta for the life of the scene -- which happens whenever the
            // panel sits above the manager in the hierarchy.
            ThemeManager.AnyThemeChanged += Refresh;
            Refresh();
        }

        void OnDisable()
        {
            ThemeManager.AnyThemeChanged -= Refresh;
        }

#if UNITY_EDITOR
        void OnValidate()
        {
            if (isActiveAndEnabled) Refresh();
        }
#endif

        static Material SharedMaterial()
        {
            if (_sharedMaterial != null) return _sharedMaterial;
            var shader = Shader.Find("IsItDoneYet/RoundedPanel");
            // Shader.Find resolves in the Editor and returns null in a build, because Unity
            // strips shaders nothing references. The shader is in a Resources folder AND must
            // be listed under Always Included Shaders before shipping; this returns a visible
            // magenta rather than throwing, so a stripped shader looks wrong instead of
            // crashing the scene.
            if (shader == null) shader = Shader.Find("Universal Render Pipeline/Unlit");
            _sharedMaterial = new Material(shader) { name = "IsItDoneYet/RoundedPanel (shared)", enableInstancing = true };
            return _sharedMaterial;
        }

        /// <summary>
        /// A unit quad, shared by every panel. Built once.
        ///
        /// Sized by the transform's local scale rather than by rebuilding vertices, so changing
        /// a panel's size costs nothing and never touches the mesh.
        /// </summary>
        static Mesh SharedQuad()
        {
            if (_sharedQuad != null) return _sharedQuad;
            _sharedQuad = new Mesh { name = "IsItDoneYet/PanelQuad" };
            _sharedQuad.SetVertices(new[]
            {
                new Vector3(-0.5f, -0.5f, 0f), new Vector3(0.5f, -0.5f, 0f),
                new Vector3(0.5f, 0.5f, 0f), new Vector3(-0.5f, 0.5f, 0f),
            });
            _sharedQuad.SetUVs(0, new[] { new Vector2(0, 0), new Vector2(1, 0), new Vector2(1, 1), new Vector2(0, 1) });
            _sharedQuad.SetTriangles(new[] { 0, 2, 1, 0, 3, 2 }, 0);
            _sharedQuad.RecalculateNormals();
            _sharedQuad.RecalculateBounds();
            return _sharedQuad;
        }

        /// <summary>Re-reads the theme and pushes everything to the property block.</summary>
        public void Refresh()
        {
            if (_renderer == null) return;
            var theme = ThemeManager.Instance;
            var tokens = theme != null ? theme.Tokens : null;

            var shadow = tokens != null ? tokens.Shadow(ShadowLevel) : default;
            var hardOffset = new Vector2(Px(shadow.HardOffsetPx.x), -Px(shadow.HardOffsetPx.y));
            var blurOffset = new Vector2(Px(shadow.BlurOffsetPx.x), -Px(shadow.BlurOffsetPx.y));
            var blurRadius = Px(shadow.BlurPx);

            // The quad has to contain the panel AND everything the shader draws outside it.
            _shadowPadding = Mathf.Max(
                Mathf.Abs(hardOffset.x) + blurRadius,
                Mathf.Abs(hardOffset.y) + blurRadius,
                Mathf.Abs(blurOffset.x) + blurRadius,
                Mathf.Abs(blurOffset.y) + blurRadius) + Px(BorderPx) * 2f;

            var quad = SizeM + Vector2.one * (_shadowPadding * 2f);
            if (_filter.sharedMesh == null) _filter.sharedMesh = SharedQuad();
            transform.localScale = new Vector3(quad.x, quad.y, 1f);
            _builtSize = SizeM;

            _renderer.GetPropertyBlock(_block);

            var fill = theme != null ? theme.ShaderColor(Fill) : Color.white;
            var border = theme != null ? theme.ShaderColor(Border) : Color.black;
            var opacity = (theme != null ? theme.PanelOpacity : 0.94f) * OpacityScale * AdaptiveOpacity;

            _block.SetColor(FillId, fill);
            _block.SetColor(BorderId, border);
            _block.SetFloat(BorderWidthId, Px(BorderPx));
            _block.SetFloat(RadiusId, Px(RadiusPx));
            _block.SetFloat(OpacityId, Mathf.Clamp01(opacity));
            _block.SetVector(PanelSizeId, new Vector4(SizeM.x, SizeM.y, 0f, 0f));
            _block.SetVector(QuadSizeId, new Vector4(quad.x, quad.y, 0f, 0f));
            // The panel sits offset within the quad so the shadow, which falls down and to the
            // right, has room without pushing the panel off-centre in the world.
            _block.SetVector(PanelOffsetId, new Vector4(-hardOffset.x * 0.5f, -hardOffset.y * 0.5f, 0f, 0f));

            var hardColor = tokens != null ? Srgb.ForShader(tokens.ShadowHardColor) : Color.black;
            hardColor.a = shadow.HardAlpha;
            var blurColor = tokens != null ? Srgb.ForShader(tokens.ShadowBlurColor) : Color.black;
            blurColor.a = shadow.BlurAlpha;
            _block.SetColor(ShadowHardId, hardColor);
            _block.SetVector(HardOffsetId, hardOffset);
            _block.SetColor(ShadowBlurId, blurColor);
            _block.SetVector(BlurOffsetId, blurOffset);
            _block.SetFloat(BlurRadiusId, Mathf.Max(blurRadius, 1e-4f));

            var lip = tokens != null ? Srgb.ForShader(tokens.ShadowLipColor) : Color.white;
            lip.a = shadow.LipAlpha;
            var foot = tokens != null ? Srgb.ForShader(tokens.ShadowFootColor) : Color.black;
            foot.a = shadow.FootAlpha;
            _block.SetColor(LipColorId, lip);
            _block.SetFloat(LipHeightId, Px(4f));
            _block.SetColor(FootColorId, foot);
            _block.SetFloat(FootHeightId, Px(22f));

            var glow = theme != null ? theme.ShaderColor(Glow) : Color.white;
            glow.a = GlowStrength;
            _block.SetColor(GlowColorId, glow);
            _block.SetFloat(GlowWidthId, Px(8f));

            _block.SetFloat(FrostAmountId, Frost);
            _block.SetFloat(NoiseScaleId, 180f);
            _block.SetFloat(NoiseAmountId, 0.03f);
            _block.SetFloat(DashedId, Dashed ? 1f : 0f);
            _block.SetFloat(DashPeriodId, Px(16f));
            _block.SetFloat(DashDutyId, 0.55f);

            _renderer.SetPropertyBlock(_block);
        }

        /// <summary>Resizes and rebuilds. Cheap: no mesh work, just a scale and a block.</summary>
        public void SetSize(Vector2 sizeM)
        {
            if ((SizeM - sizeM).sqrMagnitude < 1e-8f) return;
            SizeM = sizeM;
            Refresh();
        }
    }
}
