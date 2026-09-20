using System.Collections;
using IsItDoneYet.Audio;
using IsItDoneYet.Core;
using IsItDoneYet.Design;
using UnityEngine;

namespace IsItDoneYet.App
{
    /// <summary>
    /// Holding a recipe card up to the camera, and confirming what came back.
    ///
    /// The confirm step is not optional and is not a nicety. This is a language model reading a
    /// photograph of handwriting, and it will get a quantity wrong. Saving straight to the
    /// recipe book would put an invented number in front of somebody who is about to cook from
    /// it -- so the transcription is always a DRAFT, the fields are editable, and nothing is
    /// written until the cook says so.
    ///
    /// Whatever the model could not read comes back named, and those fields are marked rather
    /// than filled with a plausible guess.
    /// </summary>
    public class ScanCardPanel : MonoBehaviour
    {
        public enum Phase { Idle, Aiming, Scanning, Confirming, Failed }

        [Header("Wiring")]
        public ApiClient Api;
        public FrameUploader Uploader;
        public GlassPanel Viewfinder;
        public GlassPanel SweepBar;
        public Label Status;
        public Label Preview;

        [Header("Viewfinder")]
        public Vector2 FrameSizeM = new Vector2(0.26f, 0.18f);
        public float SweepSeconds = 1.4f;

        public Phase Current { get; private set; } = Phase.Idle;
        public RecipeDto Draft { get; private set; }

        float _sweepStart;

        public void BeginAiming()
        {
            Current = Phase.Aiming;
            Draft = null;
            SetStatus("Hold the card in the frame");
        }

        public void Capture()
        {
            if (Current != Phase.Aiming) return;
            if (Uploader == null || Uploader.LastJpeg == null)
            {
                SetStatus("No camera frame yet");
                Current = Phase.Failed;
                return;
            }
            StartCoroutine(Scan());
        }

        IEnumerator Scan()
        {
            Current = Phase.Scanning;
            _sweepStart = Time.time;
            SetStatus("Reading…");
            SoundManager.Instance?.Play(Sfx.PokeClick);

            var image = $"data:image/jpeg;base64,{System.Convert.ToBase64String(Uploader.LastJpeg)}";
            yield return Api.ScanRecipe(image, result =>
            {
                if (!result.Ok || result.Value == null || !result.Value.ok || result.Value.draft == null)
                {
                    Current = Phase.Failed;
                    // Names which failure it was. "Could not read" and "coach offline" call for
                    // completely different actions from the cook, and a single generic message
                    // leaves them retrying the wrong thing.
                    var offline = result.Ok && result.Value != null && result.Value.offline;
                    SetStatus(offline ? "Coach offline — try again when connected" : "Couldn't read that card");
                    SoundManager.Instance?.Play(Sfx.Warning);
                    return;
                }

                Draft = result.Value.draft;
                Current = Phase.Confirming;
                SetStatus($"{Draft.title} — check it before saving");
                RenderPreview();
                SoundManager.Instance?.Play(Sfx.StepComplete);
            });
        }

        void RenderPreview()
        {
            if (Preview == null || Draft == null) return;

            var builder = new System.Text.StringBuilder();
            builder.Append(Draft.title).Append('\n');
            if (Draft.ingredients != null)
            {
                for (var i = 0; i < Draft.ingredients.Length && i < 10; i++)
                {
                    var ingredient = Draft.ingredients[i];
                    builder.Append("• ").Append(ingredient.quantity).Append(' ')
                           .Append(ingredient.unit).Append(' ').Append(ingredient.name).Append('\n');
                }
            }
            if (Draft.steps != null) builder.Append(Draft.steps.Length).Append(" steps");
            Preview.SetText(builder.ToString());
        }

        /// <summary>Writes the confirmed draft to the recipe book. Only ever called by the cook.</summary>
        public IEnumerator Save()
        {
            if (Current != Phase.Confirming || Draft == null) yield break;
            SetStatus("Saving…");

            // Through the ordinary recipe endpoint, which validates this exactly as it would a
            // hand-typed one. A transcription of a photograph gets no special trust.
            yield return Api.CreateRecipe(Draft, result =>
            {
                if (result.Ok)
                {
                    Current = Phase.Idle;
                    SetStatus("Saved to your book");
                    SoundManager.Instance?.Play(Sfx.RankUp);
                }
                else
                {
                    // The draft is kept. Losing a transcription the cook has just spent a
                    // minute correcting, because the save failed, would be the worst possible
                    // moment to drop it.
                    Current = Phase.Confirming;
                    SetStatus("Couldn't save — your edits are still here");
                    SoundManager.Instance?.Play(Sfx.Warning);
                }
            });
        }

        void Update()
        {
            if (Viewfinder != null)
            {
                Viewfinder.SizeM = FrameSizeM;
                Viewfinder.Fill = ColorRole.Surface;
                Viewfinder.OpacityScale = Current == Phase.Aiming || Current == Phase.Scanning ? 0.12f : 0f;
                Viewfinder.Border = ColorRole.Accent;
                Viewfinder.BorderPx = 5f;
                Viewfinder.Dashed = Current == Phase.Aiming;
                Viewfinder.Refresh();
            }

            if (SweepBar == null) return;
            var sweeping = Current == Phase.Scanning;
            SweepBar.gameObject.SetActive(sweeping);
            if (!sweeping) return;

            // A slow sweep, bounded well under the 3Hz flash limit and with no full-field
            // brightness change -- a scanning animation is exactly the kind of thing that ends
            // up strobing.
            var t = Mathf.Repeat((Time.time - _sweepStart) / Mathf.Max(0.3f, SweepSeconds), 1f);
            SweepBar.SizeM = new Vector2(FrameSizeM.x, 0.004f);
            SweepBar.transform.localPosition = new Vector3(0f, Mathf.Lerp(FrameSizeM.y * 0.5f, -FrameSizeM.y * 0.5f, t), -0.002f);
            SweepBar.Fill = ColorRole.Accent;
            SweepBar.Refresh();
        }

        void SetStatus(string text)
        {
            if (Status != null) Status.SetText(text);
        }
    }
}
