using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

namespace MRPerception
{
    /// <summary>
    /// Identifies a cropped object with an open-weights vision-language model -- Qwen-VL, reached
    /// either through a hosted endpoint or through one running on the laptop on the table.
    ///
    /// WHY A VLM AT ALL. COCO-80 knows ten foods, all prepared dishes, and no raw ingredients --
    /// no onion, no pepper, no cucumber, no cheese of any kind. Fixing that by training means a
    /// labelled detection dataset and a GPU. An open-vocabulary model needs neither: you ask it
    /// what the thing is and it tells you, including "gruyere" and "romanesco", with no training
    /// step and no class list to maintain.
    ///
    /// WHY QWEN RATHER THAN A CLOSED MODEL. Open weights mean the fallback is real. When the
    /// venue network turns hostile, the same model runs on the laptop over loopback and the
    /// demo does not change -- the relay flips an env var and this class is not rebuilt, because
    /// both upstreams speak chat-completions. A hosted-only model gives you a fallback that is
    /// really just a worse model; this gives you the same one, slower. Master spec rule 12.
    ///
    /// WHY THE ROUND TRIP IS AFFORDABLE. Because it runs ONCE PER TRACKED OBJECT, not once per
    /// frame. A jar on a table does not become a different jar. The local detector localises it
    /// at 5Hz and the track stays alive across frames; this fills in the name later and it
    /// sticks. A session with five objects makes five calls, not eighteen thousand -- which is
    /// the difference between "the app is laggy" and no perceptible latency at all, and on the
    /// hosted free tier the difference between a rate limit and none.
    ///
    /// THAT ARGUMENT HAS A LIMIT, AND THE LOCAL MODEL IS PAST IT. Hosted answers in 1-3s.
    /// qwen2.5vl:3b on an Intel iGPU measured **20-26 seconds** per identification, warm. Five
    /// objects is then two minutes of trickling-in labels, not five seconds. Nothing blocks and
    /// the local label shows throughout, so it degrades rather than breaks -- but do not tell a
    /// judge the offline path is equivalent. It is the same model and the same answers, arriving
    /// an order of magnitude later.
    ///
    /// KEYS DO NOT GO IN THE BUILD. An APK is a zip; a key inside one is extracted in minutes,
    /// and it is YOUR key with YOUR billing. Point <see cref="relayUrl"/> at the relay in
    /// `server/vision-relay.mjs`, which holds the key server-side and chooses the upstream.
    /// Direct mode exists for desk testing and warns every time it is used. Pointing direct mode
    /// at a local Ollama is the one case where it is harmless -- there is no key to leak.
    /// </summary>
    public sealed class VlmVisionProvider : MonoBehaviour, IVisionProvider
    {
        [Header("Endpoint")]
        [Tooltip("Your relay. It holds the key and picks the upstream model. Strongly preferred.")]
        [SerializeField] private string relayUrl = "";

        [Tooltip(
            "Desk testing only, and only meaningful when relayUrl is empty. For a local Ollama " +
            "this is http://127.0.0.1:11434/v1/chat/completions and needs no key.")]
        [SerializeField] private string directEndpoint = "http://127.0.0.1:11434/v1/chat/completions";

        [Tooltip(
            "Desk testing only. A key shipped in a build is a key that has been leaked -- an " +
            "APK is a zip file. Leave empty and use the relay for anything you hand to anyone. " +
            "A local Ollama needs no key, so leaving this empty is the normal case.")]
        [SerializeField] private string directApiKey = "";

        [Header("Model")]
        [Tooltip(
            "Must be on the relay's allowlist. Hosted: qwen/qwen3-vl-30b-a3b-instruct (tested, " +
            "~1-2s, a fraction of a cent). Local Ollama: qwen2.5vl:3b. The relay rejects " +
            "anything else BY NAME, so a mismatch tells you so instead of failing vaguely.")]
        [SerializeField] private string model = "qwen/qwen3-vl-30b-a3b-instruct";

        [Tooltip(
            "low sends a 512px thumbnail at a flat token cost. For naming an object that fills " +
            "the crop it is plenty, and it is several times cheaper and faster than high. " +
            "Ignored by local runtimes, which size images themselves.")]
        [SerializeField] private bool lowDetail = true;

        [Tooltip(
            "Ask for JSON. Qwen honours json_object widely; strict json_schema is an OpenAI " +
            "extension most Qwen endpoints ignore or reject, so it is NOT the default. The " +
            "parser tolerates prose and code fences regardless -- see ExtractJsonObject.")]
        [SerializeField] private ResponseFormat responseFormat = ResponseFormat.JsonObject;

        [Header("Limits")]
        [Tooltip("Longest edge sent. The model downsizes further on low detail anyway.")]
        [SerializeField] private int maxEdgePx = 512;

        [Tooltip(
            "Hosted Qwen answers in 1-3s, so 12 is generous there. LOCAL IS MUCH SLOWER THAN " +
            "IT SOUNDS: qwen2.5vl:3b on an Intel iGPU measured 20-26s per identification, " +
            "warm, at 512px. Set this to 45 for the local upstream. The range goes to 60 " +
            "because 30 left no headroom over a measured 26s worst case.")]
        [SerializeField, Range(1, 60)] private int timeoutSeconds = 12;

        [Tooltip("JPEG quality. 70 is visually fine for this and a third the size of 95.")]
        [SerializeField, Range(30, 95)] private int jpegQuality = 70;

        /// <summary>How to ask for structured output. See <see cref="responseFormat"/>.</summary>
        public enum ResponseFormat
        {
            /// <summary>Send nothing. The prompt still asks for JSON; the parser still copes.</summary>
            None,
            /// <summary>`{"type":"json_object"}`. Understood by OpenRouter and by Ollama.</summary>
            JsonObject,
            /// <summary>OpenAI's strict schema. Only if you have pointed this at a model that honours it.</summary>
            JsonSchema,
        }

        public string Name => "qwen";
        public bool Busy { get; private set; }

        /// <summary>
        /// The reply shape, stated in the prompt rather than only in response_format.
        ///
        /// This is not belt-and-braces, it is the actual mechanism: json_object guarantees the
        /// reply PARSES as JSON, not that it has these three fields. Only the prompt does that.
        /// </summary>
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
            "food to fill the gap. Be terse.\n" +
            "Reply with ONE JSON object and nothing else. No markdown, no code fence, no " +
            "commentary before or after. Exactly these keys:\n" +
            "{\"label\": string, \"confidence\": number between 0 and 1, \"note\": string}";

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
            if (direct && string.IsNullOrEmpty(directEndpoint))
            {
                Debug.LogError("[vision] no relayUrl and no directEndpoint; nothing to call.");
                Busy = false;
                onComplete?.Invoke(VisionResult.None);
                yield break;
            }

            string url = direct ? directEndpoint : relayUrl;
            using var request = new UnityWebRequest(url, UnityWebRequest.kHttpVerbPOST);
            request.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
            request.downloadHandler = new DownloadHandlerBuffer();
            request.SetRequestHeader("Content-Type", "application/json");
            request.timeout = timeoutSeconds;

            if (direct && !string.IsNullOrEmpty(directApiKey))
            {
                // Only a REMOTE direct call leaks anything. A key aimed at loopback is not a
                // secret, so the warning is about the key existing, not about direct mode.
                Debug.LogWarning(
                    "[vision] calling a remote endpoint directly with an embedded key. Fine at " +
                    "a desk, never in a build you hand to anyone.");
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

            switch (responseFormat)
            {
                case ResponseFormat.JsonObject:
                    // The portable one. Constrains the reply to parse as JSON; the KEYS come
                    // from the system prompt.
                    sb.Append("\"response_format\":{\"type\":\"json_object\"},");
                    break;

                case ResponseFormat.JsonSchema:
                    // OpenAI's strict schema. Most Qwen endpoints either ignore this or 400 on
                    // it, which is why it is not the default -- a 400 here reads as "the relay
                    // is broken" when it is really "this model does not implement that field".
                    sb.Append("\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{")
                      .Append("\"name\":\"identification\",\"strict\":true,\"schema\":{")
                      .Append("\"type\":\"object\",\"additionalProperties\":false,")
                      .Append("\"required\":[\"label\",\"confidence\",\"note\"],")
                      .Append("\"properties\":{")
                      .Append("\"label\":{\"type\":\"string\"},")
                      .Append("\"confidence\":{\"type\":\"number\"},")
                      .Append("\"note\":{\"type\":\"string\"}")
                      .Append("}}}},");
                    break;

                case ResponseFormat.None:
                default:
                    break;
            }

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

                // The content is itself a JSON document, as a string. Two parses, not one --
                // and the inner one has to survive whatever the model wrapped it in.
                var parsed = ParseIdentification(content);
                if (parsed == null || string.IsNullOrEmpty(parsed.label)) return VisionResult.None;

                // An explicit 'none' is the model rejecting a false positive, which is different
                // from a network failure and has to reach the caller as a definite verdict.
                if (parsed.label.Trim().Equals("none", StringComparison.OrdinalIgnoreCase))
                {
                    return VisionResult.NoSubject(parsed.note, latencyMs);
                }

                // Asked for 0-1, and told so twice. Qwen still answers 85 often enough that
                // treating it as "clamps to 1.0, maximum confidence" would be a silent lie in
                // the one direction nobody checks.
                float confidence = parsed.confidence > 1f ? parsed.confidence / 100f : parsed.confidence;

                return new VisionResult(
                    parsed.label.Trim(),
                    Mathf.Clamp01(confidence),
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
        /// Pulls the identification out of whatever the model actually said.
        ///
        /// WHY THIS IS NOT JUST FromJson. With OpenAI's strict json_schema the content was
        /// guaranteed to be exactly one JSON object, so one parse was enough. No Qwen endpoint
        /// guarantees that. json_object gets close, but `None` mode, a runtime that ignores the
        /// field, or a model in a chatty mood all produce a fenced block or a leading sentence,
        /// and JsonUtility throws on the first stray character rather than looking past it.
        ///
        /// So: walk the candidate '{' positions and return the first one that both balances and
        /// yields a label. Trying every '{' rather than only the first is what makes a leading
        /// "Here's my answer:" survive, and also a stray brace inside prose.
        /// </summary>
        private static Identification ParseIdentification(string content)
        {
            // The clean case, which is the overwhelming majority: it is already one object.
            string trimmed = content.Trim();
            if (trimmed.StartsWith("{") && trimmed.EndsWith("}"))
            {
                var direct = TryParse(trimmed);
                if (direct != null) return direct;
            }

            for (int i = 0; i < content.Length; i++)
            {
                if (content[i] != '{') continue;
                string candidate = BalancedObjectAt(content, i);
                if (candidate == null) continue;
                var parsed = TryParse(candidate);
                if (parsed != null && !string.IsNullOrEmpty(parsed.label)) return parsed;
            }
            return null;
        }

        /// <summary>
        /// The substring from <paramref name="start"/> to its matching close brace, or null if it
        /// never closes. String literals are tracked so a '}' inside a note does not end the
        /// object early -- which is exactly what a note like "not sure {maybe kale}" would do.
        /// </summary>
        private static string BalancedObjectAt(string s, int start)
        {
            int depth = 0;
            bool inString = false;
            bool escaped = false;

            for (int i = start; i < s.Length; i++)
            {
                char c = s[i];

                if (inString)
                {
                    if (escaped) escaped = false;
                    else if (c == '\\') escaped = true;
                    else if (c == '"') inString = false;
                    continue;
                }

                if (c == '"') inString = true;
                else if (c == '{') depth++;
                else if (c == '}')
                {
                    depth--;
                    if (depth == 0) return s.Substring(start, i - start + 1);
                }
            }
            return null;
        }

        private static Identification TryParse(string candidate)
        {
            try
            {
                return JsonUtility.FromJson<Identification>(candidate);
            }
            catch
            {
                // A candidate that does not parse is the normal case while scanning, not an
                // error worth logging -- Parse logs once if every candidate fails.
                return null;
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
