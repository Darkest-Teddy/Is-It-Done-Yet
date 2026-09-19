# data/

External datasets used for offline experiments. Nothing in here is imported by the app.
`data/` is outside both `src/` and Vite's `public/` directory, so `npm run build` bundles none
of it.

## CaptainCook4D

Egocentric cooking videos with step-level and error annotations: 384 recordings of 24 recipes
by 8 participants in 10 kitchens, with deliberate mistakes such as wrong order, wrong
technique and wrong temperature.

| | |
|---|---|
| Project page | https://captaincook4d.github.io/captain-cook/ |
| Paper | NeurIPS 2024 Datasets and Benchmarks Track, [PDF](https://proceedings.neurips.cc/paper_files/paper/2024/file/f4a04396c2ed1342a5d8d05e94cb6101-Paper-Datasets_and_Benchmarks_Track.pdf), [arXiv 2312.14556](https://arxiv.org/abs/2312.14556) |
| Annotations | https://github.com/CaptainCook4D/annotations @ `a8a920a3293c4db27099a20ddbe3a3a9be1283e3` |
| Downloader | https://github.com/CaptainCook4D/downloader @ `cf248fe2139fc6e37f9737141ec719948fbd1747` |
| Video host | Box (`utdallas.box.com`), via the links in the downloader's `metadata/download_links.json` |

### License and attribution

The project page states: *"We provide the data under the Apache license 2.0."* The upstream
annotations README says the same, and so does the downloader repository, which ships the
Apache 2.0 text.

**One discrepancy.** The `LICENSE` file inside the annotations repository is the **MIT**
licence ("Copyright (c) 2023 Error-Dataset"), not Apache 2.0. Both licences are permissive and
both allow redistribution with attribution. We redistribute the annotation files unmodified
and keep that MIT `LICENSE` beside them in `captaincook4d/annotations/LICENSE`, as MIT
requires. We also follow the project page's Apache 2.0 statement for the dataset as a whole:
attribution below, and no endorsement implied. The upstream annotations README also links the
IRB approval and participant consent forms.

If you use this data, cite:

```bibtex
@inproceedings{NEURIPS2024_f4a04396,
 author = {Peddi, Rohith and Arya, Shivvrat and Challa, Bharath and Pallapothula, Likhitha and Vyas, Akshay and Gouripeddi, Bhavya and Zhang, Qifan and Wang, Jikai and Komaragiri, Vasundhara and Ragan, Eric and Ruozzi, Nicholas and Xiang, Yu and Gogate, Vibhav},
 booktitle = {Advances in Neural Information Processing Systems},
 editor = {A. Globerson and L. Mackey and D. Belgrave and A. Fan and U. Paquet and J. Tomczak and C. Zhang},
 pages = {135626--135679},
 publisher = {Curran Associates, Inc.},
 title = {CaptainCook4D: A Dataset for Understanding Errors in Procedural Activities},
 url = {https://proceedings.neurips.cc/paper_files/paper/2024/file/f4a04396c2ed1342a5d8d05e94cb6101-Paper-Datasets_and_Benchmarks_Track.pdf},
 volume = {37},
 year = {2024}
}
```

### What is in the repo, and what is not

| Path | In git? | What |
|---|---|---|
| `captaincook4d/annotations/` | yes, 7.5 MB | Every tracked file of the upstream annotations repo except its `.gitignore`: `annotation_json/`, `annotation_csv/`, `data_splits/`, `metadata/`, `task_graphs/`, `README.md`, `ANNOTATIONS.md`, `LICENSE` (MIT, see above). The largest file is 2.0 MB. |
| `captaincook4d/manifest.csv` | yes | One row per video downloaded locally, with checksums and ffprobe results (see below). |
| `captaincook4d/raw/` | **no**, gitignored | The downloaded GoPro videos. |
| `captaincook4d/.cache/` | **no**, gitignored | Pinned clones of the upstream repos plus a Python virtualenv. |
| `../scripts/data/` | yes | `download_captaincook4d.sh` (entry point), `captaincook4d.py` (helper), `requirements.txt` (pinned). |

**Raw videos are deliberately not committed.** They are hundreds of megabytes per recipe, the
licence permits anyone to fetch them from the original host, and the script re-downloads them
byte for byte: each file is checked against the size the server reports, and `manifest.csv`
records its SHA-256.

### Reproducing the download

Requires git, python3 (3.9 or later), and `ffprobe` (`brew install ffmpeg`).

```bash
# List all 24 recipes with their GoPro 360p sizes. Fetches annotations; downloads no video.
scripts/data/download_captaincook4d.sh

# What was downloaded for this PR:
scripts/data/download_captaincook4d.sh "Tomato Mozzarella Salad" "Sauted Mushrooms" "Pan Fried Tofu"
```

The script does four things:

1. Clones both upstream repos at the pinned commits into `data/captaincook4d/.cache/`, creates a
   virtualenv there, and installs `scripts/data/requirements.txt`.
2. Copies the annotations into `data/captaincook4d/annotations/` and prints the statistics below.
3. Resolves the recipes to recordings, measures each file on the server, and **refuses to run if
   the total exceeds `MAX_GB`** (default 20). It then downloads the files with the upstream
   downloader's own `util.download_data()`.
4. Verifies every file (local size must equal server size; ffprobe must read it) and writes
   `manifest.csv`.

Recipe names match upstream's spelling, but case and punctuation are ignored. Note that
upstream spells it "Sauted Mushrooms".

**Why a wrapper instead of running `download_gopro_data.py` directly.** Upstream's
`python download_gopro_data.py --data2d` has no recording or recipe filter, so it always fetches
all 384 GoPro 360p videos, 41.1 GB in total. The wrapper builds the same URL list and target
paths for a subset only. It uses the same link keys, the same output layout
(`<output_dir>/captain_cook_4d/gopro/resolution_360p/<recording_id>_360p.mp4`), and the same
fallback: a recording with no GoPro 360p file gets the HoloLens view. It then calls upstream's
download function unchanged. 360p is the lowest resolution offered; the other GoPro variant is
4K. No HoloLens depth, pose or IMU data is downloaded.

Two upstream quirks worth knowing:

- Box answers HEAD requests with 404. Sizes are read from a 1-byte ranged GET instead, using the
  `Content-Range` header.
- The downloader publishes no checksums. Verification here is size-versus-server plus a
  successful ffprobe. The SHA-256 values in the manifest are computed locally, so that later
  runs can be compared against this one.

### Annotation statistics

Produced by `scripts/data/captaincook4d.py stats`, from `complete_step_annotations.json`
(recipe, person, environment), `error_annotations.json` (`is_error` and error tags) and
`metadata/video_information.csv` (durations).

- **384 recordings**: 164 normal and 220 containing at least one error. 94.4 hours of video.
- **24 recipes.** Activity ids are not contiguous: 6, 11, 14, 19 and 24 are unused.
- **8 participants** (ids 1–8) and **10 environments/kitchens** (ids 1–3 and 5–11).

The error taxonomy (`error_category_idx.json`) has 7 named categories plus `Other`:

| Error category | Steps tagged | Recordings containing it |
|---|---:|---:|
| Order Error | 795 | 117 |
| Technique Error | 502 | 179 |
| Preparation Error | 410 | 154 |
| Measurement Error | 331 | 147 |
| Missing Step | 285 | 140 |
| Timing Error | 177 | 122 |
| Temperature Error | 66 | 58 |
| Other | 8 | 7 |

| id | Recipe | Normal | Error | Total | Minutes |
|---:|---|---:|---:|---:|---:|
| 1 | Microwave Egg Sandwich | 5 | 13 | 18 | 163 |
| 2 | Dressed Up Meatballs | 6 | 10 | 16 | 304 |
| 3 | Microwave Mug Pizza | 5 | 8 | 13 | 156 |
| 4 | Ramen | 10 | 7 | 17 | 231 |
| 5 | Coffee | 8 | 7 | 15 | 213 |
| 7 | Breakfast Burritos | 6 | 10 | 16 | 163 |
| 8 | Spiced Hot Chocolate | 6 | 10 | 16 | 110 |
| 9 | Microwave French Toast | 9 | 5 | 14 | 156 |
| 10 | Pinwheels | 4 | 8 | 12 | 115 |
| 12 | Tomato Mozzarella Salad | 11 | 7 | 18 | 116 |
| 13 | Butter Corn Cup | 5 | 9 | 14 | 188 |
| 15 | Tomato Chutney | 5 | 10 | 15 | 321 |
| 16 | Scrambled Eggs | 6 | 10 | 16 | 349 |
| 17 | Cucumber Raita | 12 | 8 | 20 | 257 |
| 18 | Zoodles | 4 | 11 | 15 | 212 |
| 20 | Sauted Mushrooms | 6 | 8 | 14 | 296 |
| 21 | Blender Banana Pancakes | 7 | 12 | 19 | 262 |
| 22 | Herb Omelet with Fried Tomatoes | 6 | 11 | 17 | 230 |
| 23 | Broccoli Stir Fry | 10 | 6 | 16 | 445 |
| 25 | Pan Fried Tofu | 7 | 8 | 15 | 341 |
| 26 | Mug Cake | 7 | 10 | 17 | 284 |
| 27 | Cheese Pimiento | 6 | 9 | 15 | 192 |
| 28 | Spicy Tuna Avocado Wraps | 7 | 11 | 18 | 280 |
| 29 | Caprese Bruschetta | 6 | 12 | 18 | 278 |

**The schema differs from `ANNOTATIONS.md`.** The shipped `complete_step_annotations.json` is
a dict keyed by recording id. Its fields are `person_id`, `environment` and `steps`. It has
**no** `is_error` field and no per-step error tags. Take `is_error` and the error tags from
`error_annotations.json`, which is a list of 384 entries.

### Downloaded locally (not committed)

Recipes chosen: one knife-only recipe, plus two simple pan recipes built on small ingredients
where browning matters.

| Recipe | Videos | Normal | Error | Size | Minutes | Participants | Kitchens |
|---|---:|---:|---:|---:|---:|---|---|
| Tomato Mozzarella Salad | 18 | 11 | 7 | 1.06 GB | 116 | 2, 3, 4, 5, 8 | 1, 2, 5, 6, 7, 11 |
| Sauted Mushrooms | 14 | 6 | 8 | 2.05 GB | 296 | 1, 2, 3, 4, 5, 8 | 1, 2, 5, 6, 7 |
| Pan Fried Tofu | 15 | 7 | 8 | 2.36 GB | 341 | 1, 2, 4, 5, 8 | 1, 2, 5, 6, 7 |
| **Total** | **47** | **24** | **23** | **5.47 GB** (5,467,138,068 B) | **753** | | |

Verification:

- 47 of 47 files are present.
- Every local size equals the size the server reports.
- ffprobe reads every file, and the probed durations match `video_information.csv` to within
  0.01 s.
- All 47 are 640×360. 46 are GoPro h264 at 29.97 fps. `12_6` (Tomato Mozzarella Salad) has no
  GoPro 360p upstream, so it is the HoloLens PV view (mpeg4, 30 fps) and is marked
  `source=hololens_sync_pv_video` in the manifest.

`manifest.csv` columns: `recording_id, recipe, activity_id, label (normal|error), person_id,
environment_id, source, path, duration_s (ffprobe), annotated_duration_s, size_bytes,
server_size_bytes, width, height, fps, codec, sha256`.

### Train/test splits must be grouped by participant or kitchen

There are only **8 participants** and 10 kitchens, and every participant cooks many recipes. A
random split by recording puts the same person and kitchen in both train and test, so a model
can score well by recognising the person or the room rather than the error. Group splits by
`person_id` (for example leave-one-participant-out) or by `environment_id`.

Upstream's `data_splits/` bears this out:

- `person_data_split_*.json` groups properly: train uses participants {3, 4, 5, 6}, val {7, 8},
  test {1, 2}.
- `environment_data_split_*.json` also groups properly: train uses kitchens {1, 2, 5}, val
  {6, 7}, test {3, 8, 9, 10, 11}.
- `recordings_data_split_*.json` **leaks**: all 8 participants appear in train, val and test.
- `recipes_data_split_*.json` are **empty** (0 recordings in every split).
