Shader "IsItDoneYet/Icon"
{
    // A tinted, transparent texture on a quad.
    //
    // Written rather than using URP/Unlit because URP/Unlit's transparency is configured by its
    // material INSPECTOR, not by its properties: setting _Surface and _Blend on a material from
    // code changes nothing, because the blend state, the render queue and the keyword are all
    // applied by the shader GUI's callback. A material built in code stays opaque, and every
    // icon renders with a white box behind it -- which is exactly what the first Design Gallery
    // capture showed.
    //
    // Six lines of render state, stated once, beats fighting that.

    Properties
    {
        _BaseMap   ("Texture", 2D) = "white" {}
        _BaseColor ("Tint", Color) = (1, 1, 1, 1)
    }

    SubShader
    {
        Tags { "RenderPipeline" = "UniversalPipeline" "RenderType" = "Transparent" "Queue" = "Transparent" "IgnoreProjector" = "True" }

        Pass
        {
            Name "Icon"
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

            TEXTURE2D(_BaseMap);
            SAMPLER(sampler_BaseMap);

            struct Attributes { float4 positionOS : POSITION; float2 uv : TEXCOORD0; UNITY_VERTEX_INPUT_INSTANCE_ID };
            struct Varyings { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; UNITY_VERTEX_INPUT_INSTANCE_ID UNITY_VERTEX_OUTPUT_STEREO };

            UNITY_INSTANCING_BUFFER_START(Props)
                UNITY_DEFINE_INSTANCED_PROP(float4, _BaseColor)
            UNITY_INSTANCING_BUFFER_END(Props)

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

                half4 texel = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, input.uv);
                half4 tint = UNITY_ACCESS_INSTANCED_PROP(Props, _BaseColor);

                // The ingredient art is full colour and is tinted white, so multiplying by the
                // tint leaves it alone. The status marks are single-colour and take the tint's
                // RGB outright, so they can follow the theme.
                return half4(texel.rgb * tint.rgb, texel.a * tint.a);
            }
            ENDHLSL
        }
    }

    Fallback Off
}
