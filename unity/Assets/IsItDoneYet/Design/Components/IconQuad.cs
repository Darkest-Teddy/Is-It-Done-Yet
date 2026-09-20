using IsItDoneYet.Core;
using UnityEngine;

namespace IsItDoneYet.Design
{
    /// <summary>
    /// A tinted texture on a quad. The ingredient icons, the coach status marks, the camera
    /// indicator.
    ///
    /// Not a SpriteRenderer. Sprites bring their own batching and sorting rules that fight with
    /// world-space quads in XR -- a sprite and a mesh at the same depth sort against each other
    /// by different criteria per eye, and the result is an icon that flickers in one eye only,
    /// which is a miserable thing to debug.
    ///
    /// One shared unlit material, per-instance colour through a property block, same as every
    /// other component here.
    /// </summary>
    [ExecuteAlways]
    [RequireComponent(typeof(MeshRenderer), typeof(MeshFilter))]
    public class IconQuad : MonoBehaviour
    {
        static readonly int BaseMapId = Shader.PropertyToID("_BaseMap");
        static readonly int BaseColorId = Shader.PropertyToID("_BaseColor");

        [Tooltip("File name under Resources/Icons, without the extension.")]
        public string IconName = "status-ok";
        public float SizeM = 0.03f;
        public ColorRole Tint = ColorRole.Ink;
        [Range(0f, 1f)] public float Alpha = 1f;
        [Tooltip("Ingredient art is full colour; the status marks are single-colour and get tinted.")]
        public bool Tinted = true;

        MeshRenderer _renderer;
        MeshFilter _filter;
        MaterialPropertyBlock _block;
        static Material _shared;
        static Mesh _quad;
        string _loaded;
        Texture2D _texture;

        void OnEnable()
        {
            _renderer = GetComponent<MeshRenderer>();
            _filter = GetComponent<MeshFilter>();
            _block ??= new MaterialPropertyBlock();
            _renderer.sharedMaterial = Shared();
            _renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            _renderer.receiveShadows = false;
            _renderer.lightProbeUsage = UnityEngine.Rendering.LightProbeUsage.Off;
            ThemeManager.AnyThemeChanged += Refresh;
            Refresh();
        }

        void OnDisable() => ThemeManager.AnyThemeChanged -= Refresh;

#if UNITY_EDITOR
        void OnValidate() { if (isActiveAndEnabled) Refresh(); }
#endif

        static Material Shared()
        {
            if (_shared != null) return _shared;
            var shader = Shader.Find("Universal Render Pipeline/Unlit");
            _shared = new Material(shader) { name = "IsItDoneYet/Icon (shared)", enableInstancing = true };
            _shared.SetFloat("_Surface", 1f);      // transparent
            _shared.SetFloat("_Blend", 0f);        // alpha
            _shared.SetFloat("_ZWrite", 0f);
            _shared.renderQueue = 3000;
            _shared.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
            _shared.SetOverrideTag("RenderType", "Transparent");
            return _shared;
        }

        static Mesh Quad()
        {
            if (_quad != null) return _quad;
            _quad = new Mesh { name = "IsItDoneYet/IconQuad" };
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

        public void SetIcon(string iconName)
        {
            if (IconName == iconName) return;
            IconName = iconName;
            Refresh();
        }

        public void Refresh()
        {
            if (_renderer == null) return;
            if (_filter.sharedMesh == null) _filter.sharedMesh = Quad();
            transform.localScale = new Vector3(SizeM, SizeM, 1f);

            if (_loaded != IconName)
            {
                _texture = string.IsNullOrEmpty(IconName) ? null : Resources.Load<Texture2D>($"Icons/{IconName}");
                _loaded = IconName;
                // A missing icon is loud in the Editor and invisible in a build. It is an
                // authoring mistake, not a runtime condition, so it belongs in the console of
                // whoever typed the name.
#if UNITY_EDITOR
                if (_texture == null && !string.IsNullOrEmpty(IconName))
                    Debug.LogWarning($"[Design] no icon 'Resources/Icons/{IconName}'", this);
#endif
            }

            _renderer.GetPropertyBlock(_block);
            if (_texture != null) _block.SetTexture(BaseMapId, _texture);

            var theme = ThemeManager.Instance;
            var color = Tinted && theme != null ? theme.Color(Tint) : Color.white;
            color.a = Alpha * AdaptiveLegibility.OpacityBoost;
            _block.SetColor(BaseColorId, Srgb.ForShader(color));

            _renderer.SetPropertyBlock(_block);
        }

        /// <summary>The icon name for a coach verdict. One place, so the four never drift apart.</summary>
        public static string ForStatus(ObservationStatus status)
        {
            switch (status)
            {
                case ObservationStatus.Ok: return "status-ok";
                case ObservationStatus.Warn: return "status-warn";
                case ObservationStatus.Bad: return "status-bad";
                default: return "status-unsure";
            }
        }
    }
}
