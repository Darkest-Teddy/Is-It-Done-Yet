#!/usr/bin/env bash
# Compiles the Unity project in batchmode and prints only what matters.
#
# No -nographics: shader compilation and any screenshot capture need a graphics device, and
# the failure without one is a silently-null material rather than an error.
set -uo pipefail
UNITY="${UNITY:-/Applications/Unity/Hub/Editor/6000.6.2f1/Unity.app/Contents/MacOS/Unity}"
PROJECT="${PROJECT:-/Users/shiv/Is-It-Done-Yet/unity}"
LOG="${LOG:-/tmp/unity-compile.log}"

if pgrep -f "Unity.app/Contents/MacOS/Unity" >/dev/null; then
  echo "Unity is running. Quit it (Cmd-Q) before batchmode; the Editor holds a project lock." >&2
  exit 2
fi

rm -f "$LOG"
"$UNITY" -batchmode -projectPath "$PROJECT" -logFile "$LOG" -quit "$@"
code=$?

echo "--- exit $code ---"
grep -E "error CS[0-9]+|Compilation failed|Assembly.*could not be|Unable to resolve|[Ss]hader error|Failed to compile" "$LOG" | sort -u | head -40
warnings=$(grep -cE "warning CS[0-9]+" "$LOG")
echo "--- $warnings compiler warnings ---"
grep -E "warning CS[0-9]+" "$LOG" | sed -E 's/.*(warning CS[0-9]+)/\1/' | sort | uniq -c | sort -rn | head -10
exit $code
