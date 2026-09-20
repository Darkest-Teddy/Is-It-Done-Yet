Shader "IsItDoneYet/RoundedPanel"
{
    // The design's entire surface treatment, evaluated from a signed distance field.
    //
    // The reference draws a panel with a five-part CSS box-shadow: two HARD offset copies of the
    // silhouette in near-black, one real blur, and two insets for the top lip and the darkened
    // foot. The hard copies are the load-bearing part -- they are what makes the panels read as
    // stickers with weight rather than as floating cards -- and they are not what a real shadow
    // looks like, so a real shadow would have been wrong as well as too expensive.
    //
    // One material, shared. Every per-panel value is an instanced property, so a dozen panels
    // are one draw call and none of them owns a material copy. Setting `renderer.material` in
    // this project leaks a material per panel per scene load; use a MaterialPropertyBlock.
    //
    // Frosted glass is faked. A real blur is a full-screen grab per panel, which on an XR2 Gen 2
    // rendering stereo at 72Hz is the whole frame budget. A vertical gradient plus value noise
    // reads as glass at arm's length and costs one arithmetic block.

    Properties
    {
        [Header(Fill)]
        _Fill            ("Fill", Color) = (1, 0.953, 0.894, 1)
        _Border          ("Border", Color) = (0.275, 0.063, 0.102, 1)
        _BorderWidth     ("Border width (m)", Float) = 0.004
        _Radius          ("Corner radius (m)", Float) = 0.02
        _Opacity         ("Opacity", Range(0,1)) = 0.94

        [Header(Geometry)]
        _PanelSize       ("Panel size (m)", Vector) = (0.4, 0.25, 0, 0)
        _QuadSize        ("Quad size (m)", Vector) = (0.48, 0.33, 0, 0)
        _PanelOffset     ("Panel offset in quad (m)", Vector) = (-0.02, 0.02, 0, 0)

        [Header(Shadow)]
        _ShadowHard      ("Hard shadow colour", Color) = (0.275, 0.063, 0.102, 0.5)
        _HardOffset      ("Hard offset (m)", Vector) = (0.009, -0.012, 0, 0)
        _ShadowBlur      ("Blur shadow colour", Color) = (0, 0, 0, 0.5)
        _BlurOffset      ("Blur offset (m)", Vector) = (0.018, -0.026, 0, 0)
        _BlurRadius      ("Blur radius (m)", Float) = 0.038

        [Header(Inset sheen)]
        _LipColor        ("Top lip", Color) = (1, 1, 1, 0.75)
        _LipHeight       ("Lip height (m)", Float) = 0.004
        _FootColor       ("Foot", Color) = (0.471, 0.29, 0.173, 0.18)
        _FootHeight      ("Foot height (m)", Float) = 0.022

        [Header(Inner glow)]
        _GlowColor       ("Inner glow", Color) = (1, 1, 1, 0)
        _GlowWidth       ("Inner glow width (m)", Float) = 0.008

        [Header(Frost)]
        _FrostAmount     ("Frost", Range(0,1)) = 0.0
        _NoiseScale      ("Noise scale", Float) = 180
        _NoiseAmount     ("Noise amount", Range(0,0.2)) = 0.03

        [Header(Dashes)]
        _Dashed          ("Dashed border", Float) = 0
        _DashPeriod      ("Dash period (m)", Float) = 0.016
        _DashDuty        ("Dash duty", Range(0,1)) = 0.55
    }

    SubShader
    {
        Tags
        {
            "RenderPipeline" = "UniversalPipeline"
            "RenderType" = "Transparent"
            "Queue" = "Transparent"
            "IgnoreProjector" = "True"
        }

        Pass
        {
            Name "Panel"
            Blend SrcAlpha OneMinusSrcAlpha
            // Off, and this matters more in XR than on a monitor: a transparent panel that
            // writes depth punches a hole in every panel behind it, and with stereo the hole is
            // in a slightly different place per eye, which reads as the panel flickering.
            ZWrite Off
            ZTest LEqual
            Cull Off

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_instancing
            #pragma target 3.0

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            struct Attributes
            {
                float4 positionOS : POSITION;
                float2 uv         : TEXCOORD0;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float2 uv         : TEXCOORD0;
                UNITY_VERTEX_INPUT_INSTANCE_ID
                UNITY_VERTEX_OUTPUT_STEREO
            };

            // Instanced, not per-material. A MaterialPropertyBlock writes into this buffer, so
            // panels with different colours still batch.
            UNITY_INSTANCING_BUFFER_START(Props)
                UNITY_DEFINE_INSTANCED_PROP(float4, _Fill)
                UNITY_DEFINE_INSTANCED_PROP(float4, _Border)
                UNITY_DEFINE_INSTANCED_PROP(float4, _PanelSize)
                UNITY_DEFINE_INSTANCED_PROP(float4, _QuadSize)
                UNITY_DEFINE_INSTANCED_PROP(float4, _PanelOffset)
                UNITY_DEFINE_INSTANCED_PROP(float4, _ShadowHard)
                UNITY_DEFINE_INSTANCED_PROP(float4, _HardOffset)
                UNITY_DEFINE_INSTANCED_PROP(float4, _ShadowBlur)
                UNITY_DEFINE_INSTANCED_PROP(float4, _BlurOffset)
                UNITY_DEFINE_INSTANCED_PROP(float4, _LipColor)
                UNITY_DEFINE_INSTANCED_PROP(float4, _FootColor)
                UNITY_DEFINE_INSTANCED_PROP(float4, _GlowColor)
                UNITY_DEFINE_INSTANCED_PROP(float, _BorderWidth)
                UNITY_DEFINE_INSTANCED_PROP(float, _Radius)
                UNITY_DEFINE_INSTANCED_PROP(float, _Opacity)
                UNITY_DEFINE_INSTANCED_PROP(float, _BlurRadius)
                UNITY_DEFINE_INSTANCED_PROP(float, _LipHeight)
                UNITY_DEFINE_INSTANCED_PROP(float, _FootHeight)
                UNITY_DEFINE_INSTANCED_PROP(float, _GlowWidth)
                UNITY_DEFINE_INSTANCED_PROP(float, _FrostAmount)
                UNITY_DEFINE_INSTANCED_PROP(float, _NoiseScale)
                UNITY_DEFINE_INSTANCED_PROP(float, _NoiseAmount)
                UNITY_DEFINE_INSTANCED_PROP(float, _Dashed)
                UNITY_DEFINE_INSTANCED_PROP(float, _DashPeriod)
                UNITY_DEFINE_INSTANCED_PROP(float, _DashDuty)
            UNITY_INSTANCING_BUFFER_END(Props)

            #define PROP(name) UNITY_ACCESS_INSTANCED_PROP(Props, name)

            // Signed distance to a rounded rectangle centred on the origin. Negative inside.
            // Inigo Quilez's formulation; the max() on the half-extent is what stops a radius
            // larger than the box from turning the sign inside out.
            float sdRoundedBox(float2 p, float2 halfExtent, float radius)
            {
                float r = min(radius, min(halfExtent.x, halfExtent.y));
                float2 q = abs(p) - halfExtent + r;
                return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
            }

            // One texel of antialiasing, in the same units as the distance field. fwidth is the
            // only thing here that adapts to how large the panel is on screen, which is why a
            // panel held 20cm from the eye has the same edge softness as one across the room.
            float aa(float d)
            {
                float w = max(fwidth(d), 1e-5);
                return saturate(0.5 - d / w);
            }

            float hash21(float2 p)
            {
                p = frac(p * float2(123.34, 456.21));
                p += dot(p, p + 45.32);
                return frac(p.x * p.y);
            }

            Varyings vert(Attributes input)
            {
                Varyings output = (Varyings)0;
                UNITY_SETUP_INSTANCE_ID(input);
                UNITY_TRANSFER_INSTANCE_ID(input, output);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(output);
                output.positionCS = TransformObjectToHClip(input.positionOS.xyz);
                output.uv = input.uv;
                return output;
            }

            half4 frag(Varyings input) : SV_Target
            {
                UNITY_SETUP_INSTANCE_ID(input);
                UNITY_SETUP_STEREO_EYE_INDEX_POST_VERTEX(input);

                float2 quad = PROP(_QuadSize).xy;
                float2 panel = PROP(_PanelSize).xy;
                float2 offset = PROP(_PanelOffset).xy;
                float radius = PROP(_Radius);

                // Position in metres, origin at the quad's centre, y up.
                float2 p = (input.uv - 0.5) * quad;
                float2 local = p - offset;
                float2 halfSize = panel * 0.5;

                float d = sdRoundedBox(local, halfSize, radius);

                // --- the two hard offset copies, then the blur ------------------------------
                float4 hardCol = PROP(_ShadowHard);
                float2 hardOff = PROP(_HardOffset).xy;
                float hard = aa(sdRoundedBox(local - hardOff, halfSize, radius));

                float4 blurCol = PROP(_ShadowBlur);
                float2 blurOff = PROP(_BlurOffset).xy;
                float blurR = max(PROP(_BlurRadius), 1e-4);
                float blurD = sdRoundedBox(local - blurOff, halfSize, radius);
                // smoothstep over the distance field rather than a real blur kernel: one
                // instruction instead of a sample loop, and indistinguishable at this scale.
                float blur = 1.0 - smoothstep(-blurR, blurR, blurD);

                float inside = aa(d);

                float3 rgb = 0.0;
                float alpha = 0.0;

                // Back to front. Each layer is composited under what came before, so the panel
                // itself always wins over its own shadow.
                float blurA = blur * blurCol.a;
                rgb = blurCol.rgb;
                alpha = blurA;

                float hardA = hard * hardCol.a;
                rgb = lerp(rgb, hardCol.rgb, hardA);
                alpha = alpha + hardA * (1.0 - alpha);

                // --- the panel ---------------------------------------------------------------
                float4 fill = PROP(_Fill);
                float3 body = fill.rgb;

                // Frost: value noise, plus a vertical ramp. Never a blur.
                float frost = PROP(_FrostAmount);
                if (frost > 0.0)
                {
                    float n = hash21(floor(input.uv * PROP(_NoiseScale)));
                    body += (n - 0.5) * PROP(_NoiseAmount) * frost;
                    body = lerp(body, body * 1.06, saturate(0.5 - local.y / max(panel.y, 1e-4)) * frost);
                }

                // Top lip and darkened foot -- the CSS insets, as two vertical ramps measured
                // from the panel's own edges rather than from the quad's.
                float fromTop = halfSize.y - local.y;
                float fromBottom = local.y + halfSize.y;
                float4 lip = PROP(_LipColor);
                float4 foot = PROP(_FootColor);
                float lipT = 1.0 - saturate(fromTop / max(PROP(_LipHeight), 1e-5));
                float footT = 1.0 - saturate(fromBottom / max(PROP(_FootHeight), 1e-5));
                body = lerp(body, lip.rgb, lipT * lip.a);
                body = lerp(body, foot.rgb, footT * foot.a);

                // Inner glow, hugging the inside of the border.
                float4 glow = PROP(_GlowColor);
                if (glow.a > 0.0)
                {
                    float glowT = 1.0 - saturate(-d / max(PROP(_GlowWidth), 1e-5));
                    body = lerp(body, glow.rgb, saturate(glowT) * glow.a);
                }

                float panelA = inside * fill.a;
                rgb = lerp(rgb, body, panelA);
                alpha = alpha + panelA * (1.0 - alpha);

                // --- the border --------------------------------------------------------------
                float bw = max(PROP(_BorderWidth), 0.0);
                if (bw > 0.0)
                {
                    float ring = aa(d) - aa(d + bw);

                    // Dashes are a per-instance FLOAT, not a shader keyword. A keyword lives on
                    // the material, and every panel here shares one material -- so one dashed
                    // chip would dash every panel in the scene. One branch is the price of
                    // per-panel state.
                    if (PROP(_Dashed) > 0.5)
                    {
                        // The period is measured along the outline rather than along x, or the
                        // top and the sides disagree and the corners look chewed.
                        float perimeter = (abs(local.x) > abs(local.y))
                            ? local.y + sign(local.x) * halfSize.y * 2.0
                            : local.x + sign(local.y) * halfSize.x * 2.0;
                        float phase = frac(perimeter / max(PROP(_DashPeriod), 1e-5));
                        ring *= step(phase, PROP(_DashDuty));
                    }
                    float4 border = PROP(_Border);
                    float borderA = saturate(ring) * border.a;
                    rgb = lerp(rgb, border.rgb, borderA);
                    alpha = max(alpha, borderA);
                }

                alpha *= PROP(_Opacity);
                // Premultiply is NOT used: the blend mode above is straight alpha, and mixing
                // the two conventions is how a panel ends up with a dark halo on one platform.
                return half4(rgb, alpha);
            }
            ENDHLSL
        }
    }

    Fallback Off
}
