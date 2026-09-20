using System;
using System.Collections.Generic;

namespace IsItDoneYet.App
{
    /// <summary>
    /// The wire shapes, mirroring server/src/schemas.js.
    ///
    /// Plain [Serializable] classes for JsonUtility rather than Newtonsoft. Newtonsoft on
    /// Android under IL2CPP needs an AOT link hint for every generic it reflects over, and the
    /// failure mode is an exception at runtime on the device and nowhere else -- which is the
    /// worst possible place to find it. JsonUtility is limited and boring and works.
    ///
    /// Its limits shape these types: no dictionaries, no nullable value types, no top-level
    /// arrays. Every collection response is therefore wrapped in an object with a named field,
    /// which the server already does.
    /// </summary>
    [Serializable] public class CoverDto { public string tint; public string ink; public string accent; }

    [Serializable] public class IngredientDto { public string name; public float quantity; public string unit; public string notes; }

    [Serializable]
    public class StepDto
    {
        public int order;
        public string text;
        public int durationSec;
        public string technique;
        public bool hot;
        public bool knife;
        public string stepId;
        public string verifiable;
    }

    [Serializable]
    public class RecipeDto
    {
        public string id;
        public string slug;
        public string title;
        public string description;
        public int servings;
        public string[] tags;
        public string source;
        public IngredientDto[] ingredients;
        public StepDto[] steps;
        public CoverDto cover;
    }

    [Serializable] public class RecipeListDto { public RecipeDto[] recipes; public int total; }

    [Serializable] public class SessionStartDto { public string sessionId; public string token; public string startedAt; public int requiredSeconds; public int minRunSeconds; public bool practice; }

    [Serializable] public class ScoreSubmitDto { public string name; public float score; public string recipeSlug; public string sessionId; public string sessionToken; }

    [Serializable] public class ScoreAcceptedDto { public string id; public int rank; public int total; }

    [Serializable] public class LeaderboardEntryDto { public int rank; public string name; public float score; public string createdAt; }

    [Serializable] public class LeaderboardDto { public LeaderboardEntryDto[] entries; public int total; public int limit; public int offset; }

    [Serializable] public class ObservationDto { public string item; public string status; public string evidence; public float confidence; }

    [Serializable]
    public class CoachAnalysisDto
    {
        public ObservationDto[] observations;
        public string coachLine;
        public bool unsure;
        public bool offline;
        public string reason;
        public string model;
    }

    [Serializable] public class AnalyzeRequestDto { public string image; public string recipeTitle; public string stepText; public string[] rubricItems; public bool hot; public bool knife; }

    [Serializable] public class IngredientFoundDto { public string name; public bool present; public float confidence; public string evidence; }

    [Serializable] public class IngredientCheckDto { public IngredientFoundDto[] found; public bool unsure; public bool offline; }

    [Serializable] public class IngredientCheckRequestDto { public string image; public string[] wanted; }

    [Serializable] public class ScanRequestDto { public string image; }

    [Serializable] public class ScanResultDto { public bool ok; public bool offline; public string reason; public RecipeDto draft; }

    [Serializable] public class SessionEventDto { public int atMs; public string kind; public int stepIndex; public string label; public float points; public string status; }

    [Serializable] public class CoachResultDto { public int atMs; public ObservationDto[] observations; public string coachLine; public bool unsure; }

    [Serializable] public class ThumbnailDto { public int atMs; public string jpeg; }

    [Serializable]
    public class SessionRecordDto
    {
        public string sessionId;
        public string sessionToken;
        public string recipeSlug;
        public int durationMs;
        public float score;
        public SessionEventDto[] events;
        public CoachResultDto[] coachResults;
        public ThumbnailDto[] thumbnails;
    }

    [Serializable]
    public class StoredSessionDto
    {
        public string id;
        public string recipeSlug;
        public bool practice;
        public float score;
        public int durationMs;
        public SessionEventDto[] events;
        public CoachResultDto[] coachResults;
        public ThumbnailDto[] thumbnails;
        public string createdAt;
    }

    /// <summary>
    /// The result of any call: a value, or a reason there is not one.
    ///
    /// Never an exception. Every call site here has a local fallback -- bundled recipes, local
    /// scoring, a cached board -- and a try/catch around each one would be the same code
    /// written twelve times with one of them missing.
    /// </summary>
    public readonly struct ApiResult<T>
    {
        public readonly T Value;
        public readonly bool Ok;
        public readonly string Error;

        ApiResult(T value, bool ok, string error) { Value = value; Ok = ok; Error = error; }
        public static ApiResult<T> Success(T value) => new ApiResult<T>(value, true, null);
        public static ApiResult<T> Failure(string error) => new ApiResult<T>(default, false, error);
    }
}
