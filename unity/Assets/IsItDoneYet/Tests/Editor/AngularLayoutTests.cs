using IsItDoneYet.Core;
using NUnit.Framework;
using UnityEngine;

namespace IsItDoneYet.Tests
{
    /// <summary>
    /// Spatial placement. This is the maths that is wrong by ten centimetres in a way nobody
    /// notices until a demo.
    /// </summary>
    public class AngularLayoutTests
    {
        [Test]
        public void DmmToMetres_IsOneMillimetreAtOneMetre()
        {
            Assert.That(AngularLayout.DmmToMetres(1f, 1f), Is.EqualTo(0.001f).Within(1e-6f));
        }

        [Test]
        public void DmmToMetres_ScalesWithDistance()
        {
            // The whole point of the unit: 24 dmm subtends the same angle at any distance, so
            // its world size has to grow linearly with how far away it is placed.
            Assert.That(AngularLayout.DmmToMetres(24f, 2f), Is.EqualTo(AngularLayout.DmmToMetres(24f, 1f) * 2f).Within(1e-6f));
        }

        [Test]
        public void MinimumBodyText_SubtendsTheSameAngleAtEveryDistance()
        {
            var near = AngularLayout.AngularSizeDeg(AngularLayout.DmmToMetres(24f, 0.6f), 0.6f);
            var far = AngularLayout.AngularSizeDeg(AngularLayout.DmmToMetres(24f, 2.2f), 2.2f);
            Assert.That(near, Is.EqualTo(far).Within(1e-4f));
        }

        [Test]
        public void MetresToDmm_InvertsDmmToMetres()
        {
            Assert.That(AngularLayout.MetresToDmm(AngularLayout.DmmToMetres(37f, 1.4f), 1.4f), Is.EqualTo(37f).Within(1e-3f));
        }

        [Test]
        public void DirectionFromAngles_ZeroIsStraightAhead()
        {
            Assert.That(Vector3.Distance(AngularLayout.DirectionFromAngles(0f, 0f), Vector3.forward), Is.LessThan(1e-5f));
        }

        [Test]
        public void DirectionFromAngles_NegativeYawIsLeft()
        {
            // The side menu lives at -52 degrees. A sign error here puts it behind the cook's
            // right shoulder, which reads as the menu not opening at all.
            Assert.That(AngularLayout.DirectionFromAngles(-52f, 0f).x, Is.LessThan(0f));
        }

        [Test]
        public void DirectionFromAngles_PositivePitchIsUp()
        {
            Assert.That(AngularLayout.DirectionFromAngles(0f, 15f).y, Is.GreaterThan(0f));
        }

        [Test]
        public void DirectionFromAngles_IsAlwaysUnitLength()
        {
            for (var yaw = -180f; yaw <= 180f; yaw += 37f)
            for (var pitch = -80f; pitch <= 80f; pitch += 23f)
                Assert.That(AngularLayout.DirectionFromAngles(yaw, pitch).magnitude, Is.EqualTo(1f).Within(1e-4f));
        }

        [Test]
        public void PlaceFromHead_PutsThePointAtTheRequestedDistance()
        {
            var head = new Vector3(1f, 1.6f, -2f);
            var rotation = Quaternion.Euler(0f, 37f, 0f);
            var placed = AngularLayout.PlaceFromHead(head, rotation, 24f, 12f, 1.3f);
            Assert.That(Vector3.Distance(placed, head), Is.EqualTo(1.3f).Within(1e-4f));
        }

        [Test]
        public void HeadingOnly_DiscardsRoll()
        {
            // A cook tilting their head to look at the board must not take the HUD with them.
            var upright = AngularLayout.HeadingOnly(Quaternion.Euler(0f, 40f, 0f));
            var rolled = AngularLayout.HeadingOnly(Quaternion.Euler(0f, 40f, 35f));
            Assert.That(Quaternion.Angle(upright, rolled), Is.LessThan(0.5f));
        }

        [Test]
        public void HeadingOnly_SurvivesLookingStraightDown()
        {
            // Euler decomposition is ambiguous at the poles, and reading the y angle directly
            // makes the side menu orbit a cook who is looking at their chopping board.
            var down = AngularLayout.HeadingOnly(Quaternion.Euler(89.9f, 40f, 0f));
            Assert.That(float.IsNaN(down.x) || float.IsNaN(down.y), Is.False);
            Assert.That(Quaternion.Angle(down, Quaternion.identity), Is.LessThan(180f));
        }

        [Test]
        public void HeadingOnly_KeepsPanelsUpright()
        {
            var heading = AngularLayout.HeadingOnly(Quaternion.Euler(20f, 40f, 35f));
            Assert.That((heading * Vector3.up).y, Is.EqualTo(1f).Within(1e-4f));
        }

        [Test]
        public void LazyFollow_DoesNothingInsideTheDeadZone()
        {
            var head = Vector3.zero;
            var current = new Vector3(0f, 0f, 1f);
            var target = Quaternion.Euler(0f, 3f, 0f) * current;
            var result = AngularLayout.LazyFollow(current, target, head, 8f, 5f, 0.016f);
            Assert.That(Vector3.Distance(result, current), Is.LessThan(1e-6f));
        }

        [Test]
        public void LazyFollow_MovesTowardTheTargetOutsideIt()
        {
            var head = Vector3.zero;
            var current = new Vector3(0f, 0f, 1f);
            var target = Quaternion.Euler(0f, 40f, 0f) * current;
            var result = AngularLayout.LazyFollow(current, target, head, 8f, 5f, 0.1f);
            Assert.That(Vector3.Distance(result, target), Is.LessThan(Vector3.Distance(current, target)));
        }

        [Test]
        public void LazyFollow_IsFrameRateIndependent()
        {
            // A plain Lerp moves twice as fast at 144Hz as at 72Hz, so the HUD's feel would
            // change with the frame rate -- and the venue machine is never the dev machine.
            var head = Vector3.zero;
            var start = new Vector3(0f, 0f, 1f);
            var target = Quaternion.Euler(0f, 60f, 0f) * start;

            var coarse = AngularLayout.LazyFollow(start, target, head, 0f, 5f, 0.1f);

            var fine = start;
            for (var i = 0; i < 10; i++) fine = AngularLayout.LazyFollow(fine, target, head, 0f, 5f, 0.01f);

            Assert.That(Vector3.Distance(coarse, fine), Is.LessThan(0.01f));
        }

        [Test]
        public void CurvedMenuSeat_CentresAnOddCountOnTheEyeLine()
        {
            var seats = new Vector3[3];
            for (var i = 0; i < 3; i++)
                seats[i] = AngularLayout.CurvedMenuSeat(Vector3.zero, Quaternion.identity, -52f, 0.9f, i, 3, 34f, 0.085f);

            Assert.That(seats[1].y, Is.EqualTo(0f).Within(1e-4f));
            Assert.That(seats[0].y, Is.GreaterThan(seats[2].y));
        }

        [Test]
        public void CurvedMenuSeat_KeepsEverySeatOnTheRadius()
        {
            for (var i = 0; i < 4; i++)
            {
                var seat = AngularLayout.CurvedMenuSeat(Vector3.zero, Quaternion.identity, -52f, 0.9f, i, 4, 34f, 0f);
                Assert.That(seat.magnitude, Is.EqualTo(0.9f).Within(1e-4f), $"seat {i}");
            }
        }

        [Test]
        public void WithinComfortFov_AcceptsAheadAndRejectsBehind()
        {
            Assert.IsTrue(AngularLayout.WithinComfortFov(Vector3.forward, Vector3.zero, Quaternion.identity, 41f));
            Assert.IsFalse(AngularLayout.WithinComfortFov(Vector3.back, Vector3.zero, Quaternion.identity, 41f));
        }

        [Test]
        public void WithinComfortFov_UsesHalfTheAngleEitherSide()
        {
            var inside = Quaternion.Euler(0f, 20f, 0f) * Vector3.forward;
            var outside = Quaternion.Euler(0f, 21f, 0f) * Vector3.forward;
            Assert.IsTrue(AngularLayout.WithinComfortFov(inside, Vector3.zero, Quaternion.identity, 41f));
            Assert.IsFalse(AngularLayout.WithinComfortFov(outside, Vector3.zero, Quaternion.identity, 41f));
        }
    }
}
