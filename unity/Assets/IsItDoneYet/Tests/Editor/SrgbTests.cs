using IsItDoneYet.Core;
using NUnit.Framework;
using UnityEngine;

namespace IsItDoneYet.Tests
{
    /// <summary>
    /// Colour space. The bug this guards against is not a crash -- it is every colour in the
    /// app being slightly wrong in a way that reads as a design choice.
    /// </summary>
    public class SrgbTests
    {
        [Test]
        public void ToLinear_MatchesTheStandardBreakpoint()
        {
            // The sRGB curve is piecewise, and the join is at 0.04045. A single-branch
            // approximation -- pow(c, 2.2) -- is off by several percent in the darks, which
            // is exactly where this palette's outline colour lives.
            Assert.That(Srgb.ToLinear(0.04045f), Is.EqualTo(0.04045f / 12.92f).Within(1e-6f));
            Assert.That(Srgb.ToLinear(0.5f), Is.EqualTo(0.21404f).Within(1e-4f));
        }

        [Test]
        public void ToLinear_AndBack_RoundTrips()
        {
            for (var i = 0; i <= 20; i++)
            {
                var value = i / 20f;
                Assert.That(Srgb.ToSrgb(Srgb.ToLinear(value)), Is.EqualTo(value).Within(1e-4f), $"at {value}");
            }
        }

        [Test]
        public void ToLinear_ClampsOutsideUnitRange()
        {
            Assert.That(Srgb.ToLinear(-0.5f), Is.EqualTo(0f));
            Assert.That(Srgb.ToLinear(1.5f), Is.EqualTo(1f));
        }

        [Test]
        public void Linearise_LeavesAlphaAlone()
        {
            // Alpha is coverage, not light. Putting it through the transfer function makes
            // every translucent panel the wrong opacity, monotonically -- so it looks like a
            // tuning problem rather than a conversion one.
            var color = new Color(0.5f, 0.5f, 0.5f, 0.5f);
            Assert.That(Srgb.Linearise(color).a, Is.EqualTo(0.5f));
        }

        [Test]
        public void TryParseHex_AcceptsSixAndEightDigits()
        {
            Assert.IsTrue(Srgb.TryParseHex("#F5230E", out var six));
            Assert.That(six.r, Is.EqualTo(245f / 255f).Within(1e-5f));
            Assert.That(six.a, Is.EqualTo(1f));

            Assert.IsTrue(Srgb.TryParseHex("#F5230E80", out var eight));
            Assert.That(eight.a, Is.EqualTo(128f / 255f).Within(1e-5f));
        }

        [Test]
        public void TryParseHex_AcceptsNoLeadingHash()
        {
            Assert.IsTrue(Srgb.TryParseHex("46101A", out _));
        }

        [TestCase("#GGGGGG")]
        [TestCase("#12345")]
        [TestCase("")]
        [TestCase(null)]
        [TestCase("not a colour")]
        public void TryParseHex_RefusesRatherThanGuessing(string input)
        {
            // Returning magenta, or white, or throwing, all make a malformed token into a
            // runtime surprise. False makes it an import failure that names the key.
            Assert.IsFalse(Srgb.TryParseHex(input, out _));
        }

        [Test]
        public void ContrastRatio_MatchesTheMeasuredValuesInTokensJson()
        {
            // These are the numbers tools/design-extract/contrast.mjs recorded. Two
            // implementations of the same curve that disagree is a bug nobody would look for,
            // so the C# and the JavaScript are pinned to each other here.
            Srgb.TryParseHex("#FFF3E4", out var surface);
            Srgb.TryParseHex("#46101A", out var ink);
            Assert.That(Srgb.ContrastRatio(surface, ink), Is.EqualTo(14.22f).Within(0.02f));

            Srgb.TryParseHex("#F5230E", out var accent);
            Assert.That(Srgb.ContrastRatio(accent, surface), Is.EqualTo(3.74f).Within(0.02f));

            Srgb.TryParseHex("#2F6DA8", out var practice);
            Assert.That(Srgb.ContrastRatio(practice, surface), Is.EqualTo(4.95f).Within(0.02f));
        }

        [Test]
        public void ContrastRatio_IsSymmetric()
        {
            Srgb.TryParseHex("#FFF3E4", out var a);
            Srgb.TryParseHex("#46101A", out var b);
            Assert.That(Srgb.ContrastRatio(a, b), Is.EqualTo(Srgb.ContrastRatio(b, a)).Within(1e-5f));
        }

        [Test]
        public void ContrastRatio_OfAColourWithItselfIsOne()
        {
            Srgb.TryParseHex("#CDE6C7", out var color);
            Assert.That(Srgb.ContrastRatio(color, color), Is.EqualTo(1f).Within(1e-5f));
        }
    }
}
