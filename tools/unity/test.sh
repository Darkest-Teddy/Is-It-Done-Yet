#!/usr/bin/env bash
# Runs the EditMode suite in batchmode and prints the counts.
#
# NOT with -quit. Combining -quit with -runTests makes Unity exit before the run and write no
# results file at all, which reads exactly like "the tests were skipped" -- the first attempt
# at this reported EXIT=0 and produced nothing.
set -uo pipefail
UNITY="${UNITY:-/Applications/Unity/Hub/Editor/6000.6.2f1/Unity.app/Contents/MacOS/Unity}"
PROJECT="${PROJECT:-/Users/shiv/Is-It-Done-Yet/unity}"
RESULTS="${RESULTS:-/tmp/unity-tests.xml}"
LOG="${LOG:-/tmp/unity-test.log}"

if pgrep -f "Unity.app/Contents/MacOS/Unity" >/dev/null; then
  echo "Unity is running. Quit it before batchmode." >&2
  exit 2
fi

rm -f "$RESULTS" "$LOG"
"$UNITY" -batchmode -projectPath "$PROJECT" -logFile "$LOG" \
  -runTests -testPlatform "${1:-EditMode}" -testResults "$RESULTS"
code=$?

python3 - "$RESULTS" <<'PY'
import sys, os, xml.etree.ElementTree as ET
path = sys.argv[1]
if not os.path.exists(path):
    print("NO RESULTS FILE -- the run did not happen"); raise SystemExit(1)
root = ET.parse(path).getroot()
print("total=%s passed=%s failed=%s skipped=%s duration=%ss" % (
    root.get("total"), root.get("passed"), root.get("failed"),
    root.get("skipped"), root.get("duration")))
for case in root.iter("test-case"):
    if case.get("result") != "Passed":
        print("FAIL:", case.get("fullname"))
        message = case.find(".//message")
        if message is not None and message.text:
            print("   ", message.text.strip().splitlines()[0][:200])
PY
exit $code
