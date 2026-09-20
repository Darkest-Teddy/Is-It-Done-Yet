using System;
using System.Collections.Generic;
using IsItDoneYet.Audio;
using IsItDoneYet.Design;
using UnityEngine;

namespace IsItDoneYet.App
{
    /// <summary>
    /// The first two minutes: what the camera does, what "estimate" means, and the safety
    /// rules. Then the consent choice.
    ///
    /// Stepped cards rather than a wall of text, because a wall of text in a headset is a wall
    /// of text nobody reads and everybody dismisses -- which is the same as not having said it.
    ///
    /// Consent is a real choice with a real "no". Declining leaves a fully working app: the
    /// scoring engine is local and deterministic, the recipe book and the step rail and the
    /// timers all work, and the only thing missing is the commentary. An onboarding that makes
    /// the camera mandatory is not asking.
    /// </summary>
    public class OnboardingFlow : MonoBehaviour
    {
        [Serializable]
        public class CardContent
        {
            public string Title;
            [TextArea] public string Body;
            public string IconName;
            public bool RequiresAcknowledgement;
        }

        [Header("Wiring")]
        public GlassPanel Panel;
        public Label TitleLabel;
        public Label BodyLabel;
        public IconQuad Icon;
        public PillButton NextButton;
        public PillButton DeclineButton;
        public FrameUploader Uploader;
        public PassthroughFrameSource DeviceSource;

        [Header("Content")]
        public List<CardContent> Cards = new List<CardContent>();

        const string SeenKey = "idy.onboarding.seen";
        const string ConsentKey = "idy.camera.consent";

        int _index;

        public bool Finished { get; private set; }
        public static bool HasConsent => PlayerPrefs.GetInt(ConsentKey, 0) == 1;

        void Awake()
        {
            if (Cards.Count == 0) Cards = DefaultCards();
        }

        void OnEnable()
        {
            if (NextButton != null) NextButton.Clicked += Next;
            if (DeclineButton != null) DeclineButton.Clicked += Decline;
            _index = 0;
            Render();
        }

        void OnDisable()
        {
            if (NextButton != null) NextButton.Clicked -= Next;
            if (DeclineButton != null) DeclineButton.Clicked -= Decline;
        }

        /// <summary>
        /// The copy, in the reference's voice: short, direct, no marketing.
        ///
        /// The second and third cards are the ones that earn their place. "Heat is an estimate"
        /// is the single most important thing this app has to say about itself, and the safety
        /// card exists because somebody is about to put a headset on near a knife.
        /// </summary>
        public static List<CardContent> DefaultCards() => new List<CardContent>
        {
            new CardContent
            {
                Title = "Is it done yet?",
                Body = "Real counter, real pan. Work through a recipe and get told what the camera can see.",
                IconName = "patty",
            },
            new CardContent
            {
                Title = "The camera",
                Body = "Every few seconds a small photo of your counter goes to your own server, which asks a " +
                       "vision model about it. Nothing is stored on the headset. You can turn it off any time " +
                       "from the menu — everything else keeps working.",
                IconName = "camera-active",
            },
            new CardContent
            {
                Title = "Heat is a guess",
                Body = "There is no thermometer here. Heat is estimated from colour, smoke and bubbling — so " +
                       "the gauge shows a band, not a needle. When it widens, the app is less sure. Trust your " +
                       "own eyes over it.",
                IconName = "status-unsure",
            },
            new CardContent
            {
                Title = "Before you cook",
                Body = "Take the headset off for anything sharp or hot. Do not wear it near an open flame, hot " +
                       "oil, or while cutting. Set the pan down, then look.",
                IconName = "status-warn",
                RequiresAcknowledgement = true,
            },
        };

        void Render()
        {
            if (_index >= Cards.Count)
            {
                Accept();
                return;
            }

            var card = Cards[_index];
            if (TitleLabel != null) { TitleLabel.SetText(card.Title); TitleLabel.TypeRole = "panelTitle"; TitleLabel.Refresh(); }
            if (BodyLabel != null) { BodyLabel.SetText(card.Body); BodyLabel.TypeRole = "body"; BodyLabel.Refresh(); }
            if (Icon != null) { Icon.SetIcon(card.IconName); Icon.Tinted = card.IconName.StartsWith("status") || card.IconName == "camera-active"; Icon.Refresh(); }

            // The decline button only appears on the card that is actually asking. Offering
            // "no" on the welcome screen is offering to quit.
            if (DeclineButton != null) DeclineButton.gameObject.SetActive(card.RequiresAcknowledgement || _index == 1);
        }

        void Next()
        {
            SoundManager.Instance?.Play(Sfx.PokeClick);
            _index++;
            Render();
        }

        void Accept()
        {
            PlayerPrefs.SetInt(SeenKey, 1);
            PlayerPrefs.SetInt(ConsentKey, 1);
            PlayerPrefs.Save();

            // The permission dialog comes HERE, after the explanation, not on startup. A
            // permission prompt in the first second of putting a headset on is one people
            // dismiss without reading.
            DeviceSource?.RequestPermissions();
            Uploader?.SetConsent(true);

            Finished = true;
            gameObject.SetActive(false);
        }

        void Decline()
        {
            PlayerPrefs.SetInt(SeenKey, 1);
            PlayerPrefs.SetInt(ConsentKey, 0);
            PlayerPrefs.Save();

            Uploader?.SetConsent(false);
            Finished = true;
            gameObject.SetActive(false);
        }

        /// <summary>Revoking from the menu. Takes effect on the next frame, not the next run.</summary>
        public void RevokeConsent()
        {
            PlayerPrefs.SetInt(ConsentKey, 0);
            PlayerPrefs.Save();
            Uploader?.SetConsent(false);
        }

        public static bool ShouldShow() => PlayerPrefs.GetInt(SeenKey, 0) == 0;
    }
}
