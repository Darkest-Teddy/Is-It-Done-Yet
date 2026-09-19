using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

namespace MRPerception
{
    /// <summary>
    /// Identifies a cropped object with GPT vision.
    ///
    /// WHY A VLM AT ALL. COCO-80 knows ten foods, all prepared dishes, and no raw ingredients --
    /// no onion, no pepper, no cucumber, no cheese of any kind. Fixing that by training means a
    /// labelled detection dataset and a GPU. An open-vocabulary model needs neither: you ask it
    /// what the thing is and it tells you, including "gruyere" and "romanesco", with no training
    /// step and no class list to maintain.
    ///
    /// WHY IT IS NOT SLOW, despite a one-second round trip. Because it runs ONCE PER TRACKED
    /// OBJECT, not once per frame. A jar on a table does not become a different jar. The local
    /// detector localises it at 5Hz and the track stays alive across frames; this fills in the
    /// name a second later and it sticks. A session with five objects makes five calls, not
    /// eighteen thousand -- which is also the difference between fractions of a cent and a real
    /// bill, and between "the app is laggy" and no perceptible latency at all.
    ///
    /// KEYS DO NOT GO IN THE BUILD. An APK is a zip; a key inside one is extracted in minutes,
    /// and it is YOUR key with YOUR billing. Point <see cref="relayUrl"/> at a thin proxy that
    /// holds the key server-side -- master spec 6 already specifies one. Direct mode exists for
    /// desk testing and warns every time it is used.
    /// </summary>
    public sealed class OpenAiVisionProvider : MonoBehaviour, IVisionProvider
    {
        [Header("Endpoint")]
        [Tooltip("Your relay. It holds the key and forwards to OpenAI. Strongly preferred.")]
        [SerializeField] private string relayUrl = "";

        [Tooltip(
            "Desk testing only. A key shipped in a build is a key that has been leaked -- an " +
            "APK is a zip file. Leave empty and use the relay for anything you hand to anyone.")]
        [SerializeField] private string directApiKey = "";

        [Header("Model")]
        [Tooltip("gpt-4o-mini is fast and cheap and easily good enough to name a vegetable.")]
        [SerializeField] private string model = "gpt-4o-mini";

        [Tooltip(
            "low sends a 512px thumbnail at a flat token cost. For naming an object that fills " +
            "the crop it is plenty, and it is several times cheaper and faster than high.")]
        [SerializeField] private bool lowDetail = true;

        [Header("Limits")]
        [Tooltip("Longest edge sent. The model downsizes to 512 on low detail anyway.")]
        [SerializeField] private int maxEdgePx = 512;

        [SerializeField, Range(1, 30)] private int timeoutSeconds = 8;

        [Tooltip("JPEG quality. 70 is visually fine for this and a third the size of 95.")]
        [SerializeField, Range(30, 95)] private int jpegQuality = 70;

        public string Name => "openai";
        public bool Busy { get; private set; }

        private const string DefaultEndpoint = "https://api.openai.com/v1/chat/completions";

        private const string SystemPrompt =
            "You identify a single food item, ingredient, or document in a cropped photo taken " +
            "by a mixed-reality headset in a kitchen. Reply with the most specific common name " +
            "you are confident in. Prefer an ingredient name over a dish name. If you cannot " +
            "tell, say so in the note and give a broader label rather than guessing a specific " +
            "one: 'hard cheese' is a useful answer, a wrong 'gruyere' is not.\n" +
            "If the crop contains NO food, ingredient or document -- it is worktop, a cabinet, " +
            "a hand, an appliance, wood grain, or nothing identifiable -- set label to exactly " +
            "'none'. This matters: the local detector produces false positives on kitchen " +
            "surfaces, and saying 'none' is how they get discarded. Never invent a plausible " +
            "food to fill the gap. Be terse.";

        public void Identify(Texture2D crop, string hint, VisionSubject subject,
            Action<VisionResult> onComplete)
        {
            if (crop == null || Busy)
            {
                onComplete?.Invoke(VisionResult.None);
                return;
            }
            StartCoroutine(Run(crop, hint, subject, onComplete));
        }

        private IEnumerator Run(Texture2D crop, string hint, VisionSubject subject,
            Action<VisionResult> onComplete)
        {
            Busy = true;
            float started = Time.realtimeSinceStartup;

            string body;
            try
            {
                body = BuildRequest(crop, hint, subject);
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[vision] could not encode crop: {e.Message}");
                Busy = false;
                onComplete?.Invoke(VisionResult.None);
                yield break;
            }

            bool direct = string.IsNullOrEmpty(relayUrl);
            if (direct && string.IsNullOrEmpty(directApiKey))
            {
                Debug.LogError("[vision] no relayUrl and no directApiKey; nothing to call.");
                Busy = false;
                onComplete?.Invoke(VisionResult.None);
                yield break;
            }

            string url = direct ? DefaultEndpoint : relayUrl;
            using var request = new UnityWebRequest(url, UnityWebRequest.kHttpVerbPOST);
            request.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
            request.downloadHandler = new DownloadHandlerBuffer();
            request.SetRequestHeader("Content-Type", "application/json");
            request.timeout = timeoutSeconds;

            if (direct)
            {
                Debug.LogWarning(
                    "[vision] calling OpenAI directly with an embedded key. Fine at a desk, " +
                    "never in a build you hand to anyone.");
                request.SetRequestHeader("Authorization", "Bearer " + directApiKey);
            }

            yield return request.SendWebRequest();

            float latency = (Time.realtimeSinceStartup - started) * 1000f;
            Busy = false;

            if (request.result != UnityWebRequest.Result.Success)
            {
                // A timeout is the expected outcome on venue wifi, not an exception. The caller
                // keeps the local detector's label and carries on.
                Debug.LogWarning($"[vision] {request.result}: {request.error}");
                onComplete?.Invoke(VisionResult.None);
                yield break;
            }

            onComplete?.Invoke(Parse(request.downloadHandler.text, latency));
        }

        private string BuildRequest(Texture2D crop, string hint, VisionSubject subject)
        {
            Texture2D sized = Downscale(crop, maxEdgePx);
            byte[] jpeg = sized.EncodeToJPG(jpegQuality);
            if (sized != crop) Destroy(sized);
            string b64 = Convert.ToBase64String(jpeg);

            string user;
            if (subject == VisionSubject.Contents)
            {
                // Name the contents, not the container. Without this instruction the model very
                // reasonably answers "a bowl", which is the one thing already known.
                user =
                    $"This is a {(string.IsNullOrEmpty(hint) ? "container" : hint)}. Name what " +
                    "is INSIDE it, not the container itself. If it is empty, label 'none'. " +
                    "Reply as JSON.";
            }
            else
            {
                user = string.IsNullOrEmpty(hint)
                    ? "What is this? Reply as JSON."
                    : $"What is this? A local detector guessed '{hint}', which may be wrong or " +
                      "too general -- it is a COCO model and it is often wrong on kitchen " +
                      "surfaces. Reply as JSON.";
            }

            var sb = new StringBuilder(jpeg.Length * 2);
            sb.Append("{\"model\":\"").Append(Esc(model)).Append("\",");
            sb.Append("\"max_tokens\":120,");
            sb.Append("\"temperature\":0,");

            // Structured output, so the reply is parseable JSON rather than prose that happens
            // to contain a name. Without this the model will sometimes answer "This appears to
            // be a cucumber!" and every parser downstream has to cope with sentences.
            sb.Append("\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{")
              .Append("\"name\":\"identification\",\"strict\":true,\"schema\":{")
              .Append("\"type\":\"object\",\"additionalProperties\":false,")
              .Append("\"required\":[\"label\",\"confidence\",\"note\"],")
              .Append("\"properties\":{")
              .Append("\"label\":{\"type\":\"string\"},")
              .Append("\"confidence\":{\"type\":\"number\"},")
              .Append("\"note\":{\"type\":\"string\"}")
              .Append("}}}},");

            sb.Append("\"messages\":[");
            sb.Append("{\"role\":\"system\",\"content\":\"").Append(Esc(SystemPrompt)).Append("\"},");
            sb.Append("{\"role\":\"user\",\"content\":[");
            sb.Append("{\"type\":\"text\",\"text\":\"").Append(Esc(user)).Append("\"},");
            sb.Append("{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/jpeg;base64,")
              .Append(b64).Append("\",\"detail\":\"").Append(lowDetail ? "low" : "high")
              .Append("\"}}");
            sb.Append("]}]}");
            return sb.ToString();
        }

        /// <summary>
        /// Shrinks so the longest edge is at most <paramref name="maxEdge"/>.
        ///
        /// Uploading a 900x700 crop to be downsized server-side wastes the upload, which on
        /// venue wifi is the slowest part of the whole round trip by a wide margin.
        /// </summary>
        private static Texture2D Downscale(Texture2D source, int maxEdge)
        {
            int longest = Mathf.Max(source.width, source.height);
            if (longest <= maxEdge) return source;

            float scale = maxEdge / (float)longest;
            int w = Mathf.Max(1, Mathf.RoundToInt(source.width * scale));
            int h = Mathf.Max(1, Mathf.RoundToInt(source.height * scale));

            // Through a RenderTexture so the GPU does the filtering. A managed pixel loop here
            // would be a visible hitch on the frame an object is first identified.
            RenderTexture rt = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGB32);
            Graphics.Blit(source, rt);
            RenderTexture previous = RenderTexture.active;
            RenderTexture.active = rt;

            var result = new Texture2D(w, h, TextureFormat.RGB24, false);
            result.ReadPixels(new Rect(0, 0, w, h), 0, 0);
            result.Apply();

            RenderTexture.active = previous;
            RenderTexture.ReleaseTemporary(rt);
            return result;
        }

        private VisionResult Parse(string json, float latencyMs)
        {
            try
            {
                var envelope = JsonUtility.FromJson<ChatResponse>(json);
                string content = envelope?.choices is { Length: > 0 }
                    ? envelope.choices[0].message.content
                    : null;
                if (string.IsNullOrEmpty(content)) return VisionResult.None;

                // The content is itself a JSON document, as a string. Two parses, not one.
                var parsed = JsonUtility.FromJson<Identification>(content);
                if (parsed == null || string.IsNullOrEmpty(parsed.label)) return VisionResult.None;

                // An explicit 'none' is the model rejecting a false positive, which is different
                // from a network failure and has to reach the caller as a definite verdict.
                if (parsed.label.Trim().Equals("none", StringComparison.OrdinalIgnoreCase))
                {
                    return VisionResult.NoSubject(parsed.note, latencyMs);
                }

                return new VisionResult(
                    parsed.label.Trim(),
                    Mathf.Clamp01(parsed.confidence),
                    parsed.note,
                    latencyMs);
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[vision] unparseable reply: {e.Message}");
                return VisionResult.None;
            }
        }

        /// <summary>
        /// Minimal JSON string escaping.
        ///
        /// Only the prompts go through this -- the base64 payload is already safe by
        /// construction -- but a stray quote or newline in a prompt would produce a malformed
        /// request and a 400 that looks like an API problem rather than a quoting one.
        /// </summary>
        private static string Esc(string s)
        {
            if (string.IsNullOrEmpty(s)) return string.Empty;
            var sb = new StringBuilder(s.Length + 16);
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }

        // JsonUtility needs concrete serializable types and cannot do dictionaries, so the
        // response shape is spelled out. Deliberately no Newtonsoft dependency: it is present in
        // some Meta SDK versions and absent in others, and this is not worth a package hunt.
        [Serializable] private sealed class ChatResponse { public Choice[] choices; }
        [Serializable] private sealed class Choice { public Message message; }
        [Serializable] private sealed class Message { public string content; }
        [Serializable] private sealed class Identification
        {
            public string label;
            public float confidence;
            public string note;
        }
    }
}
