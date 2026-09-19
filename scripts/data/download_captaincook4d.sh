#!/usr/bin/env bash
# Reproduce the CaptainCook4D annotations + recipe-filtered GoPro 360p download.
#
# Usage (from anywhere inside the repo):
#   scripts/data/download_captaincook4d.sh "Tomato Mozzarella Salad" "Sauted Mushrooms" "Pan Fried Tofu"
#
# Recipe names are matched case- and punctuation-insensitively against the
# annotations (note upstream's spelling: "Sauted Mushrooms"). Run with no
# arguments to list all 24 recipes with their sizes.
#
# Environment:
#   MAX_GB=20        refuse to download if the planned total exceeds this
#   SKIP_VIDEO=1     only fetch annotations and print stats
#
# Needs: git, python3 (3.9+), ffprobe (for the manifest step), ~6 GB free for the
# default three recipes. Videos land in data/captaincook4d/raw/ (gitignored).
set -euo pipefail

# Pinned upstream commits, so a rerun reproduces exactly what the PR describes.
DOWNLOADER_REPO=https://github.com/CaptainCook4D/downloader.git
DOWNLOADER_SHA=cf248fe2139fc6e37f9737141ec719948fbd1747
ANNOTATIONS_REPO=https://github.com/CaptainCook4D/annotations.git
ANNOTATIONS_SHA=a8a920a3293c4db27099a20ddbe3a3a9be1283e3

ROOT="$(git rev-parse --show-toplevel)"
DATA="$ROOT/data/captaincook4d"
CACHE="$DATA/.cache"
HELPER="$ROOT/scripts/data/captaincook4d.py"

checkout() {  # checkout <url> <sha> <dir>
  if [ ! -d "$3/.git" ]; then
    git clone --quiet "$1" "$3"
  fi
  git -C "$3" fetch --quiet origin
  git -C "$3" -c advice.detachedHead=false checkout --quiet "$2"
}

mkdir -p "$CACHE"
checkout "$DOWNLOADER_REPO" "$DOWNLOADER_SHA" "$CACHE/downloader"
checkout "$ANNOTATIONS_REPO" "$ANNOTATIONS_SHA" "$CACHE/annotations"

if [ ! -x "$CACHE/venv/bin/python" ]; then
  python3 -m venv "$CACHE/venv"
fi
"$CACHE/venv/bin/pip" install --quiet --disable-pip-version-check -r "$ROOT/scripts/data/requirements.txt"
PY="$CACHE/venv/bin/python"

# Annotations: every tracked upstream file except its .gitignore (small CSV/JSON, ~7.5 MB).
echo "== copying annotations @ ${ANNOTATIONS_SHA:0:7}"
rm -rf "$DATA/annotations"
mkdir -p "$DATA/annotations"
git -C "$CACHE/annotations" ls-files | grep -v '^\.gitignore$' | while IFS= read -r f; do
  mkdir -p "$DATA/annotations/$(dirname "$f")"
  cp "$CACHE/annotations/$f" "$DATA/annotations/$f"
done

echo "== annotation stats"
"$PY" "$HELPER" stats --annotations "$DATA/annotations"

LINKS="$CACHE/downloader/metadata/download_links.json"

if [ "$#" -eq 0 ]; then
  echo
  echo "== no recipes given; sizes for every recipe (GoPro 360p):"
  RECIPES=()
  while IFS= read -r name; do RECIPES+=("$name"); done < <(
    "$PY" -c 'import csv,sys; print("\n".join(sorted({r["activity_name"] for r in csv.DictReader(open(sys.argv[1]))})))' \
      "$DATA/annotations/annotation_csv/activity_idx_step_idx.csv")
  "$PY" "$HELPER" plan --annotations "$DATA/annotations" --links "$LINKS" --recipes "${RECIPES[@]}"
  echo
  echo "Pass recipe names as arguments to download them."
  exit 0
fi

if [ "${SKIP_VIDEO:-0}" = "1" ]; then
  exit 0
fi

echo
echo "== downloading GoPro 360p for: $*"
"$PY" "$HELPER" download --annotations "$DATA/annotations" --links "$LINKS" \
  --downloader "$CACHE/downloader" --output-dir "$DATA/raw" --max-gb "${MAX_GB:-20}" --recipes "$@"

echo
echo "== verifying and writing manifest"
command -v ffprobe >/dev/null || { echo "ffprobe not found (brew install ffmpeg)"; exit 1; }
"$PY" "$HELPER" manifest --annotations "$DATA/annotations" --links "$LINKS" \
  --output-dir "$DATA/raw" --manifest "$DATA/manifest.csv" --repo-root "$ROOT" --recipes "$@"
