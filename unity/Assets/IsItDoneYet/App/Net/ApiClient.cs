using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

namespace IsItDoneYet.App
{
    /// <summary>
    /// The only thing in this app that talks to a network, and it only ever talks to one server.
    ///
    /// The headset never calls a model. It posts a frame here and the server holds the key --
    /// which is not only a secrets decision: a key in an APK is a key published, because an APK
    /// is a zip file and anyone with the headset has one.
    ///
    /// Every call has a timeout and a fallback. That is not a nicety at a venue: the wifi at a
    /// hackathon is saturated by definition, and an app whose recipe list is empty because a
    /// request hung is an app that cannot be demonstrated. Bundled recipes, local scoring and a
    /// cached board mean the network is an enhancement rather than a dependency.
    /// </summary>
    public class ApiClient : MonoBehaviour
    {
        [Tooltip("https://... to the server. Must be HTTPS on device; Quest blocks cleartext by default.")]
        public string BaseUrl = "https://orders-surgical-backup-typical.trycloudflare.com";

        [Tooltip("Per-request ceiling. Past this the caller uses its fallback.")]
        public int TimeoutSeconds = 8;

        [Tooltip("The coach frame is bigger and slower than everything else, so it gets its own.")]
        public int CoachTimeoutSeconds = 14;

        /// <summary>True once any call has succeeded. Drives the offline badge in the HUD.</summary>
        public bool Online { get; private set; }

        /// <summary>The session this run is submitting under. Issued by the server.</summary>
        public string SessionId { get; private set; }
        public string SessionToken { get; private set; }

        string Url(string path) => $"{BaseUrl.TrimEnd('/')}{path}";

        /// <summary>
        /// One request, one place.
        ///
        /// The shape is a coroutine rather than async/await because UnityWebRequest's
        /// completion has to be observed on the main thread anyway, and a coroutine cancelled
        /// by its GameObject being destroyed is cancelled for free -- an orphaned Task writing
        /// into a destroyed component is a NullReference nobody can reproduce.
        /// </summary>
        IEnumerator Send<T>(string method, string path, string body, int timeoutSeconds, Action<ApiResult<T>> done)
        {
            using var request = new UnityWebRequest(Url(path), method);
            request.downloadHandler = new DownloadHandlerBuffer();
            if (body != null)
            {
                request.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
                request.SetRequestHeader("Content-Type", "application/json");
            }
            request.timeout = Mathf.Max(1, timeoutSeconds);

            yield return request.SendWebRequest();

            if (request.result != UnityWebRequest.Result.Success)
            {
                Online = false;
                // The response body is deliberately not surfaced. It can echo the request, and
                // the request may contain a photograph of somebody's kitchen.
                done(ApiResult<T>.Failure($"{request.responseCode} {request.result}"));
                yield break;
            }

            T parsed;
            try
            {
                parsed = JsonUtility.FromJson<T>(request.downloadHandler.text);
            }
            catch (Exception error)
            {
                done(ApiResult<T>.Failure($"unparseable response: {error.Message}"));
                yield break;
            }

            if (parsed == null)
            {
                done(ApiResult<T>.Failure("empty response"));
                yield break;
            }

            Online = true;
            done(ApiResult<T>.Success(parsed));
        }

        public IEnumerator GetRecipes(Action<ApiResult<RecipeListDto>> done) =>
            Send("GET", "/api/recipes?limit=50", null, TimeoutSeconds, done);

        public IEnumerator GetRecipe(string slug, Action<ApiResult<RecipeDto>> done) =>
            Send("GET", $"/api/recipes/{UnityWebRequest.EscapeURL(slug)}", null, TimeoutSeconds, done);

        public IEnumerator GetLeaderboard(Action<ApiResult<LeaderboardDto>> done) =>
            Send("GET", "/api/leaderboard?limit=20", null, TimeoutSeconds, done);

        /// <summary>
        /// Starts a run and remembers the token.
        ///
        /// Called at the START of a run, not at submission, because the server's plausibility
        /// check measures from when the session was created. Asking for one at the end would
        /// make every run look like it took no time at all.
        /// </summary>
        public IEnumerator StartSession(string recipeSlug, bool practice, Action<ApiResult<SessionStartDto>> done)
        {
            var body = JsonUtility.ToJson(new SessionStartRequest { recipeSlug = recipeSlug, practice = practice });
            return Send<SessionStartDto>("POST", "/api/sessions/start", body, TimeoutSeconds, result =>
            {
                if (result.Ok)
                {
                    SessionId = result.Value.sessionId;
                    SessionToken = result.Value.token;
                }
                done(result);
            });
        }

        [Serializable] class SessionStartRequest { public string recipeSlug; public bool practice; }

        public IEnumerator SubmitScore(string name, float percent, string recipeSlug, Action<ApiResult<ScoreAcceptedDto>> done)
        {
            if (string.IsNullOrEmpty(SessionId))
            {
                // Not an error worth a request. Without a session the server will refuse, and
                // spending a round trip to be told so at a venue is a round trip wasted.
                done(ApiResult<ScoreAcceptedDto>.Failure("no session -- this run was not started against the server"));
                return EmptyRoutine();
            }

            var body = JsonUtility.ToJson(new ScoreSubmitDto
            {
                name = name,
                score = percent,
                recipeSlug = recipeSlug,
                sessionId = SessionId,
                sessionToken = SessionToken,
            });
            return Send("POST", "/api/scores", body, TimeoutSeconds, done);
        }

        public IEnumerator Analyze(AnalyzeRequestDto request, Action<ApiResult<CoachAnalysisDto>> done) =>
            Send("POST", "/api/coach/analyze", JsonUtility.ToJson(request), CoachTimeoutSeconds, done);

        public IEnumerator CheckIngredients(IngredientCheckRequestDto request, Action<ApiResult<IngredientCheckDto>> done) =>
            Send("POST", "/api/ingredients/check", JsonUtility.ToJson(request), CoachTimeoutSeconds, done);

        /// <summary>
        /// Writes a recipe. The confirmed output of a scan comes through here, not through the
        /// scan endpoint -- a transcription gets no more trust than something typed by hand,
        /// and the server validates both with the same schema.
        /// </summary>
        public IEnumerator CreateRecipe(RecipeDto recipe, Action<ApiResult<RecipeDto>> done) =>
            Send("POST", "/api/recipes", JsonUtility.ToJson(recipe), TimeoutSeconds, done);

        public IEnumerator ScanRecipe(string imageDataUri, Action<ApiResult<ScanResultDto>> done) =>
            Send("POST", "/api/recipes/scan", JsonUtility.ToJson(new ScanRequestDto { image = imageDataUri }), CoachTimeoutSeconds, done);

        public IEnumerator RecordSession(SessionRecordDto record, Action<ApiResult<ScoreAcceptedDto>> done)
        {
            record.sessionId = SessionId;
            record.sessionToken = SessionToken;
            // 30 seconds: twenty thumbnails is half a megabyte before base64, and a venue's
            // uplink is the slowest part of this whole system.
            return Send("POST", "/api/sessions", JsonUtility.ToJson(record), 30, done);
        }

        public IEnumerator GetSession(string id, Action<ApiResult<StoredSessionDto>> done) =>
            Send("GET", $"/api/sessions/{UnityWebRequest.EscapeURL(id)}", null, TimeoutSeconds, done);

        static IEnumerator EmptyRoutine() { yield break; }
    }
}
