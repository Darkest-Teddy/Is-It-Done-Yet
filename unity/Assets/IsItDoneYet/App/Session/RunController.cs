using System;
using System.Collections;
using System.Collections.Generic;
using IsItDoneYet.Audio;
using IsItDoneYet.Core;
using IsItDoneYet.Design;
using UnityEngine;

namespace IsItDoneYet.App
{
    /// <summary>
    /// One cook, one recipe, start to finish.
    ///
    /// This is where the two halves meet and stay separate. The coach is a language model
    /// looking at a blurry frame; it contributes <i>observations</i>, which are voted across
    /// three results before any of them is written down. The score is arithmetic over the
    /// written-down list. Nothing the model says reaches the score without passing the vote,
    /// and nothing about the score depends on the model being reachable -- which is what lets
    /// the whole app keep working on a dead network.
    ///
    /// The event log is the only state that matters. The score is a function of it, the replay
    /// plays it back, and the same log always yields the same number.
    /// </summary>
    public class RunController : MonoBehaviour
    {
        [Header("Wiring")]
        public ApiClient Api;
        public FrameUploader Uploader;
        public StepRail Rail;
        public ToastStack Toasts;
        public ScoreHud Score;

        [Header("Config")]
        public ScoreConfig ScoreSettings = new ScoreConfig();
        [Tooltip("Coach results kept for the vote. Three, matching the server's prompt.")]
        public int VoteWindow = 3;
        [Tooltip("How many of the window must agree before anything is shown or scored.")]
        public int VoteAgreement = 2;

        [Header("Mode")]
        public bool Practice;

        readonly List<ScoreEvent> _log = new List<ScoreEvent>();
        readonly List<VotedObservation> _voted = new List<VotedObservation>();
        readonly List<CoachResultDto> _coachHistory = new List<CoachResultDto>();
        readonly List<ThumbnailDto> _thumbnails = new List<ThumbnailDto>();
        readonly MessageCooldown _messages = new MessageCooldown(12f);

        CoachVote _vote;
        RecipeDto _recipe;
        Rubric _rubric;
        int _stepIndex = -1;
        float _runStartTime;
        float _stepStartTime;
        bool _running;
        bool _safeMode;
        int _lastStreak;
        float _lastMultiplier = 1f;

        public bool Running => _running;
        public int StepIndex => _stepIndex;
        public bool SafeMode => _safeMode;
        public IReadOnlyList<ScoreEvent> Log => _log;
        public RecipeDto Recipe => _recipe;

        /// <summary>The live score, recomputed from the log whenever it changes.</summary>
        public ScoreResult Current { get; private set; } = new ScoreResult();

        public event Action<ScoreResult> ScoreChanged;
        public event Action<int> StepChanged;
        public event Action<bool> SafeModeChanged;

        int NowMs => Mathf.RoundToInt((Time.time - _runStartTime) * 1000f);

        void Awake()
        {
            _vote = new CoachVote(VoteWindow, VoteAgreement);
        }

        void OnEnable()
        {
            if (Uploader != null)
            {
                Uploader.BuildRequest = BuildAnalyzeRequest;
                Uploader.Analyzed += OnAnalyzed;
            }
        }

        void OnDisable()
        {
            if (Uploader != null)
            {
                Uploader.BuildRequest = null;
                Uploader.Analyzed -= OnAnalyzed;
            }
        }

        public IEnumerator Begin(RecipeDto recipe, bool practice)
        {
            _recipe = recipe;
            Practice = practice;
            _rubric = RubricFrom(recipe);
            _log.Clear();
            _coachHistory.Clear();
            _thumbnails.Clear();
            _thumbnailTick = 0;
            _thumbnailEvery = 1;
            _vote.Clear();
            _messages.Clear();
            SoundManager.Instance?.ResetCooldowns();

            _runStartTime = Time.time;
            _stepIndex = -1;
            _running = true;

            // The session is started BEFORE the first step, because the server measures a run's
            // plausibility from when the session was created. Asking for one at submission
            // would make every run look instantaneous.
            if (Api != null) yield return Api.StartSession(recipe != null ? recipe.slug : null, practice, _ => { });

            ThemeManager.Instance?.Apply(practice ? ThemeName.Practice : ThemeName.Normal);
            PushRail();
            Advance();
        }

        /// <summary>
        /// Turns a recipe into the rubric the coach is asked about and the scorer scores.
        ///
        /// Derived from the steps rather than authored separately, so a recipe scanned off a
        /// card tonight is scorable without anybody writing a rubric for it. The items are the
        /// step's own text plus its technique, which is what the model can actually see.
        /// </summary>
        public static Rubric RubricFrom(RecipeDto recipe)
        {
            var rubric = new Rubric { RecipeSlug = recipe != null ? recipe.slug : string.Empty };
            if (recipe?.steps == null) return rubric;

            for (var i = 0; i < recipe.steps.Length; i++)
            {
                var step = recipe.steps[i];
                var entry = new RubricStep
                {
                    StepIndex = i,
                    Text = step.text,
                    MinDurationSec = step.durationSec,
                    // No ceiling from the recipe data, so twice the minimum stands in. A step
                    // with no maximum would otherwise make the timer ring meaningless.
                    MaxDurationSec = step.durationSec > 0 ? step.durationSec * 2 : 0,
                    Hot = step.hot,
                    Knife = step.knife,
                };
                entry.Items.Add(step.text);
                if (!string.IsNullOrEmpty(step.technique)) entry.Items.Add(step.technique);
                rubric.Steps.Add(entry);
            }
            return rubric;
        }

        void PushRail()
        {
            if (Rail == null || _rubric == null) return;
            var entries = new List<StepRail.Entry>();
            foreach (var step in _rubric.Steps)
            {
                entries.Add(new StepRail.Entry
                {
                    Text = step.Text,
                    MinDurationSec = step.MinDurationSec,
                    MaxDurationSec = step.MaxDurationSec,
                    Hot = step.Hot,
                    Knife = step.Knife,
                });
            }
            Rail.SetSteps(entries);
        }

        /// <summary>Completes the current step and moves to the next. The cook's own call.</summary>
        public void Advance()
        {
            if (!_running || _rubric == null) return;

            if (_stepIndex >= 0)
            {
                _log.Add(ScoreEvent.Step(NowMs, ScoreEventKind.StepCompleted, _stepIndex));
                SoundManager.Instance?.Play(Sfx.StepComplete);
                Rescore();
            }

            _stepIndex++;
            if (_stepIndex >= _rubric.Steps.Count)
            {
                Finish();
                return;
            }

            _stepStartTime = Time.time;
            _log.Add(ScoreEvent.Step(NowMs, ScoreEventKind.StepStarted, _stepIndex));

            // A cooldown is scoped to the step it was set in. Carrying it across would
            // suppress the first warning of a new step because a similar one was recent, and
            // the new step means something different.
            _messages.Clear();
            _vote.Clear();

            var step = _rubric.Steps[_stepIndex];
            SetSafeMode(step.Hot || step.Knife);

            Rail?.SetActive(_stepIndex);
            StepChanged?.Invoke(_stepIndex);
        }

        void SetSafeMode(bool safe)
        {
            if (_safeMode == safe) return;
            _safeMode = safe;

            // PRACTICE loses to SAFE. A practice run on a hot step is still a hot step, and the
            // theme that exists to calm the HUD near heat has to win over the one that exists
            // to say a score does not count.
            var theme = safe ? ThemeName.Safe : Practice ? ThemeName.Practice : ThemeName.Normal;
            ThemeManager.Instance?.Apply(theme);

            if (safe) SoundManager.Instance?.Play(Sfx.SafeModeEnter);
            SafeModeChanged?.Invoke(safe);
        }

        AnalyzeRequestDto BuildAnalyzeRequest()
        {
            if (!_running || _rubric == null || _stepIndex < 0) return null;
            var step = _rubric.Step(_stepIndex);
            if (step == null) return null;

            return new AnalyzeRequestDto
            {
                recipeTitle = _recipe != null ? _recipe.title : "recipe",
                stepText = step.Text,
                rubricItems = step.Items.ToArray(),
                hot = step.Hot,
                knife = step.Knife,
            };
        }

        void OnAnalyzed(CoachResult result)
        {
            if (!_running || _stepIndex < 0) return;

            _vote.Add(result);
            RecordCoachResult(result);

            var step = _rubric.Step(_stepIndex);
            if (step == null) return;

            _vote.Vote(step.Items, _voted);

            if (_voted.Count == 0)
            {
                // Nothing cleared the bar. The HUD says "not sure" rather than going blank,
                // because a panel that vanishes reads as a crash.
                Toasts?.ShowUnsure(result.Offline);
                return;
            }

            for (var i = 0; i < _voted.Count; i++)
            {
                var voted = _voted[i];

                // Only confirmed verdicts are written down, and only once per item per step.
                // A confirmed warning costs points permanently, so this side of the system is
                // slow to confirm on purpose -- the mirror of the perception tracker, which is
                // slow to let go.
                var key = $"{_stepIndex}:{voted.Item}:{voted.Status}";
                if (!_messages.TrySpeak(key, Time.time, 15f)) continue;

                _log.Add(ScoreEvent.Observed(NowMs, _stepIndex, voted.Item, voted.Status));

                if (voted.Status != ObservationStatus.Ok)
                {
                    // Paired: a toast AND a sound. Never the sound alone.
                    Toasts?.Show(key, EvidenceFor(voted, result), voted.Status, voted.Confidence);
                    SoundManager.Instance?.Play(voted.Status == ObservationStatus.Bad ? Sfx.Warning : Sfx.MessagePop);
                }
            }

            if (!string.IsNullOrEmpty(result.CoachLine) && _messages.TrySpeak("coachLine", Time.time, 20f))
            {
                Toasts?.Show("coachLine", result.CoachLine, ObservationStatus.Ok, 1f);
            }

            Rescore();
        }

        static string EvidenceFor(VotedObservation voted, CoachResult result)
        {
            for (var i = 0; i < result.Observations.Count; i++)
            {
                if (result.Observations[i].Item == voted.Item && !string.IsNullOrEmpty(result.Observations[i].Evidence))
                    return result.Observations[i].Evidence;
            }
            return voted.Item;
        }

        void RecordCoachResult(CoachResult result)
        {
            var dto = new CoachResultDto
            {
                atMs = result.AtMs,
                coachLine = result.CoachLine,
                unsure = result.Unsure,
                observations = new ObservationDto[result.Observations.Count],
            };
            for (var i = 0; i < result.Observations.Count; i++)
            {
                var o = result.Observations[i];
                dto.observations[i] = new ObservationDto
                {
                    item = o.Item,
                    status = o.Status.ToString().ToLowerInvariant(),
                    evidence = o.Evidence,
                    confidence = o.Confidence,
                };
            }
            _coachHistory.Add(dto);
            // Bounded, because the server accepts 120 and a long run would otherwise post a
            // body it refuses -- at the end, after the cook has finished, with nothing saved.
            if (_coachHistory.Count > 120) _coachHistory.RemoveAt(0);

            CaptureThumbnail();
        }

        /// <summary>
        /// Keeps twenty thumbnails spread across the whole run, not the first twenty.
        ///
        /// Done by decimation: when the list fills, every second entry is dropped and the
        /// capture interval doubles. The survivors stay evenly spaced however long the cook
        /// takes, so a ten-minute braise gets a replay of the braise rather than a replay of
        /// the first minute of it.
        /// </summary>
        void CaptureThumbnail()
        {
            if (Uploader == null || Uploader.LastJpeg == null) return;

            _thumbnailTick++;
            if (_thumbnailTick % _thumbnailEvery != 0) return;

            _thumbnails.Add(new ThumbnailDto { atMs = NowMs, jpeg = Convert.ToBase64String(Uploader.LastJpeg) });

            if (_thumbnails.Count <= 20) return;
            for (var i = _thumbnails.Count - 1; i >= 0; i -= 2) _thumbnails.RemoveAt(i);
            _thumbnailEvery *= 2;
        }

        int _thumbnailTick;
        int _thumbnailEvery = 1;

        void Rescore()
        {
            Current = ScoringEngine.Score(_rubric, ScoreSettings, _log);

            if (Current.MaxStreak > _lastStreak)
            {
                _lastStreak = Current.MaxStreak;
                SoundManager.Instance?.Play(Sfx.ComboUp);
            }
            else if (Current.FinalMultiplier < _lastMultiplier - 0.001f)
            {
                SoundManager.Instance?.Play(Sfx.StreakBreak);
            }
            _lastMultiplier = Current.FinalMultiplier;

            Score?.Set(Current);
            ScoreChanged?.Invoke(Current);
        }

        void Update()
        {
            if (!_running || _stepIndex < 0) return;
            Rail?.Tick(Time.time - _stepStartTime);
        }

        void Finish()
        {
            _running = false;
            Rescore();
            SetSafeMode(false);
            StartCoroutine(Submit());
        }

        IEnumerator Submit()
        {
            if (Api == null) yield break;

            // The recording goes first and goes regardless. A practice run is worth replaying;
            // so is a run whose score the server rejects as implausible.
            var record = new SessionRecordDto
            {
                recipeSlug = _recipe != null ? _recipe.slug : null,
                durationMs = NowMs,
                score = Current.Percent,
                events = ToDto(_log),
                coachResults = _coachHistory.ToArray(),
                thumbnails = _thumbnails.ToArray(),
            };
            yield return Api.RecordSession(record, _ => { });

            if (Practice)
            {
                // Not submitted, and the cook is told so rather than left to wonder why the
                // board did not change.
                Toasts?.Show("practice", "Practice run — not ranked.", ObservationStatus.Ok, 1f);
                yield break;
            }

            yield return Api.SubmitScore(PlayerName(), Current.Percent, _recipe != null ? _recipe.slug : null, result =>
            {
                if (result.Ok)
                {
                    Toasts?.Show("rank", $"Rank {result.Value.rank} of {result.Value.total}", ObservationStatus.Ok, 1f);
                    SoundManager.Instance?.Play(Sfx.RankUp);
                }
                else
                {
                    Toasts?.Show("submit-failed", "Saved locally — the board is out of reach.", ObservationStatus.Warn, 1f);
                }
            });
        }

        static SessionEventDto[] ToDto(List<ScoreEvent> log)
        {
            var result = new SessionEventDto[log.Count];
            for (var i = 0; i < log.Count; i++)
            {
                result[i] = new SessionEventDto
                {
                    atMs = log[i].AtMs,
                    kind = log[i].Kind.ToString(),
                    stepIndex = log[i].StepIndex,
                    label = log[i].Item,
                    status = log[i].Status.ToString().ToLowerInvariant(),
                };
            }
            return result;
        }

        const string NameKey = "idy.player.name";

        /// <summary>
        /// The auto-generated nickname, editable from the leaderboard panel.
        ///
        /// Generated rather than demanded, because a headset keyboard is slow and being asked
        /// to type before you may play is how a booth queue stops moving.
        /// </summary>
        public static string PlayerName()
        {
            var stored = PlayerPrefs.GetString(NameKey, string.Empty);
            if (!string.IsNullOrEmpty(stored)) return stored;

            var adjectives = new[] { "Quick", "Calm", "Sharp", "Steady", "Bold", "Neat" };
            var nouns = new[] { "Whisk", "Ladle", "Knife", "Pan", "Board", "Peel" };
            var name = $"{adjectives[UnityEngine.Random.Range(0, adjectives.Length)]}{nouns[UnityEngine.Random.Range(0, nouns.Length)]}{UnityEngine.Random.Range(10, 99)}";
            PlayerPrefs.SetString(NameKey, name);
            PlayerPrefs.Save();
            return name;
        }

        public static void SetPlayerName(string name)
        {
            PlayerPrefs.SetString(NameKey, name);
            PlayerPrefs.Save();
        }
    }
}
