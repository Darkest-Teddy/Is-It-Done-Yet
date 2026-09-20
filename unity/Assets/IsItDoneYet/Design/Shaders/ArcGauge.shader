Shader "IsItDoneYet/ArcGauge"
{
    // Timer rings, the combo meter, and the heat gauge -- all one shader.
    //
    // The heat gauge is the reason the uncertainty band exists. Nothing in this system measures
    // temperature; heat is estimated from colour, smoke and bubbling in a camera frame. A gauge
    // with a crisp needle would be a lie told in a very fluent visual language, so the fill is
    // drawn as a BAND whose width is the uncertainty, and it widens when the coach is unsure.
    // The cook can watch the app hedge.
    //
    // The segmented mode is the combo meter: discrete notches, because a combo is an integer
    // and a smooth sweep would suggest otherwise.

    Properties
    {
        _Track        ("Track", Color) = (0.922, 0.835, 0.737, 1)
        _FillA        ("Fill start", Color) = (0.961, 0.137, 0.055, 1)
        _FillB        ("Fill end", Color) = (0.984, 0.824, 0.294, 1)
        _Border       ("Border", Color) = (0.275, 0.063, 0.102, 1)
        _GlowColor    ("Glow", Color) = (0.984, 0.824, 0.294, 0)
        _ZoneColor    ("Zone colour", Color) = (0.804, 0.902, 0.780, 0)

        _Progress     ("Progress", Range(0,1)) = 0.6
        _BandWidth    ("Uncertainty band", Range(0,0.5)) = 0.0
        _StartDeg     ("Start angle (deg)", Float) = -90
        _SweepDeg     ("Sweep (deg)", Float) = 360

        _Thickness    ("Ring thickness", Range(0.01,0.5)) = 0.16
        _BorderWidth  ("Border width", Range(0,0.08)) = 0.02
        _Softness     ("Edge softness", Range(0.0005,0.05)) = 0.004

        _Segments     ("Segments (0 = smooth)", Float) = 0
        _SegmentGap   ("Segment gap", Range(0,0.4)) = 0.12

        _ZoneStart    ("Zone start", Range(0,1)) = 0.0
        _ZoneEnd      ("Zone end", Range(0,1)) = 0.0

        _Opacity      ("Opacity", Range(0,1)) = 1
    }

    SubShader
    {
        Tags { "RenderPipeline" = "UniversalPipeline" "RenderType" = "Transparent" "Queue" = "Transparent" "IgnoreProjector" = "True" }

        Pass
        {
            Name "Arc"
            Blend SrcAlpha OneMinusSrcAlpha
            ZWrite Off
            ZTest LEqual
            Cull Off

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_instancing
            #pragma target 3.0

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            struct Attributes { float4 positionOS : POSITION; float2 uv : TEXCOORD0; UNITY_VERTEX_INPUT_INSTANCE_ID };
            struct Varyings { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; UNITY_VERTEX_INPUT_INSTANCE_ID UNITY_VERTEX_OUTPUT_STEREO };

            UNITY_INSTANCING_BUFFER_START(Props)
                UNITY_DEFINE_INSTANCED_PROP(float4, _Track)
                UNITY_DEFINE_INSTANCED_PROP(float4, _FillA)
                UNITY_DEFINE_INSTANCED_PROP(float4, _FillB)
                UNITY_DEFINE_INSTANCED_PROP(float4, _Border)
                UNITY_DEFINE_INSTANCED_PROP(float4, _GlowColor)
                UNITY_DEFINE_INSTANCED_PROP(float4, _ZoneColor)
                UNITY_DEFINE_INSTANCED_PROP(float, _Progress)
                UNITY_DEFINE_INSTANCED_PROP(float, _BandWidth)
                UNITY_DEFINE_INSTANCED_PROP(float, _StartDeg)
                UNITY_DEFINE_INSTANCED_PROP(float, _SweepDeg)
                UNITY_DEFINE_INSTANCED_PROP(float, _Thickness)
                UNITY_DEFINE_INSTANCED_PROP(float, _BorderWidth)
                UNITY_DEFINE_INSTANCED_PROP(float, _Softness)
                UNITY_DEFINE_INSTANCED_PROP(float, _Segments)
                UNITY_DEFINE_INSTANCED_PROP(float, _SegmentGap)
                UNITY_DEFINE_INSTANCED_PROP(float, _ZoneStart)
                UNITY_DEFINE_INSTANCED_PROP(float, _ZoneEnd)
                UNITY_DEFINE_INSTANCED_PROP(float, _Opacity)
            UNITY_INSTANCING_BUFFER_END(Props)

            #define PROP(name) UNITY_ACCESS_INSTANCED_PROP(Props, name)

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

                float2 p = input.uv * 2.0 - 1.0;
                float r = length(p);
                float soft = max(PROP(_Softness), 1e-4);
                float thickness = PROP(_Thickness);

                float outer = 1.0;
                float inner = saturate(1.0 - thickness * 2.0);
                float ringMask = smoothstep(inner - soft, inner + soft, r) * (1.0 - smoothstep(outer - soft, outer + soft, r));
                if (ringMask <= 0.0) return half4(0, 0, 0, 0);

                // atan2 gives (-pi, pi]; rotate so 0 is the start angle and t runs 0..1 along
                // the sweep. Clockwise, because every clock and every progress ring is.
                float angle = degrees(atan2(p.x, p.y));
                float t = frac((angle - PROP(_StartDeg)) / 360.0);
                float sweep = max(PROP(_SweepDeg), 1e-3) / 360.0;
                if (t > sweep) return half4(0, 0, 0, 0);
                float u = saturate(t / sweep);

                float segments = PROP(_Segments);
                if (segments >= 1.0)
                {
                    // The gap is cut in the SAME parameter the fill is measured in, so a
                    // half-filled segment reads as half a segment rather than sliding under
                    // the gap.
                    float phase = frac(u * segments);
                    float gap = PROP(_SegmentGap) * 0.5;
                    ringMask *= smoothstep(gap - soft, gap + soft, phase)
                              * (1.0 - smoothstep(1.0 - gap - soft, 1.0 - gap + soft, phase));
                    if (ringMask <= 0.0) return half4(0, 0, 0, 0);
                }

                float4 track = PROP(_Track);
                float3 rgb = track.rgb;
                float alpha = track.a;

                // Zone band: the min-to-max duration window, drawn behind the fill.
                float zoneStart = PROP(_ZoneStart);
                float zoneEnd = PROP(_ZoneEnd);
                float4 zone = PROP(_ZoneColor);
                if (zone.a > 0.0 && zoneEnd > zoneStart)
                {
                    float inZone = step(zoneStart, u) * step(u, zoneEnd);
                    rgb = lerp(rgb, zone.rgb, inZone * zone.a);
                }

                float progress = PROP(_Progress);
                float band = PROP(_BandWidth);
                float3 fill = lerp(PROP(_FillA).rgb, PROP(_FillB).rgb, u);

                if (band <= 0.0)
                {
                    float filled = 1.0 - smoothstep(progress - soft, progress + soft, u);
                    rgb = lerp(rgb, fill, filled);
                }
                else
                {
                    // The uncertainty band. Solid up to the lower bound, then fading out across
                    // the upper one. The eye reads the soft edge as "somewhere around here",
                    // which is exactly what the estimate is.
                    float lo = saturate(progress - band);
                    float hi = saturate(progress + band);
                    float solid = 1.0 - smoothstep(lo - soft, lo + soft, u);
                    float fade = (1.0 - smoothstep(hi - soft, hi + soft, u)) - solid;
                    rgb = lerp(rgb, fill, saturate(solid + fade * 0.45));
                }

                float4 glow = PROP(_GlowColor);
                if (glow.a > 0.0)
                {
                    float edge = 1.0 - abs((r - (inner + outer) * 0.5) / max(thickness, 1e-4));
                    rgb += glow.rgb * glow.a * saturate(edge) * step(u, progress);
                }

                float bw = PROP(_BorderWidth);
                if (bw > 0.0)
                {
                    float4 border = PROP(_Border);
                    float edges = (1.0 - smoothstep(inner, inner + bw, r)) + smoothstep(outer - bw, outer, r);
                    rgb = lerp(rgb, border.rgb, saturate(edges) * border.a);
                }

                return half4(rgb, alpha * ringMask * PROP(_Opacity));
            }
            ENDHLSL
        }
    }

    Fallback Off
}
