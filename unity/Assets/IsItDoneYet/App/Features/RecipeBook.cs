using System.Collections;
using System.Collections.Generic;
using IsItDoneYet.Audio;
using IsItDoneYet.Core;
using IsItDoneYet.Design;
using UnityEngine;

namespace IsItDoneYet.App
{
    /// <summary>
    /// The recipe shelf: a curved row of cards, the selected one lifted, scrolled by poke or
    /// pinch.
    ///
    /// Every cover is drawn from three hex values the server sends per recipe. No cover images
    /// anywhere -- an image URL is a network fetch on the critical path of a carousel somebody
    /// is already scrolling, on venue wifi, and the failure mode is a wall of grey rectangles
    /// at the exact moment the app is being shown to someone.
    ///
    /// Bundled recipes are loaded first and the server's list replaces them if it arrives. That
    /// order matters: the shelf is never empty, not even for the second before a request
    /// resolves, and never at all if it does not.
    /// </summary>
    public class RecipeBook : MonoBehaviour
    {
        [Header("Wiring")]
        public ApiClient Api;
        public Card Prototype;
        public Transform Shelf;
        public LayoutConfig Layout;

        [Header("Shelf")]
        [Tooltip("Cards curve around the cook so the far ones still face them.")]
        public float RadiusM = 0.85f;
        public float CardSpacingDeg = 13f;
        public int VisibleCards = 5;

        [Header("Offline")]
        [Tooltip("JSON in Resources, so the shelf works with no server at all.")]
        public string BundledResource = "bundled-recipes";

        readonly List<RecipeDto> _recipes = new List<RecipeDto>();
        readonly List<Card> _cards = new List<Card>();
        int _selected;

        public RecipeDto Selected => _selected >= 0 && _selected < _recipes.Count ? _recipes[_selected] : null;
        public IReadOnlyList<RecipeDto> Recipes => _recipes;

        IEnumerator Start()
        {
            LoadBundled();
            Rebuild();

            if (Api == null) yield break;
            yield return Api.GetRecipes(result =>
            {
                if (!result.Ok || result.Value?.recipes == null || result.Value.recipes.Length == 0) return;
                _recipes.Clear();
                _recipes.AddRange(result.Value.recipes);
                Rebuild();
            });
        }

        void LoadBundled()
        {
            var text = Resources.Load<TextAsset>(BundledResource);
            if (text == null)
            {
                Debug.LogWarning($"[RecipeBook] no bundled recipes at Resources/{BundledResource} -- the shelf is empty until the server answers");
                return;
            }
            var parsed = JsonUtility.FromJson<RecipeListDto>(text.text);
            if (parsed?.recipes != null) _recipes.AddRange(parsed.recipes);
        }

        void Rebuild()
        {
            while (_cards.Count < _recipes.Count && Prototype != null && Shelf != null)
            {
                _cards.Add(Instantiate(Prototype, Shelf));
            }

            for (var i = 0; i < _cards.Count; i++)
            {
                var visible = i < _recipes.Count;
                _cards[i].gameObject.SetActive(visible);
                if (!visible) continue;

                var recipe = _recipes[i];
                var tint = CoverTint(recipe);
                _cards[i].Set(
                    recipe.title,
                    FootnoteFor(recipe),
                    IconFor(recipe),
                    tint,
                    MinutesFor(recipe), Chip.ChipTone.Info,
                    DifficultyFor(recipe), Chip.ChipTone.Spice);
                _cards[i].ApplyCoverTint();
            }

            Layout_();
        }

        /// <summary>
        /// The server's cover tint, or a derived one.
        ///
        /// The fallback exists because a recipe typed in the headset has no cover until it has
        /// been round-tripped, and a card with no tint is a hole in the shelf.
        /// </summary>
        static Color CoverTint(RecipeDto recipe)
        {
            if (recipe.cover != null && Srgb.TryParseHex(recipe.cover.tint, out var tint)) return tint;
            return new Color(0.984f, 0.890f, 0.627f);
        }

        static string FootnoteFor(RecipeDto recipe) =>
            recipe.ingredients == null ? string.Empty : $"{recipe.ingredients.Length} ingredients";

        static string MinutesFor(RecipeDto recipe)
        {
            if (recipe.steps == null) return "—";
            var seconds = 0;
            for (var i = 0; i < recipe.steps.Length; i++) seconds += Mathf.Max(0, recipe.steps[i].durationSec);
            return seconds <= 0 ? "—" : $"{Mathf.Max(1, seconds / 60)} MIN";
        }

        static string DifficultyFor(RecipeDto recipe)
        {
            var steps = recipe.steps?.Length ?? 0;
            return steps <= 4 ? "LEVEL 1" : steps <= 9 ? "LEVEL 2" : "LEVEL 3";
        }

        /// <summary>
        /// Picks an ingredient icon from the recipe's tags and ingredient names.
        ///
        /// A lookup over the eleven icons the design ships, rather than an icon per recipe.
        /// Anything unmatched gets the carrot, which is the most generic thing in the set --
        /// a blank card would be worse than a slightly wrong vegetable.
        /// </summary>
        static string IconFor(RecipeDto recipe)
        {
            var known = new[] { "patty", "onion", "egg", "lettuce", "mushroom", "chili", "bun", "cheese", "sauce", "tomato", "carrot" };

            if (recipe.ingredients != null)
            {
                for (var i = 0; i < recipe.ingredients.Length; i++)
                {
                    var name = recipe.ingredients[i].name?.ToLowerInvariant() ?? string.Empty;
                    for (var k = 0; k < known.Length; k++) if (name.Contains(known[k])) return known[k];
                }
            }
            if (recipe.tags != null)
            {
                for (var t = 0; t < recipe.tags.Length; t++)
                {
                    var tag = recipe.tags[t]?.ToLowerInvariant() ?? string.Empty;
                    for (var k = 0; k < known.Length; k++) if (tag.Contains(known[k])) return known[k];
                }
            }
            return "carrot";
        }

        void Layout_()
        {
            if (Shelf == null) return;

            for (var i = 0; i < _cards.Count; i++)
            {
                if (!_cards[i].gameObject.activeSelf) continue;

                var offset = i - _selected;
                var within = Mathf.Abs(offset) <= VisibleCards / 2;
                _cards[i].gameObject.SetActive(within);
                if (!within) continue;

                // Cards sit on an arc and each one turns to face the centre, so the card at the
                // end of the shelf is still readable rather than edge-on.
                var yaw = offset * CardSpacingDeg;
                var local = AngularLayout.DirectionFromAngles(yaw, 0f) * RadiusM;
                _cards[i].transform.localPosition = local - Vector3.forward * RadiusM;
                _cards[i].transform.localRotation = Quaternion.Euler(0f, yaw, 0f);
                _cards[i].SetSelected(offset == 0);
            }
        }

        public void Scroll(int direction)
        {
            if (_recipes.Count == 0) return;
            var next = Mathf.Clamp(_selected + direction, 0, _recipes.Count - 1);
            if (next == _selected) return;
            _selected = next;
            SoundManager.Instance?.Play(Sfx.Hover);
            Layout_();
        }

        public void Select(int index)
        {
            if (index < 0 || index >= _recipes.Count) return;
            _selected = index;
            SoundManager.Instance?.Play(Sfx.PokeClick);
            Layout_();
        }
    }
}
