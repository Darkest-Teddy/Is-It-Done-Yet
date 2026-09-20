using UnityEngine;

namespace IsItDoneYet.Core
{
    /// <summary>
    /// Colour-space conversion, in one place, because this project gets it wrong by default.
    ///
    /// The design tokens are sRGB hex strings taken from a web design. The Unity project renders
    /// in <b>Linear</b> colour space. A value handed straight to a shader in a Linear project is
    /// interpreted as already-linear, and every mid-tone lifts -- this palette is almost entirely
    /// mid-tones, so the whole design goes pale. The symptom reads as "the colours are slightly
    /// off" rather than as a bug, which is why it survives so long in so many projects.
    ///
    /// Unity converts automatically in exactly two places: a colour a human picked in the
    /// Inspector, and a colour serialised into a .mat asset. Neither applies to us. Everything
    /// here is set at runtime through a MaterialPropertyBlock, which performs <b>no</b>
    /// conversion, so the conversion has to be explicit and it has to be here.
    ///
    /// TextMeshPro is the exception: its shaders expect an sRGB vertex colour and convert
    /// internally, so text colours are assigned raw. See <see cref="ForText"/>.
    /// </summary>
    public static class Srgb
    {
        /// <summary>
        /// The sRGB electro-optical transfer function, per IEC 61966-2-1.
        ///
        /// Written out rather than calling <c>Color.linear</c> so it can be tested without a
        /// render context, and so the same curve is demonstrably the one
        /// <c>tools/design-extract/contrast.mjs</c> uses to compute the contrast ratios recorded
        /// in design/tokens.json. Two implementations of this curve that disagree is a bug
        /// nobody would ever look for.
        /// </summary>
        public static float ToLinear(float channel)
        {
            if (channel <= 0.0f) return 0.0f;
            if (channel >= 1.0f) return 1.0f;
            return channel <= 0.04045f
                ? channel / 12.92f
                : Mathf.Pow((channel + 0.055f) / 1.055f, 2.4f);
        }

        public static float ToSrgb(float linear)
        {
            if (linear <= 0.0f) return 0.0f;
            if (linear >= 1.0f) return 1.0f;
            return linear <= 0.0031308f
                ? linear * 12.92f
                : 1.055f * Mathf.Pow(linear, 1.0f / 2.4f) - 0.055f;
        }

        /// <summary>
        /// Alpha is NOT converted, and that is not an oversight.
        ///
        /// Alpha is a coverage fraction, not a light intensity. Putting it through a transfer
        /// function makes every translucent panel the wrong opacity, and because the error is
        /// monotonic it looks like a tuning problem rather than a conversion one.
        /// </summary>
        public static Color Linearise(Color srgb) =>
            new Color(ToLinear(srgb.r), ToLinear(srgb.g), ToLinear(srgb.b), srgb.a);

        public static Color Srgbise(Color linear) =>
            new Color(ToSrgb(linear.r), ToSrgb(linear.g), ToSrgb(linear.b), linear.a);

        /// <summary>
        /// A colour on its way to a shader uniform. Converts only in a Linear project, so the
        /// same build works if somebody switches the project to Gamma.
        /// </summary>
        public static Color ForShader(Color srgb) =>
            QualitySettings.activeColorSpace == ColorSpace.Linear ? Linearise(srgb) : srgb;

        /// <summary>
        /// A colour on its way to TextMeshPro, which wants it raw. Exists as a named no-op so
        /// that a reader can tell "assigned raw on purpose" from "somebody forgot".
        /// </summary>
        public static Color ForText(Color srgb) => srgb;

        /// <summary>
        /// Parses <c>#RRGGBB</c> or <c>#RRGGBBAA</c>. Returns false rather than throwing or
        /// silently producing magenta: a malformed token should fail the import with a message
        /// naming the key, not ship a colour nobody chose.
        /// </summary>
        public static bool TryParseHex(string hex, out Color color)
        {
            color = default;
            if (string.IsNullOrEmpty(hex)) return false;

            var text = hex[0] == '#' ? hex.Substring(1) : hex;
            if (text.Length != 6 && text.Length != 8) return false;

            var channels = new float[4] { 0f, 0f, 0f, 1f };
            for (var i = 0; i < text.Length; i += 2)
            {
                if (!TryHexByte(text[i], text[i + 1], out var value)) return false;
                channels[i / 2] = value / 255.0f;
            }

            color = new Color(channels[0], channels[1], channels[2], channels[3]);
            return true;
        }

        static bool TryHexByte(char high, char low, out int value)
        {
            value = 0;
            if (!TryHexDigit(high, out var h) || !TryHexDigit(low, out var l)) return false;
            value = h * 16 + l;
            return true;
        }

        static bool TryHexDigit(char c, out int value)
        {
            if (c >= '0' && c <= '9') { value = c - '0'; return true; }
            if (c >= 'a' && c <= 'f') { value = c - 'a' + 10; return true; }
            if (c >= 'A' && c <= 'F') { value = c - 'A' + 10; return true; }
            value = 0;
            return false;
        }

        /// <summary>
        /// WCAG 2.1 relative luminance, and the contrast ratio built on it.
        ///
        /// Here rather than in the importer because the runtime needs it too: the adaptive
        /// legibility pass decides panel opacity from the luminance of the room, and the theme
        /// manager refuses a body-sized label on a fill that cannot carry one.
        /// </summary>
        public static float RelativeLuminance(Color srgb) =>
            0.2126f * ToLinear(srgb.r) + 0.7152f * ToLinear(srgb.g) + 0.0722f * ToLinear(srgb.b);

        public static float ContrastRatio(Color a, Color b)
        {
            var la = RelativeLuminance(a);
            var lb = RelativeLuminance(b);
            var hi = Mathf.Max(la, lb);
            var lo = Mathf.Min(la, lb);
            return (hi + 0.05f) / (lo + 0.05f);
        }
    }
}
