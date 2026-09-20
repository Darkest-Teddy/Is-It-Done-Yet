using System.Collections;
using System.Collections.Generic;
using IsItDoneYet.Audio;
using IsItDoneYet.Design;
using UnityEngine;

namespace IsItDoneYet.App
{
    /// <summary>
    /// What the recipe needs, what the camera can see, and what is missing.
    ///
    /// The camera column is the interesting one and it is deliberately quiet. A tick appears
    /// with a drawn-check animation when the coach finds something; a missing item goes amber
    /// rather than red, because "I cannot see the cumin" is not the same claim as "you do not
    /// have cumin" and the UI must not make it sound like one. Anything the model is unsure
    /// about stays neutral.
    ///
    /// The cook can always tick by hand, and a hand tick outranks the camera permanently. They
    /// are looking at their own counter; the model is looking at a photograph of it.
    /// </summary>
    public class ChecklistPanel : MonoBehaviour
    {
        public enum ItemState { Unknown, FoundByCamera, TickedByHand, Missing }

        [System.Serializable]
        public class Item
        {
            public string Name;
            public ItemState State;
            [HideInInspector] public GlassPanel Row;
            [HideInInspector] public Label Text;
            [HideInInspector] public IconQuad Mark;
        }

        [Header("Wiring")]
        public ApiClient Api;
        public FrameUploader Uploader;
        public Transform RowRoot;

        [Header("Layout")]
        public float WidthM = 0.32f;
        public float RowHeightM = 0.034f;

        [Header("Camera check")]
        [Tooltip("Below this the model is guessing and the row stays neutral.")]
        [Range(0f, 1f)] public float ConfidenceFloor = 0.45f;
        public float SecondsBetweenChecks = 8f;

        readonly List<Item> _items = new List<Item>();
        float _nextCheck;
        bool _checking;

        public IReadOnlyList<Item> Items => _items;

        public void SetItems(IEnumerable<string> names)
        {
            var index = 0;
            foreach (var name in names)
            {
                if (index >= _items.Count) _items.Add(CreateRow(index));
                _items[index].Name = name;
                _items[index].State = ItemState.Unknown;
                index++;
            }
            for (var i = index; i < _items.Count; i++) _items[i].Row?.gameObject.SetActive(false);
            Render();
        }

        Item CreateRow(int index)
        {
            var item = new Item();
            if (RowRoot == null) return item;

            var host = new GameObject($"Item{index}", typeof(MeshFilter), typeof(MeshRenderer), typeof(GlassPanel));
            host.transform.SetParent(RowRoot, false);
            item.Row = host.GetComponent<GlassPanel>();
            item.Row.RadiusPx = 14f;
            item.Row.BorderPx = 3f;
            item.Row.ShadowLevel = "chip";
            item.Row.Frost = 0f;

            var labelHost = new GameObject("Text", typeof(TMPro.TextMeshPro), typeof(Label));
            labelHost.transform.SetParent(host.transform, false);
            labelHost.transform.localPosition = new Vector3(0.01f, 0f, -0.001f);
            item.Text = labelHost.GetComponent<Label>();
            item.Text.TypeRole = "caption";
            item.Text.Alignment = TMPro.TextAlignmentOptions.Left;

            var markHost = new GameObject("Mark", typeof(MeshFilter), typeof(MeshRenderer), typeof(IconQuad));
            markHost.transform.SetParent(host.transform, false);
            item.Mark = markHost.GetComponent<IconQuad>();
            item.Mark.SizeM = 0.018f;

            return item;
        }

        /// <summary>The cook's own tick. Outranks whatever the camera thought.</summary>
        public void ToggleByHand(int index)
        {
            if (index < 0 || index >= _items.Count) return;
            _items[index].State = _items[index].State == ItemState.TickedByHand ? ItemState.Unknown : ItemState.TickedByHand;
            SoundManager.Instance?.Play(Sfx.PokeClick);
            AnimateCheck(_items[index]);
            Render();
        }

        void Update()
        {
            if (Api == null || Uploader == null || !Uploader.IsCapturing) return;
            if (_checking || Time.time < _nextCheck) return;
            _nextCheck = Time.time + Mathf.Max(3f, SecondsBetweenChecks);
            StartCoroutine(Check());
        }

        IEnumerator Check()
        {
            var jpeg = Uploader.LastJpeg;
            if (jpeg == null) yield break;

            // Only ask about what is still unresolved. A shorter list is a cheaper call and a
            // more accurate answer -- the model's precision falls off as the list grows.
            var wanted = new List<string>();
            for (var i = 0; i < _items.Count; i++)
            {
                if (_items[i].State == ItemState.Unknown || _items[i].State == ItemState.Missing) wanted.Add(_items[i].Name);
            }
            if (wanted.Count == 0) yield break;

            _checking = true;
            var request = new IngredientCheckRequestDto
            {
                image = $"data:image/jpeg;base64,{System.Convert.ToBase64String(jpeg)}",
                wanted = wanted.ToArray(),
            };

            yield return Api.CheckIngredients(request, result =>
            {
                _checking = false;
                if (!result.Ok || result.Value?.found == null) return;

                foreach (var found in result.Value.found)
                {
                    var item = Find(found.name);
                    if (item == null || item.State == ItemState.TickedByHand) continue;

                    if (found.confidence < ConfidenceFloor)
                    {
                        // Low confidence is not evidence of absence. The row stays neutral
                        // rather than going amber, because amber reads as "you are missing
                        // this" and the model has not said that.
                        item.State = ItemState.Unknown;
                        continue;
                    }

                    var next = found.present ? ItemState.FoundByCamera : ItemState.Missing;
                    if (item.State != next && next == ItemState.FoundByCamera) AnimateCheck(item);
                    item.State = next;
                }
                Render();
            });
        }

        Item Find(string name)
        {
            for (var i = 0; i < _items.Count; i++) if (_items[i].Name == name) return _items[i];
            return null;
        }

        void AnimateCheck(Item item)
        {
            if (item?.Mark == null) return;
            var mark = item.Mark;
            var tokens = ThemeManager.Instance != null ? ThemeManager.Instance.Tokens : null;
            var duration = tokens != null ? tokens.Duration("pop", 0.5f) : 0.5f;
            var easing = tokens != null ? tokens.Easing("overshoot") : new Vector4(0.3f, 1.5f, 0.5f, 1f);

            // Scaled in, not faded in. A check that draws itself is the one bit of motion in
            // this panel and it is what makes ticking things off feel like progress.
            TweenRunner.Instance.Play(duration, easing, t =>
            {
                if (mark == null) return;
                mark.SizeM = Mathf.LerpUnclamped(0f, 0.018f, t);
                mark.Refresh();
            });
        }

        void Render()
        {
            var row = 0;
            for (var i = 0; i < _items.Count; i++)
            {
                var item = _items[i];
                if (item.Row == null) continue;
                var visible = !string.IsNullOrEmpty(item.Name);
                item.Row.gameObject.SetActive(visible);
                if (!visible) continue;

                ColorRole fill, ink, mark;
                string glyph;
                switch (item.State)
                {
                    case ItemState.TickedByHand:
                    case ItemState.FoundByCamera:
                        Chip.ResolveTone(Chip.ChipTone.Success, out fill, out ink);
                        mark = ink; glyph = "status-ok";
                        break;
                    case ItemState.Missing:
                        Chip.ResolveTone(Chip.ChipTone.Warning, out fill, out ink);
                        mark = ink; glyph = "status-warn";
                        break;
                    default:
                        Chip.ResolveTone(Chip.ChipTone.Neutral, out fill, out ink);
                        mark = ColorRole.OutlineSoft; glyph = "status-unsure";
                        break;
                }

                item.Row.SizeM = new Vector2(WidthM, RowHeightM);
                item.Row.transform.localPosition = new Vector3(0f, -row * (RowHeightM + 0.006f), 0f);
                item.Row.Fill = fill;
                item.Row.Refresh();

                item.Text.SetText(item.Name);
                item.Text.Color = ink;
                item.Text.OnFill = fill;
                item.Text.SizeM = new Vector2(WidthM - 0.05f, RowHeightM);
                item.Text.Refresh();

                item.Mark.SetIcon(glyph);
                item.Mark.Tint = mark;
                item.Mark.transform.localPosition = new Vector3(WidthM * 0.5f - 0.016f, 0f, -0.001f);
                // The camera-found state is marked distinctly from a hand tick, so the cook can
                // tell what the app believes from what they told it.
                item.Mark.Alpha = item.State == ItemState.FoundByCamera ? 0.75f : 1f;
                item.Mark.Refresh();

                row++;
            }
        }
    }
}
