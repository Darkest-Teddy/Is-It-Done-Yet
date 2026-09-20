using IsItDoneYet.Core;
using UnityEngine;

namespace IsItDoneYet.Design
{
    /// <summary>
    /// A ring. Timer, combo meter, heat gauge -- one component, one shader, three configurations.
    ///
    /// The heat gauge is why <see cref="Uncertainty"/> exists. Nothing in this system measures
    /// temperature; heat is a guess made from colour, smoke and bubbling in a camera frame. A
    /// gauge with a crisp needle would be a lie told fluently, so the fill is drawn as a band
    /// whose width IS the uncertainty and which widens when the coach is unsure. The cook can
    /// watch the app hedge, which is the honest thing for it to do.
    /// </summary>
    [ExecuteAlways]
    [RequireComponent(typeof(MeshRenderer), typeof(MeshFilter))]
    public class ArcGauge : MonoBehaviour
    {
        static readonly int TrackId = Shader.PropertyToID("_Track");
        static readonly int FillAId = Shader.PropertyToID("_FillA");
        static readonly int FillBId = Shader.PropertyToID("_FillB");
        static readonly int BorderId = Shader.PropertyToID("_Border");
        static readonly int GlowId = Shader.PropertyToID("_GlowColor");
        static readonly int ZoneColorId = Shader.PropertyToID("_ZoneColor");
        static readonly int ProgressId = Shader.PropertyToID("_Progress");
        static readonly int BandId = Shader.PropertyToID("_BandWidth");
        static readonly int StartId = Shader.PropertyToID("_StartDeg");
        static readonly int SweepId = Shader.PropertyToID("_SweepDeg");
        static readonly int ThicknessId = Shader.PropertyToID("_Thickness");
        static readonly int BorderWidthId = Shader.PropertyToID("_BorderWidth");
        static readonly int SegmentsId = Shader.PropertyToID("_Segments");
        static readonly int SegmentGapId = Shader.PropertyToID("_SegmentGap");
        static readonly int ZoneStartId = Shader.PropertyToID("_ZoneStart");
        static readonly int ZoneEndId = Shader.PropertyToID("_ZoneEnd");
        static readonly int OpacityId = Shader.PropertyToID("_Opacity");

        [Header("Shape")]
        public float DiameterM = 0.09f;
        [Range(0.02f, 0.5f)] public float Thickness = 0.16f;
        public float StartDeg = -90f;
        public float SweepDeg = 360f;
        [Tooltip("0 is a smooth sweep. The combo meter uses discrete notches.")]
        public int Segments = 0;

        [Header("Value")]
        [Range(0f, 1f)] public float Progress = 0.6f;
        [Tooltip("Half-width of the uncertainty band. 0 draws a crisp edge -- only honest for a value that is actually known.")]
        [Range(0f, 0.5f)] public float Uncertainty = 0f;

        [Header("Zone band")]
        [Tooltip("The min-to-max window on a step timer, drawn behind the fill.")]
        [Range(0f, 1f)] public float ZoneStart = 0f;
        [Range(0f, 1f)] public float ZoneEnd = 0f;
        public ColorRole ZoneColor = ColorRole.Success;

        [Header("Colour")]
        public ColorRole Track = ColorRole.SurfaceSunken;
        public ColorRole FillStart = ColorRole.Accent;
        public ColorRole FillEnd = ColorRole.Accent2;
        public ColorRole Border = ColorRole.Ink;
        [Range(0f, 1f)] public float GlowStrength = 0f;

        MeshRenderer _renderer;
        MeshFilter _filter;
        MaterialPropertyBlock _block;
        static Material _shared;
        float _displayed;
        float _velocity;

        void OnEnable()
        {
            _renderer = GetComponent<MeshRenderer>();
            _filter = GetComponent<MeshFilter>();
            _block ??= new MaterialPropertyBlock();
            _renderer.sharedMaterial = Shared();
            _renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            _renderer.receiveShadows = false;
            _renderer.lightProbeUsage = UnityEngine.Rendering.LightProbeUsage.Off;
            _displayed = Progress;
            ThemeManager.AnyThemeChanged += Refresh;
            Refresh();
        }

        void OnDisable() => ThemeManager.AnyThemeChanged -= Refresh;

#if UNITY_EDITOR
        void OnValidate() { if (isActiveAndEnabled) { _displayed = Progress; Refresh(); } }
#endif

        static Material Shared()
        {
            if (_shared != null) return _shared;
            var shader = Shader.Find("IsItDoneYet/ArcGauge");
            if (shader == null) shader = Shader.Find("Universal Render Pipeline/Unlit");
            _shared = new Material(shader) { name = "IsItDoneYet/ArcGauge (shared)", enableInstancing = true };
            return _shared;
        }

        void Update()
        {
            // The fill chases the value rather than jumping to it. A timer ring that snaps
            // looks broken; one that eases looks like it is measuring something.
            if (!Mathf.Approximately(_displayed, Progress))
            {
                _displayed = Easing.Spring(_displayed, Progress, ref _velocity, 180f, 26f, Time.deltaTime);
                Refresh();
            }
        }

        public void SetProgress(float value, bool immediate = false)
        {
            Progress = Mathf.Clamp01(value);
            if (immediate) { _displayed = Progress; _velocity = 0f; Refresh(); }
        }

        public void Refresh()
        {
            if (_renderer == null) return;
            if (_filter.sharedMesh == null) _filter.sharedMesh = Quad();
            transform.localScale = new Vector3(DiameterM, DiameterM, 1f);

            var theme = ThemeManager.Instance;
            _renderer.GetPropertyBlock(_block);

            _block.SetColor(TrackId, theme != null ? theme.ShaderColor(Track) : Color.gray);
            _block.SetColor(FillAId, theme != null ? theme.ShaderColor(FillStart) : Color.red);
            _block.SetColor(FillBId, theme != null ? theme.ShaderColor(FillEnd) : Color.yellow);
            _block.SetColor(BorderId, theme != null ? theme.ShaderColor(Border) : Color.black);

            var glow = theme != null ? theme.ShaderColor(FillEnd) : Color.yellow;
            glow.a = GlowStrength;
            _block.SetColor(GlowId, glow);

            var zone = theme != null ? theme.ShaderColor(ZoneColor) : Color.green;
            zone.a = ZoneEnd > ZoneStart ? 0.85f : 0f;
            _block.SetColor(ZoneColorId, zone);

            _block.SetFloat(ProgressId, Mathf.Clamp01(_displayed));
            _block.SetFloat(BandId, Mathf.Clamp(Uncertainty, 0f, 0.5f));
            _block.SetFloat(StartId, StartDeg);
            _block.SetFloat(SweepId, SweepDeg);
            _block.SetFloat(ThicknessId, Thickness);
            _block.SetFloat(BorderWidthId, 0.02f);
            _block.SetFloat(SegmentsId, Mathf.Max(0, Segments));
            _block.SetFloat(SegmentGapId, 0.12f);
            _block.SetFloat(ZoneStartId, ZoneStart);
            _block.SetFloat(ZoneEndId, ZoneEnd);
            _block.SetFloat(OpacityId, AdaptiveLegibility.OpacityBoost);

            _renderer.SetPropertyBlock(_block);
        }

        static Mesh _quad;
        static Mesh Quad()
        {
            if (_quad != null) return _quad;
            _quad = new Mesh { name = "IsItDoneYet/ArcQuad" };
            _quad.SetVertices(new[]
            {
                new Vector3(-0.5f, -0.5f, 0f), new Vector3(0.5f, -0.5f, 0f),
                new Vector3(0.5f, 0.5f, 0f), new Vector3(-0.5f, 0.5f, 0f),
            });
            _quad.SetUVs(0, new[] { new Vector2(0, 0), new Vector2(1, 0), new Vector2(1, 1), new Vector2(0, 1) });
            _quad.SetTriangles(new[] { 0, 2, 1, 0, 3, 2 }, 0);
            _quad.RecalculateNormals();
            _quad.RecalculateBounds();
            return _quad;
        }

        /// <summary>
        /// Maps a step's elapsed time onto the ring, with the min-to-max window as the zone band.
        ///
        /// Pure and static so the mapping can be tested. Getting it wrong shows up as a timer
        /// that is subtly ahead of the number beside it, which nobody notices until a judge does.
        /// </summary>
        public static void TimerBand(float elapsedSec, float minSec, float maxSec, out float progress, out float zoneStart, out float zoneEnd)
        {
            // The ring's full sweep is the maximum, or twice the minimum when there is no
            // maximum -- a ring with no end would otherwise never move.
            var full = maxSec > 0f ? maxSec : Mathf.Max(minSec * 2f, 1f);
            progress = Mathf.Clamp01(elapsedSec / full);
            zoneStart = minSec > 0f ? Mathf.Clamp01(minSec / full) : 0f;
            zoneEnd = maxSec > 0f ? 1f : 0f;
        }
    }
}
