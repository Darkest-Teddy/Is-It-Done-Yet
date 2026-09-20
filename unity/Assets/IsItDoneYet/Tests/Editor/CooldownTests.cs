using IsItDoneYet.Core;
using NUnit.Framework;

namespace IsItDoneYet.Tests
{
    /// <summary>
    /// Message and sound cooldowns. A correct warning repeated eleven times teaches the cook to
    /// ignore the twelfth.
    /// </summary>
    public class CooldownTests
    {
        [Test]
        public void FirstCallAlwaysSpeaks()
        {
            var cooldown = new MessageCooldown(10f);
            Assert.IsTrue(cooldown.TrySpeak("warning", 0f));
        }

        [Test]
        public void ARepeatInsideTheWindowIsSuppressed()
        {
            var cooldown = new MessageCooldown(10f);
            cooldown.TrySpeak("warning", 0f);
            Assert.IsFalse(cooldown.TrySpeak("warning", 5f));
        }

        [Test]
        public void ARepeatAfterTheWindowSpeaks()
        {
            var cooldown = new MessageCooldown(10f);
            cooldown.TrySpeak("warning", 0f);
            Assert.IsTrue(cooldown.TrySpeak("warning", 10.1f));
        }

        [Test]
        public void TheBoundaryItselfSpeaks()
        {
            var cooldown = new MessageCooldown(10f);
            cooldown.TrySpeak("warning", 0f);
            Assert.IsTrue(cooldown.TrySpeak("warning", 10f));
        }

        [Test]
        public void DifferentIdsDoNotSuppressEachOther()
        {
            // A warning must never be swallowed because a poke click happened to be recent.
            var cooldown = new MessageCooldown(10f);
            cooldown.TrySpeak("click", 0f);
            Assert.IsTrue(cooldown.TrySpeak("warning", 0f));
        }

        [Test]
        public void ASuppressedCallDoesNotExtendTheWindow()
        {
            // Recording the time on a refused call would make a message that fires constantly
            // never speak again at all.
            var cooldown = new MessageCooldown(10f);
            cooldown.TrySpeak("warning", 0f);
            for (var t = 1f; t < 10f; t += 1f) cooldown.TrySpeak("warning", t);
            Assert.IsTrue(cooldown.TrySpeak("warning", 10f));
        }

        [Test]
        public void APerCallCooldownOverridesTheDefault()
        {
            var cooldown = new MessageCooldown(10f);
            cooldown.TrySpeak("click", 0f, 0.1f);
            Assert.IsTrue(cooldown.TrySpeak("click", 0.2f, 0.1f));
        }

        [Test]
        public void RemainingSecondsCountsDownToZero()
        {
            var cooldown = new MessageCooldown(10f);
            cooldown.TrySpeak("warning", 0f);
            Assert.That(cooldown.RemainingSeconds("warning", 4f), Is.EqualTo(6f).Within(1e-4f));
            Assert.That(cooldown.RemainingSeconds("warning", 20f), Is.EqualTo(0f));
        }

        [Test]
        public void RemainingIsZeroForSomethingNeverSaid()
        {
            Assert.That(new MessageCooldown(10f).RemainingSeconds("never", 5f), Is.EqualTo(0f));
        }

        [Test]
        public void ForgetReleasesOneId()
        {
            // Used when a step advances: the previous step's warning is no longer suppressed
            // just because it was recent, because it now means something else.
            var cooldown = new MessageCooldown(10f);
            cooldown.TrySpeak("warning", 0f);
            cooldown.Forget("warning");
            Assert.IsTrue(cooldown.TrySpeak("warning", 1f));
        }

        [Test]
        public void ClearReleasesEverything()
        {
            var cooldown = new MessageCooldown(10f);
            cooldown.TrySpeak("a", 0f);
            cooldown.TrySpeak("b", 0f);
            cooldown.Clear();
            Assert.IsTrue(cooldown.TrySpeak("a", 1f));
            Assert.IsTrue(cooldown.TrySpeak("b", 1f));
        }

        [TestCase(null)]
        [TestCase("")]
        public void AnEmptyIdNeverSpeaks(string id)
        {
            Assert.IsFalse(new MessageCooldown(10f).TrySpeak(id, 0f));
        }
    }
}
