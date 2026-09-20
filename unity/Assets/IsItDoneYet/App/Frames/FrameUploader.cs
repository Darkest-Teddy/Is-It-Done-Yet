using System;
using System.Collections;
using System.Collections.Generic;
using IsItDoneYet.Core;
using IsItDoneYet.Design;
using UnityEngine;

namespace IsItDoneYet.App
{
    /// <summary>
    /// Takes a frame every few seconds, shrinks it, and sends it to the server.
    ///
    /// Three rules, each of which is a bug that would otherwise happen:
    ///
    /// <b>One request in flight, ever.</b> The camera produces frames faster than a vision
    /// model answers. Without this, a slow response means requests pile up, each one costing
    /// money and describing a pan that has already moved on -- and the coach starts narrating
    /// the past. A dropped frame costs nothing; there is another in three seconds.
    ///
    /// <b>512px on the long edge, JPEG under ~60KB.</b> Not for bandwidth alone: the model
    /// charges 2048 tokens per image whatever its size, so a 1280x960 upload buys nothing and
    /// spends a second of venue uplink.
    ///
    /// <b>The readback is asynchronous.</b> <c>ReadPixels</c> stalls the render thread until
    /// the GPU catches up, which on a mobile chip is tens of milliseconds -- a visible hitch,
    /// every three seconds, forever. <c>AsyncGPUReadback</c> costs a frame of latency that
    /// nothing here can perceive.
    /// </summary>
    public class FrameUploader : MonoBehaviour
    {
        [Header("Cadence")]
        public float SecondsBetweenFrames = 3f;

        [Header("Encoding")]
        public int LongEdgePx = 512;
        [Tooltip("Target upload size. The encoder steps quality down until it fits.")]
        public int MaxJpegBytes = 60_000;
        [Range(10, 95)] public int StartQuality = 70;

        [Header("Wiring")]
        public ApiClient Api;

        IFrameSource _source;
        RenderTexture _scaled;
        Texture2D _readback;
        bool _inFlight;
        float _nextCaptureAt;
        bool _consented;

        /// <summary>The pose at the moment of the frame this answer describes.</summary>
        public Pose LastCapturePose { get; private set; }
        public int LastUploadBytes { get; private set; }
        public int FramesDropped { get; private set; }
        public int FramesSent { get; private set; }

        /// <summary>Raised with each analysis, offline ones included.</summary>
        public event Action<CoachResult> Analyzed;

        /// <summary>The request the uploader fills in per frame. Owned by the run controller.</summary>
        public Func<AnalyzeRequestDto> BuildRequest;

        /// <summary>The most recent JPEG, kept for the replay thumbnails.</summary>
        public byte[] LastJpeg { get; private set; }

        public void SetSource(IFrameSource source)
        {
            _source?.StopSource();
            _source = source;
            _source?.StartSource();
        }

        /// <summary>
        /// Nothing is captured before this is true, and turning it off stops mid-run.
        ///
        /// Consent is a switch, not a one-time gate: the cook can withdraw it from the menu and
        /// the camera must stop that second, not at the end of the recipe.
        /// </summary>
        public void SetConsent(bool consented)
        {
            _consented = consented;
            AdaptiveLegibility.SetEnabled(consented);
            if (!consented) _inFlight = false;
        }

        public bool IsCapturing => _consented && _source != null && _source.IsReady;

        void OnDestroy()
        {
            if (_scaled != null) _scaled.Release();
            if (_readback != null) Destroy(_readback);
            _source?.StopSource();
        }

        void Update()
        {
            if (!IsCapturing || _inFlight || Api == null || BuildRequest == null) return;
            if (Time.time < _nextCaptureAt) return;
            _nextCaptureAt = Time.time + Mathf.Max(0.5f, SecondsBetweenFrames);
            StartCoroutine(CaptureAndSend());
        }

        IEnumerator CaptureAndSend()
        {
            var source = _source.GetTexture();
            if (source == null) yield break;

            LastCapturePose = _source.GetPose();
            _inFlight = true;

            var size = FitLongEdge(source.width, source.height, LongEdgePx);
            EnsureBuffers(size);

            // Blit does the downscale on the GPU. Doing it on the CPU after a full-resolution
            // readback would be both slower and a much larger stall.
            Graphics.Blit(source, _scaled);

            var request = UnityEngine.Rendering.AsyncGPUReadback.Request(_scaled, 0, TextureFormat.RGBA32);
            while (!request.done) yield return null;

            if (request.hasError)
            {
                _inFlight = false;
                yield break;
            }

            _readback.LoadRawTextureData(request.GetData<byte>());
            _readback.Apply(false);

            // The room's brightness, from the frame already in hand. This is the whole cost of
            // adaptive legibility: one strided pass over pixels that were going to be here
            // anyway. Nothing extra is captured, stored or sent.
            AdaptiveLegibility.Sample(_readback.GetPixels32(), SecondsBetweenFrames);

            var jpeg = Encode(_readback);
            LastJpeg = jpeg;
            LastUploadBytes = jpeg.Length;

            var payload = BuildRequest();
            if (payload == null)
            {
                _inFlight = false;
                yield break;
            }
            payload.image = $"data:image/jpeg;base64,{Convert.ToBase64String(jpeg)}";

            yield return Api.Analyze(payload, result =>
            {
                _inFlight = false;
                FramesSent++;

                var coach = new CoachResult { AtMs = Mathf.RoundToInt(Time.time * 1000f) };
                if (!result.Ok || result.Value == null)
                {
                    // A failed request and an offline coach are the same thing to everything
                    // downstream: no opinion. Scoring is local and carries on regardless.
                    coach.Offline = true;
                    coach.Unsure = true;
                    FramesDropped++;
                }
                else
                {
                    var dto = result.Value;
                    coach.Offline = dto.offline;
                    coach.Unsure = dto.unsure;
                    coach.CoachLine = dto.coachLine;
                    if (dto.observations != null)
                    {
                        for (var i = 0; i < dto.observations.Length; i++)
                        {
                            var o = dto.observations[i];
                            coach.Observations.Add(new CoachObservation
                            {
                                Item = o.item,
                                Status = ScoringEngine.ParseStatus(o.status),
                                Confidence = o.confidence,
                                Evidence = o.evidence,
                            });
                        }
                    }
                }
                Analyzed?.Invoke(coach);
            });
        }

        /// <summary>
        /// Steps quality down until the JPEG fits, then gives up and sends what it has.
        ///
        /// Three attempts, not a binary search: the encode is the expensive part and a
        /// countertop photo at 512px lands under 60KB at quality 70 almost always. The give-up
        /// is deliberate -- a frame slightly over budget is better than no frame, and the
        /// server's own limit is far higher.
        /// </summary>
        byte[] Encode(Texture2D texture)
        {
            var quality = StartQuality;
            var bytes = texture.EncodeToJPG(quality);
            for (var attempt = 0; attempt < 2 && bytes.Length > MaxJpegBytes; attempt++)
            {
                quality = Mathf.Max(25, quality - 20);
                bytes = texture.EncodeToJPG(quality);
            }
            return bytes;
        }

        void EnsureBuffers(Vector2Int size)
        {
            if (_scaled != null && _scaled.width == size.x && _scaled.height == size.y) return;

            if (_scaled != null) _scaled.Release();
            _scaled = new RenderTexture(size.x, size.y, 0, RenderTextureFormat.ARGB32) { name = "IsItDoneYet/FrameScale" };
            _scaled.Create();

            if (_readback != null) Destroy(_readback);
            _readback = new Texture2D(size.x, size.y, TextureFormat.RGBA32, false);
        }

        /// <summary>
        /// Aspect-preserving fit, rounded to even dimensions.
        ///
        /// Odd dimensions are legal and are a bad idea: JPEG's chroma subsampling works in 2x2
        /// blocks, and an odd edge costs a padded block for nothing.
        /// </summary>
        public static Vector2Int FitLongEdge(int width, int height, int longEdge)
        {
            if (width <= 0 || height <= 0) return new Vector2Int(longEdge, longEdge);
            var scale = (float)longEdge / Mathf.Max(width, height);
            if (scale >= 1f) return new Vector2Int(Even(width), Even(height));
            return new Vector2Int(Even(Mathf.RoundToInt(width * scale)), Even(Mathf.RoundToInt(height * scale)));
        }

        static int Even(int value) => Mathf.Max(2, value - (value & 1));
    }
}
