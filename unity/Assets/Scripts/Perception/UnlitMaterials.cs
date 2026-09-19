using UnityEngine;

namespace MRPerception
{
    /// <summary>
    /// Creates unlit materials at runtime, and fails loudly instead of throwing.
    ///
    /// THE TRAP THIS EXISTS FOR. `Shader.Find` only sees shaders that are IN THE BUILD, and
    /// Unity strips every shader no scene material references. In the Editor all of them
    /// resolve, so this code works perfectly right up until you deploy — at which point
    /// `Shader.Find` returns null, `new Material(null)` throws, and it throws inside the class
    /// whose entire job is to draw something when nothing else has been set up.
    ///
    /// Editor-works-device-throws is the worst failure shape there is, because the machine you
    /// would debug it on is the one where it does not happen.
    ///
    /// Two defences:
    ///
    ///   1. Assign <see cref="Fallback"/> from the inspector — a Material asset in the scene is
    ///      never stripped. This is the reliable fix and the one to use for a build you hand to
    ///      anybody.
    ///   2. Failing that, try several shader names and, if all miss, return null and log once.
    ///      Callers must treat null as "draw nothing", never as something to hand to
    ///      `new Material`.
    ///
    /// If you ship without (1), add "Universal Render Pipeline/Unlit" (or "Unlit/Color" on the
    /// built-in pipeline) to Project Settings > Graphics > Always Included Shaders.
    /// </summary>
    public static class UnlitMaterials
    {
        /// <summary>
        /// Optional inspector-assigned template. Set this and the shader lookup never runs.
        /// Assigned by <see cref="PerceptionDebugUI"/> / callers that expose the field.
        /// </summary>
        public static Material Fallback { get; set; }

        private static bool _warned;

        /// <summary>
        /// An unlit material of the given colour, or null when no shader survived the build.
        ///
        /// Null is a real answer and callers handle it by not drawing. Returning a broken
        /// material would push the failure to the first frame something is tracked, which is
        /// exactly when you least want it.
        /// </summary>
        public static Material Create(Color color, bool transparent)
        {
            if (Fallback != null)
            {
                return new Material(Fallback) { color = color };
            }

            Shader shader = Shader.Find("Universal Render Pipeline/Unlit")
                            ?? Shader.Find("Unlit/Color")
                            ?? Shader.Find("Unlit/Transparent")
                            ?? Shader.Find("Sprites/Default");

            if (shader == null)
            {
                if (!_warned)
                {
                    _warned = true;
                    Debug.LogError(
                        "[Perception] no unlit shader survived the build, so overlays cannot be " +
                        "drawn. Assign UnlitMaterials.Fallback, or add an unlit shader to " +
                        "Project Settings > Graphics > Always Included Shaders.");
                }
                return null;
            }

            var m = new Material(shader) { color = color };
            if (!transparent) return m;

            // URP and the built-in pipeline disagree on every one of these names, so set them
            // all; the ones that do not apply are ignored rather than erroring. URP additionally
            // needs the keyword, without which the surface stays opaque however the blend is set.
            m.SetFloat("_Surface", 1f);
            m.SetInt("_SrcBlend", (int)UnityEngine.Rendering.BlendMode.SrcAlpha);
            m.SetInt("_DstBlend", (int)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
            m.SetInt("_ZWrite", 0);
            m.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
            m.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Transparent;
            return m;
        }

        /// <summary>
        /// Destroys a runtime-created material.
        ///
        /// Destroying a GameObject does NOT free a material made with `new Material(...)` — the
        /// renderer's reference goes away and the material leaks. One per tracked object that
        /// ever appears and retires adds up over a session.
        /// </summary>
        public static void Release(Material material)
        {
            if (material == null) return;
            if (Application.isPlaying) Object.Destroy(material);
            else Object.DestroyImmediate(material);
        }
    }
}
