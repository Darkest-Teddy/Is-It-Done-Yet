using System.Collections.Generic;
using IsItDoneYet.Core;
using IsItDoneYet.Design;
using UnityEngine;

namespace IsItDoneYet.App
{
    /// <summary>
    /// The coach's messages, stacked below the eye line, and the only thing in the HUD that
    /// follows the head.
    ///
    /// Everything else is world-locked, which is what makes the app feel like it is in the room
    /// rather than on a screen. Toasts are the exception because they are the one element that
    /// is useless if you have to go looking for it -- and they follow lazily, with a dead zone,
    /// so small head movement leaves them alone and they still read as part of the room.
    ///
    /// The stack is capped. A wall of toasts is a wall nobody reads, so a fourth message
    /// dismisses the oldest rather than growing the column.
    /// </summary>
    public class ToastStack : MonoBehaviour
    {
        [Header("Wiring")]
        public LayoutConfig Layout;
        public Transform Head;
        public Toast Prototype;

        readonly List<Toast> _pool = new List<Toast>();
        readonly List<Toast> _live = new List<Toast>();
        Vector3 _followPosition;
        bool _positioned;

        void LateUpdate()
        {
            if (Layout == null || Head == null) return;

            Layout.Pose(LayoutAnchor.Toast, Head.position, Head.rotation, out var target, out var rotation);

            if (!_positioned)
            {
                _followPosition = target;
                _positioned = true;
            }
            else
            {
                _followPosition = AngularLayout.LazyFollow(
                    _followPosition, target, Head.position,
                    Layout.ToastDeadZoneDeg, Layout.ToastFollowSmoothing, Time.deltaTime);
            }

            transform.SetPositionAndRotation(_followPosition, rotation);

            // Expiry runs backwards so removing an entry does not skip the next one -- the
            // classic forward-loop-with-RemoveAt bug, which here would leave one toast on
            // screen for the rest of the run.
            var now = Time.time;
            for (var i = _live.Count - 1; i >= 0; i--)
            {
                if (now - _live[i].ShownAt < Layout.ToastDismissSeconds) continue;
                Retire(_live[i]);
                _live.RemoveAt(i);
                Relayout();
            }
        }

        public void Show(string id, string text, ObservationStatus status, float confidence)
        {
            if (Prototype == null) return;

            // Same id again: refresh it in place rather than stacking a duplicate. A condition
            // that persists should keep one toast alive, not print a column of identical ones.
            for (var i = 0; i < _live.Count; i++)
            {
                if (_live[i].Id != id) continue;
                _live[i].Show(id, text, status, confidence, Time.time);
                return;
            }

            while (_live.Count >= Mathf.Max(1, Layout != null ? Layout.ToastMaxStack : 3))
            {
                Retire(_live[0]);
                _live.RemoveAt(0);
            }

            var toast = Rent();
            toast.Show(id, text, status, confidence, Time.time);
            _live.Add(toast);
            Relayout();
        }

        /// <summary>
        /// The "not sure" state, which is a message rather than an absence.
        ///
        /// When the pan is out of frame or the model keeps abstaining, the HUD says so. Going
        /// blank instead would read as the app having crashed, and the cook would stop trusting
        /// the times it does speak.
        /// </summary>
        public void ShowUnsure(bool offline)
        {
            Show("unsure",
                offline ? "Coach offline — still scoring." : "Can't see the pan.",
                ObservationStatus.Unknown,
                0.2f);
        }

        Toast Rent()
        {
            for (var i = 0; i < _pool.Count; i++)
            {
                if (_pool[i].gameObject.activeSelf) continue;
                _pool[i].gameObject.SetActive(true);
                return _pool[i];
            }
            var created = Instantiate(Prototype, transform);
            _pool.Add(created);
            return created;
        }

        void Retire(Toast toast) => toast.gameObject.SetActive(false);

        void Relayout()
        {
            var spacing = Layout != null ? Layout.ToastSpacingM : 0.09f;
            for (var i = 0; i < _live.Count; i++)
            {
                // Newest at the bottom, nearest the eye line. A stack that grows downward
                // pushes the newest message furthest from where the cook is looking.
                var row = _live.Count - 1 - i;
                _live[i].transform.localPosition = new Vector3(0f, -row * spacing, 0f);
            }
        }

        public void ClearAll()
        {
            for (var i = 0; i < _live.Count; i++) Retire(_live[i]);
            _live.Clear();
        }
    }
}
