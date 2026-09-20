using System.Collections.Generic;
using Meta.XR;
using Meta.XR.MRUtilityKit;
using UnityEngine;

namespace MRPerception
{
    /// <summary>
    /// Turns a 2D detection into a world-space placement.
    ///
    /// There are two raycast targets on a Quest 3 and they answer different questions:
    ///
    ///   <b>EnvironmentRaycastManager</b> (Depth API) casts against the live depth map. It hits
    ///   ARBITRARY geometry -- a bowl, a banana, your hand -- because it is measuring what is
    ///   actually there this frame. Quest 3 and 3S only, and it needs the depth sensor to have
    ///   something to work with, so it degrades on featureless or very dark surfaces.
    ///
    ///   <b>MRUK</b> casts against the scene model: the planes and volumes from room setup. It
    ///   is rock stable and gives you a semantic label ("TABLE", "WALL_FACE"), but it only knows
    ///   about furniture the user scanned. A banana is not in the scene model.
    ///
    /// So: depth first for the object itself, MRUK as the fallback and as the source of the
    /// SURFACE ORIENTATION. That combination is what this class implements, and the fallback
    /// ordering matters -- depth alone gives you a position with no reliable normal on a small
    /// object, and MRUK alone cannot see the food at all.
    /// </summary>
    public sealed class DetectionRaycaster : MonoBehaviour
    {
        [Header("Raycast targets")]
        [Tooltip("Meta's Depth API raycaster. Leave empty to use MRUK only.")]
        [SerializeField] private EnvironmentRaycastManager environmentRaycast;

        // Live from the registry so they can be tuned in-headset. Distances in particular are
        // impossible to guess from a desk -- the right maximum depends on how far the table is.
        private float maxDistance => PerceptionTunables.Get(PerceptionTunables.RayMaxDistance);
        private float minDistance => PerceptionTunables.Get(PerceptionTunables.RayMinDistance);
        private float surfaceOffset => PerceptionTunables.Get(PerceptionTunables.SurfaceOffset);

        /// <summary>
        /// Places one detection. Returns false when nothing solid was hit, which is a normal
        /// outcome and not an error -- a detection against a far wall, a window, or the sky has
        /// no depth to land on, and inventing a distance for it would put a hologram in mid-air
        /// with total confidence.
        /// </summary>
        public bool TryPlace(
            in Detection2D detection,
            in CapturedFrame frame,
            PassthroughCameraFeed feed,
            out Detection3D placed)
        {
            placed = default;

            Ray ray = feed.PixelToWorldRay(detection.AnchorPixel, frame);

            if (!TryRaycast(ray, out Vector3 point, out Vector3 normal))
            {
                return false;
            }

            float distance = Vector3.Distance(frame.CameraPosition, point);
            if (distance < minDistance || distance > maxDistance) return false;

            Quaternion rotation = RotationFor(detection, frame, feed, normal);
            Vector2 size = EstimateSize(detection, frame, feed, distance);

            placed = new Detection3D(point + normal * surfaceOffset, rotation, size, detection);
            return true;
        }

        private bool TryRaycast(Ray ray, out Vector3 point, out Vector3 normal)
        {
            point = default;
            normal = Vector3.up;

            // Depth first: it is the only one that can see an object that is not furniture.
            if (environmentRaycast != null && EnvironmentRaycastManager.IsSupported)
            {
                if (environmentRaycast.Raycast(ray, out EnvironmentRaycastHit hit, maxDistance))
                {
                    point = hit.point;

                    // The depth normal is noisy on small or shiny objects, so it is only
                    // trusted when it is confidently oriented. Below that the POSITION is still
                    // good -- depth measured it -- but the orientation is not, so the scene
                    // model is asked for a clean normal for the surface underneath.
                    //
                    // This used to return unconditionally, which meant the MRUK half of the
                    // design was never reached and every low-confidence hit silently became
                    // Vector3.up.
                    if (hit.normalConfidence > 0.5f)
                    {
                        normal = hit.normal;
                        return true;
                    }

                    normal = NormalFromScene(ray) ?? Vector3.up;
                    return true;
                }
            }

            Vector3? sceneNormal = NormalFromSceneWithPoint(ray, out Vector3 scenePoint);
            if (sceneNormal.HasValue)
            {
                point = scenePoint;
                normal = sceneNormal.Value;
                return true;
            }

            return false;
        }

        /// <summary>The scene model's normal at this ray, or null when it does not know.</summary>
        private Vector3? NormalFromScene(Ray ray) => NormalFromSceneWithPoint(ray, out _);

        private Vector3? NormalFromSceneWithPoint(Ray ray, out Vector3 point)
        {
            point = default;
            MRUKRoom room = MRUK.Instance != null ? MRUK.Instance.GetCurrentRoom() : null;
            if (room != null &&
                room.Raycast(ray, maxDistance, out RaycastHit mrukHit, out MRUKAnchor _))
            {
                point = mrukHit.point;
                return mrukHit.normal;
            }

            return null;
        }

        /// <summary>
        /// A document gets its orientation from its own four corners; anything else is laid
        /// flat against the surface it was found on.
        ///
        /// This is the payoff for detecting documents as quadrilaterals rather than as boxes.
        /// The top edge of the quad, unprojected, gives the page's real "right" direction in
        /// world space -- so a hologram over a page rotated 30 degrees on the desk is rotated 30
        /// degrees too, rather than sitting axis-aligned and obviously wrong.
        /// </summary>
        private Quaternion RotationFor(
            in Detection2D detection, in CapturedFrame frame,
            PassthroughCameraFeed feed, Vector3 normal)
        {
            if (detection.Kind != DetectionKind.Document || detection.Corners == null)
            {
                return Quaternion.LookRotation(
                    Vector3.ProjectOnPlane(frame.CameraRotation * Vector3.forward, normal).normalized,
                    normal);
            }

            // Corners are TL, TR, BR, BL. Cast the top edge's endpoints and use the vector
            // between them as the page's right-hand axis.
            if (TryRaycast(feed.PixelToWorldRay(detection.Corners[0], frame), out Vector3 tl, out _) &&
                TryRaycast(feed.PixelToWorldRay(detection.Corners[1], frame), out Vector3 tr, out _))
            {
                Vector3 right = (tr - tl).normalized;
                if (right.sqrMagnitude > 0.0001f)
                {
                    Vector3 forward = Vector3.Cross(right, normal).normalized;
                    if (forward.sqrMagnitude > 0.0001f)
                    {
                        return Quaternion.LookRotation(forward, normal);
                    }
                }
            }

            return Quaternion.LookRotation(
                Vector3.ProjectOnPlane(frame.CameraRotation * Vector3.forward, normal).normalized,
                normal);
        }

        /// <summary>
        /// Real-world size from the pixel box and the hit distance.
        ///
        /// Similar triangles: an object subtending N pixels at distance D is N * D / focal
        /// metres across. This is what lets a bounding-box prefab be scaled to actually fit the
        /// thing rather than being a fixed-size cube, and it costs one division.
        ///
        /// It assumes the object is roughly fronto-parallel and sitting at the distance its
        /// bottom edge hit at. For a tall object seen from above that underestimates the height,
        /// which fails in the safe direction -- a slightly small box still reads as fitting.
        /// </summary>
        private Vector2 EstimateSize(
            in Detection2D detection, in CapturedFrame frame,
            PassthroughCameraFeed feed, float distance)
        {
            Ray left = feed.PixelToWorldRay(
                new Vector2(detection.PixelRect.xMin, detection.PixelRect.center.y), frame);
            Ray right = feed.PixelToWorldRay(
                new Vector2(detection.PixelRect.xMax, detection.PixelRect.center.y), frame);
            Ray top = feed.PixelToWorldRay(
                new Vector2(detection.PixelRect.center.x, detection.PixelRect.yMin), frame);
            Ray bottom = feed.PixelToWorldRay(
                new Vector2(detection.PixelRect.center.x, detection.PixelRect.yMax), frame);

            float width = Vector3.Distance(
                left.origin + left.direction * distance,
                right.origin + right.direction * distance);
            float height = Vector3.Distance(
                top.origin + top.direction * distance,
                bottom.origin + bottom.direction * distance);

            return new Vector2(width, height);
        }
    }
}
