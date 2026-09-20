using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace IsItDoneYet.Design.Editor
{
    /// <summary>
    /// An Android development build, for catching what only a real build catches.
    ///
    /// Compiling is not building. A build runs IL2CPP over the whole tree, strips what nothing
    /// references, resolves every shader that will actually ship, and packages the Android
    /// manifest — and each of those has its own way of failing on code that compiles perfectly.
    /// Shader stripping in particular is why `Shader.Find` returns null in a player and works in
    /// the Editor.
    ///
    /// This produces an APK. It does NOT mean the APK runs: nothing here has been on a device.
    /// </summary>
    public static class BuildScript
    {
        public static void BuildAndroidDevelopment()
        {
            var scenes = EditorBuildSettings.scenes.Where(s => s.enabled).Select(s => s.path).ToArray();
            if (scenes.Length == 0)
            {
                Debug.LogError("[Build] no enabled scenes in EditorBuildSettings");
                EditorApplication.Exit(1);
                return;
            }

            var output = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "build", "IsItDoneYet-dev.apk"));
            Directory.CreateDirectory(Path.GetDirectoryName(output) ?? ".");

            var options = new BuildPlayerOptions
            {
                scenes = scenes,
                locationPathName = output,
                target = BuildTarget.Android,
                targetGroup = BuildTargetGroup.Android,
                // Development, so the dev layer compiles in and any IL2CPP or stripping problem
                // surfaces with a usable message rather than as a silent removal.
                options = BuildOptions.Development | BuildOptions.AllowDebugging,
            };

            var report = BuildPipeline.BuildPlayer(options);
            var summary = report.summary;

            // `summary.totalSize` counts the uncompressed build output, not the artifact --
            // it reported 1992MB for a 138MB APK, which would have gone straight into a
            // report as a package size. The file on disk is the number anybody wants.
            var apkBytes = File.Exists(output) ? new FileInfo(output).Length : 0;
            Debug.Log($"[Build] {summary.result} — APK {apkBytes / 1024 / 1024}MB " +
                      $"(build output {summary.totalSize / 1024 / 1024}MB) in {summary.totalTime}");

            foreach (var step in report.steps)
            {
                foreach (var message in step.messages)
                {
                    if (message.type == LogType.Error || message.type == LogType.Exception)
                        Debug.LogError($"[Build] {step.name}: {message.content}");
                }
            }

            if (summary.result != BuildResult.Succeeded) EditorApplication.Exit(1);
        }
    }
}
