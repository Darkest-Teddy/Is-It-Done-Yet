"""CaptainCook4D helper: annotation stats, recipe-filtered GoPro download, manifest.

Driven by download_captaincook4d.sh, which clones the pinned upstream repos and
creates the virtualenv first. Run it through that script rather than directly.

Why a wrapper at all: upstream `download_gopro_data.py --data2d` has no recording or
recipe filter, so it always fetches all 384 recordings (~41 GB at 360p). This module
selects recordings by recipe from the annotations, then hands exactly those URLs to
upstream's own `util.download_data()`, using the same link keys, the same Hololens
fallback for the one recording without a GoPro 360p file, and the same output layout.
Nothing upstream is modified.

Subcommands:
  stats     print recording / recipe / error-type statistics from the annotations
  plan      resolve recipes to recordings and report the exact download size
  download  plan, refuse above --max-gb, then download via upstream util.download_data
  manifest  verify downloaded files (size vs server, ffprobe) and write manifest.csv
"""

import argparse
import collections
import csv
import hashlib
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

GOPRO_360P = "gopro_360p"
HOLOLENS_PV = "hololens_sync_pv_video"
BYTES_PER_GB = 1e9


def load_annotations(ann_dir):
    ann_dir = Path(ann_dir)
    complete = json.loads((ann_dir / "annotation_json/complete_step_annotations.json").read_text())
    errors = {r["recording_id"]: r for r in json.loads((ann_dir / "annotation_json/error_annotations.json").read_text())}
    with open(ann_dir / "metadata/video_information.csv", newline="") as f:
        video_info = {r["recording_id"]: r for r in csv.DictReader(f)}
    return complete, errors, video_info


def recipe_key(name):
    return "".join(ch for ch in name.lower() if ch.isalnum())


def cmd_stats(args):
    complete, errors, video_info = load_annotations(args.annotations)
    per_recipe = collections.defaultdict(lambda: {"normal": 0, "error": 0, "minutes": 0.0})
    step_tags = collections.Counter()
    recording_tags = collections.Counter()
    for rid, rec in complete.items():
        row = per_recipe[(rec["activity_id"], rec["activity_name"])]
        row["error" if errors[rid]["is_error"] else "normal"] += 1
        row["minutes"] += float(video_info[rid]["duration(min)"])
        seen = set()
        for step in errors[rid]["step_annotations"]:
            for err in step.get("errors") or []:
                step_tags[err["tag"]] += 1
                seen.add(err["tag"])
        recording_tags.update(seen)

    n_err = sum(r["error"] for r in per_recipe.values())
    n_norm = sum(r["normal"] for r in per_recipe.values())
    persons = sorted({str(r["person_id"]) for r in complete.values()}, key=int)
    envs = sorted({str(r["environment"]) for r in complete.values()}, key=int)
    hours = sum(float(r["duration(min)"]) for r in video_info.values()) / 60
    print(f"recordings: {len(complete)} ({n_norm} normal, {n_err} with errors)")
    print(f"recipes: {len(per_recipe)}")
    print(f"participants: {len(persons)} {persons}")
    print(f"environments (kitchens): {len(envs)} {envs}")
    print(f"total video: {hours:.1f} h")
    print("\nerror category | steps tagged | recordings containing it")
    for tag, n in step_tags.most_common():
        print(f"{tag} | {n} | {recording_tags[tag]}")
    print("\nactivity_id | recipe | normal | error | total | minutes")
    for (aid, name), r in sorted(per_recipe.items()):
        print(f"{aid} | {name} | {r['normal']} | {r['error']} | {r['normal'] + r['error']} | {r['minutes']:.0f}")


def select_recordings(complete, recipes):
    wanted = {recipe_key(r): r for r in recipes}
    known = {recipe_key(r["activity_name"]): r["activity_name"] for r in complete.values()}
    unknown = [r for k, r in wanted.items() if k not in known]
    if unknown:
        sys.exit(f"unknown recipe(s): {unknown}\nknown recipes: {sorted(set(known.values()))}")
    return sorted(
        (rid for rid, rec in complete.items() if recipe_key(rec["activity_name"]) in wanted),
        key=lambda rid: tuple(int(p) for p in rid.split("_")),
    )


def link_for(links, rid):
    """Mirror upstream download_gopro_data.py: GoPro 360p, else the Hololens PV view."""
    entry = links.get(rid) or {}
    if entry.get(GOPRO_360P):
        return entry[GOPRO_360P], GOPRO_360P
    if entry.get(HOLOLENS_PV):
        return entry[HOLOLENS_PV], HOLOLENS_PV
    return None, None


def remote_size(url):
    """Box rejects HEAD (404), so read the total from a 1-byte ranged GET's Content-Range."""
    import requests

    for _ in range(3):
        try:
            r = requests.get(url, headers={"Range": "bytes=0-0"}, allow_redirects=True, timeout=30, stream=True)
            r.close()
            content_range = r.headers.get("content-range", "")
            if r.status_code == 206 and "/" in content_range:
                return int(content_range.rsplit("/", 1)[1])
        except requests.RequestException:
            pass
    return None


def build_plan(args):
    complete, _, _ = load_annotations(args.annotations)
    links = json.loads(Path(args.links).read_text())
    rows = []
    for rid in select_recordings(complete, args.recipes):
        url, source = link_for(links, rid)
        rows.append({"recording_id": rid, "recipe": complete[rid]["activity_name"], "url": url, "source": source})
    with ThreadPoolExecutor(max_workers=8) as pool:
        sizes = list(pool.map(lambda row: remote_size(row["url"]) if row["url"] else None, rows))
    for row, size in zip(rows, sizes):
        row["size_bytes"] = size
    return rows


def print_plan(rows):
    by_recipe = collections.defaultdict(lambda: [0, 0])
    for row in rows:
        by_recipe[row["recipe"]][0] += 1
        by_recipe[row["recipe"]][1] += row["size_bytes"] or 0
    for recipe, (n, size) in sorted(by_recipe.items()):
        print(f"  {recipe:34s} {n:3d} recordings  {size / BYTES_PER_GB:6.2f} GB")
    total = sum(row["size_bytes"] or 0 for row in rows)
    print(f"  {'TOTAL':34s} {len(rows):3d} recordings  {total / BYTES_PER_GB:6.2f} GB")
    missing = [row["recording_id"] for row in rows if row["url"] is None or row["size_bytes"] is None]
    if missing:
        print(f"  no link or size for: {missing}")
    return total, missing


def cmd_plan(args):
    print_plan(build_plan(args))


def cmd_download(args):
    rows = build_plan(args)
    total, missing = print_plan(rows)
    if missing:
        sys.exit("refusing to download: some recordings have no link or no reported size")
    if total > args.max_gb * BYTES_PER_GB:
        sys.exit(f"refusing to download: {total / BYTES_PER_GB:.2f} GB exceeds --max-gb {args.max_gb}")

    sys.path.insert(0, str(Path(args.downloader).resolve()))
    from util import download_data  # upstream CaptainCook4D/downloader

    out = Path(args.output_dir) / "captain_cook_4d" / "gopro" / "resolution_360p"
    download_data([row["url"] for row in rows], [out / f"{row['recording_id']}_360p.mp4" for row in rows])


def ffprobe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=codec_name,width,height,avg_frame_rate:format=duration", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    info = json.loads(out.stdout)
    stream = info["streams"][0]
    num, den = (int(x) for x in stream["avg_frame_rate"].split("/"))
    return {
        "codec": stream["codec_name"],
        "width": stream["width"],
        "height": stream["height"],
        "fps": round(num / den, 3) if den else "",
        "duration_s": round(float(info["format"]["duration"]), 2),
    }


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def cmd_manifest(args):
    complete, errors, video_info = load_annotations(args.annotations)
    rows = build_plan(args)
    video_dir = Path(args.output_dir) / "captain_cook_4d" / "gopro" / "resolution_360p"
    repo_root = Path(args.repo_root).resolve()
    fields = ["recording_id", "recipe", "activity_id", "label", "person_id", "environment_id", "source",
              "path", "duration_s", "annotated_duration_s", "size_bytes", "server_size_bytes",
              "width", "height", "fps", "codec", "sha256"]
    problems = []
    written = 0
    with open(args.manifest, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            rid = row["recording_id"]
            path = video_dir / f"{rid}_360p.mp4"
            if not path.exists():
                problems.append(f"{rid}: missing {path}")
                continue
            size = path.stat().st_size
            if size != row["size_bytes"]:
                problems.append(f"{rid}: local {size} B != server {row['size_bytes']} B")
            probe = ffprobe(path)
            rec = complete[rid]
            writer.writerow({
                "recording_id": rid,
                "recipe": rec["activity_name"],
                "activity_id": rec["activity_id"],
                "label": "error" if errors[rid]["is_error"] else "normal",
                "person_id": rec["person_id"],
                "environment_id": rec["environment"],
                "source": row["source"],
                "path": str(path.resolve().relative_to(repo_root)),
                "annotated_duration_s": video_info[rid]["duration(sec)"],
                "size_bytes": size,
                "server_size_bytes": row["size_bytes"],
                "sha256": sha256(path),
                **probe,
            })
            written += 1
    print(f"wrote {written} rows to {args.manifest}")
    if problems:
        print("PROBLEMS:\n  " + "\n  ".join(problems))
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    stats = sub.add_parser("stats")
    stats.add_argument("--annotations", required=True)
    stats.set_defaults(func=cmd_stats)

    for name, func in (("plan", cmd_plan), ("download", cmd_download), ("manifest", cmd_manifest)):
        p = sub.add_parser(name)
        p.add_argument("--annotations", required=True)
        p.add_argument("--links", required=True, help="upstream downloader metadata/download_links.json")
        p.add_argument("--recipes", required=True, nargs="+", help='recipe names, e.g. "Pan Fried Tofu"')
        p.add_argument("--output-dir", default="data/captaincook4d/raw")
        p.set_defaults(func=func)
        if name == "download":
            p.add_argument("--downloader", required=True, help="upstream CaptainCook4D/downloader checkout")
            p.add_argument("--max-gb", type=float, default=20.0)
        if name == "manifest":
            p.add_argument("--manifest", default="data/captaincook4d/manifest.csv")
            p.add_argument("--repo-root", default=".")

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
