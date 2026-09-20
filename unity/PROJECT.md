# The Unity project

`unity/` is now a real, openable Unity project, not a loose folder of scripts. Open it with
Unity Hub → **Add → Add project from disk** → pick this folder.

- **Editor version:** 6000.6.2f1 (Unity 6.6). `ProjectSettings/ProjectVersion.txt` pins it.
- **Render pipeline:** URP 17.6.0. **Color space: Linear** — hex colours taken from a web
  design will *not* land on screen as-is; see `design/DEVIATIONS.md`.
- **XR:** OpenXR 1.18.0 + Meta XR All-in-One SDK 205.0.0.
- **Input:** the new Input System is active (`activeInputHandler: 1`). Legacy `Input.GetKey`
  throws at runtime, so nothing new may use it.

## `Assets/Scripts/Perception/` is gated off

Those scripts came from the OCR/OpenCV branch and need **OpenCV for Unity**, a paid asset that
is not in this project, plus the `PassthroughCameraSamples` namespace from a Meta XR *sample*
that has not been imported. They cannot compile as things stand, and an assembly that cannot
compile stops the whole project compiling with it.

`IsItDoneYet.Perception.asmdef` puts them in their own assembly with
`"defineConstraints": ["OPENCV_FOR_UNITY"]`. Unity skips an assembly whose constraint is unmet,
so the folder is inert until somebody turns it on. Nothing outside that folder references it.

To turn it on: import OpenCV for Unity and the Meta XR PassthroughCamera sample, then add
`OPENCV_FOR_UNITY` to **Project Settings → Player → Android → Scripting Define Symbols**.

The scripts themselves are unmodified. The `.asmdef` is the only file added to that folder.
