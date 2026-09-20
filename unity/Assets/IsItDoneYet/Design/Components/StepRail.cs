using System.Collections.Generic;
using UnityEngine;

namespace IsItDoneYet.Design
{
    /// <summary>
    /// The progress rail: every step of the recipe, the one you are on, and how long you have
    /// been on it.
    ///
    /// The timer ring shows the min-to-max window as a coloured band rather than counting down
    /// to a single number, because most steps do not HAVE a single right duration -- they have
    /// a range, and a countdown to the middle of it teaches the wrong thing. The subtle pulse
    /// at the minimum is the only cue the cook needs: below it the step is not done, past it
    /// they are free to judge.
    /// </summary>
    [ExecuteAlways]
    public class StepRail : MonoBehaviour
    {
        [System.Serializable]
        public class Entry
        {
            public string Text;
            public int MinDurationSec;
            public int MaxDurationSec;
            public bool Hot;
            public bool Knife;
            [HideInInspector] public GlassPanel Panel;
            [HideInInspector] public Label Label;
            [HideInInspector] public IconQuad Glyph;
        }

        [Header("Layout")]
        public float WidthM = 0.26f;
        public float RowHeightM = 0.032f;
        public float RowGapM = 0.006f;
        [Tooltip("Rows above and below the active one. A rail showing twelve steps is a list nobody reads.")]
        public int VisibleRows = 5;

        [SerializeField] ArcGauge _timer;
        [SerializeField] Transform _rowRoot;

        readonly List<Entry> _entries = new List<Entry>();
        int _active = -1;
        float _pulse;

        public int ActiveIndex => _active;
        public IReadOnlyList<Entry> Entries => _entries;

        void OnEnable()
        {
            ThemeManager.AnyThemeChanged += Refresh;
            Refresh();
        }

        void OnDisable() => ThemeManager.AnyThemeChanged -= Refresh;

        public void SetSteps(IReadOnlyList<Entry> steps)
        {
            // Rows are reused, never rebuilt. A recipe change that destroyed and recreated a
            // dozen GameObjects would hitch on the frame the cook picks a dish, which is a
            // frame they are looking at.
            while (_entries.Count < steps.Count) _entries.Add(CreateRow(_entries.Count));
            for (var i = 0; i < _entries.Count; i++)
            {
                var visible = i < steps.Count;
                if (_entries[i].Panel != null) _entries[i].Panel.gameObject.SetActive(visible);
                if (!visible) continue;
                _entries[i].Text = steps[i].Text;
                _entries[i].MinDurationSec = steps[i].MinDurationSec;
                _entries[i].MaxDurationSec = steps[i].MaxDurationSec;
                _entries[i].Hot = steps[i].Hot;
                _entries[i].Knife = steps[i].Knife;
            }
            Refresh();
        }

        Entry CreateRow(int index)
        {
            var entry = new Entry();
            if (_rowRoot == null) return entry;

            var host = new GameObject($"Step{index}", typeof(MeshFilter), typeof(MeshRenderer), typeof(GlassPanel));
            host.transform.SetParent(_rowRoot, false);
            entry.Panel = host.GetComponent<GlassPanel>();
            entry.Panel.RadiusPx = 14f;
            entry.Panel.BorderPx = 3f;
            entry.Panel.ShadowLevel = "chip";
            entry.Panel.Frost = 0f;

            var labelHost = new GameObject("Text", typeof(TMPro.TextMeshPro), typeof(Label));
            labelHost.transform.SetParent(host.transform, false);
            labelHost.transform.localPosition = new Vector3(0f, 0f, -0.001f);
            entry.Label = labelHost.GetComponent<Label>();
            entry.Label.TypeRole = "caption";
            entry.Label.Alignment = TMPro.TextAlignmentOptions.Left;

            var glyphHost = new GameObject("Glyph", typeof(MeshFilter), typeof(MeshRenderer), typeof(IconQuad));
            glyphHost.transform.SetParent(host.transform, false);
            entry.Glyph = glyphHost.GetComponent<IconQuad>();
            entry.Glyph.SizeM = 0.016f;

            return entry;
        }

        public void SetActive(int index)
        {
            if (_active == index) return;
            _active = index;
            Refresh();
        }

        /// <summary>Called each frame by the runner with the active step's elapsed time.</summary>
        public void Tick(float elapsedSec)
        {
            if (_timer == null || _active < 0 || _active >= _entries.Count) return;
            var entry = _entries[_active];

            ArcGauge.TimerBand(elapsedSec, entry.MinDurationSec, entry.MaxDurationSec, out var progress, out var zoneStart, out var zoneEnd);
            _timer.SetProgress(progress);
            _timer.ZoneStart = zoneStart;
            _timer.ZoneEnd = zoneEnd;

            // The pulse at the minimum. Bounded to a slow, low-amplitude breath -- nothing in
            // this app may flash above 3Hz, and a timer that strobes when a step becomes valid
            // is exactly the kind of thing that ends up doing so.
            var pastMinimum = entry.MinDurationSec > 0 && elapsedSec >= entry.MinDurationSec;
            var theme = ThemeManager.Instance;
            var allowed = theme == null || theme.LoopingAnimation;
            _pulse = pastMinimum && allowed ? Mathf.PingPong(Time.time * 0.8f, 1f) : 0f;
            _timer.GlowStrength = _pulse * 0.25f;
            _timer.Refresh();
        }

        public void Refresh()
        {
            var first = Mathf.Max(0, _active - VisibleRows / 2);
            var row = 0;

            for (var i = 0; i < _entries.Count; i++)
            {
                var entry = _entries[i];
                if (entry.Panel == null) continue;

                var inWindow = i >= first && i < first + VisibleRows;
                entry.Panel.gameObject.SetActive(inWindow && !string.IsNullOrEmpty(entry.Text));
                if (!entry.Panel.gameObject.activeSelf) continue;

                var isActive = i == _active;
                var done = i < _active;

                entry.Panel.SizeM = new Vector2(WidthM, RowHeightM);
                entry.Panel.transform.localPosition = new Vector3(0f, -row * (RowHeightM + RowGapM), 0f);
                entry.Panel.Fill = isActive ? ColorRole.Accent2 : done ? ColorRole.Success : ColorRole.Surface;
                entry.Panel.Border = ColorRole.Ink;
                entry.Panel.OpacityScale = done ? 0.75f : 1f;
                entry.Panel.Refresh();

                if (entry.Label != null)
                {
                    entry.Label.Text = entry.Text;
                    entry.Label.Color = isActive || done ? ColorRole.TextPrimary : ColorRole.TextMuted;
                    entry.Label.OnFill = entry.Panel.Fill;
                    entry.Label.SizeM = new Vector2(WidthM - 0.03f, RowHeightM);
                    entry.Label.transform.localPosition = new Vector3(0.012f, 0f, -0.001f);
                    entry.Label.Refresh();
                }

                if (entry.Glyph != null)
                {
                    // Hot and knife steps are marked on the rail itself, so the cook can see
                    // the safe-mode step coming rather than having the HUD change under them.
                    var show = entry.Hot || entry.Knife || done;
                    entry.Glyph.gameObject.SetActive(show);
                    if (show)
                    {
                        entry.Glyph.SetIcon(done ? "status-ok" : entry.Hot ? "status-warn" : "status-warn");
                        entry.Glyph.Tint = ColorRole.Ink;
                        entry.Glyph.transform.localPosition = new Vector3(WidthM * 0.5f - 0.014f, 0f, -0.001f);
                        entry.Glyph.Refresh();
                    }
                }

                row++;
            }
        }
    }
}
