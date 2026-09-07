# demo-videos-truemarks

Self-contained Playwright pipeline that records narrated demo videos of the
**TrueMarks** product line — **VidRec LE** (digital video recovery worksheets)
and **VidEx LE** (forensic video analysis) — from their PUBLIC marketing pages:

- https://truemarks.ai/
- https://truemarks.ai/vidrec-le
- https://truemarks.ai/videx-le

No logins, no credentials, no app surfaces. Narration claims come only from
the live site copy — the scene files (`scenes/*.mjs`) note this and should
stay that way.

This directory is independent of `ops/demo-videos/` (the Bandit demo pipeline)
— separate deps, separate scripts, nothing shared.

## Requirements

- Node 20+, `ffmpeg`/`ffprobe` on PATH (`brew install ffmpeg`)
- macOS `say` for narration (anything else falls back to a silent track —
  the cut still renders, subtitles still burn)
- `npm install` here (installs Playwright; run `npx playwright install chromium`
  once if the browser is not already cached)

## Usage

```bash
npm install
npm run all          # record + assemble both products
# or per product:
npm run vidrec       # -> ~/Desktop/bandit-demos/vidrec-<YYYY-MM-DD>.mp4
npm run videx        # -> ~/Desktop/bandit-demos/videx-<YYYY-MM-DD>.mp4
```

Two phases per product:

1. `record.mjs <product>` — drives headless chromium (1280x720, dark scheme)
   through the scene steps, records video, synthesizes per-step narration with
   `say`, and sizes each step's dwell time to its narration line. Emits
   `out/<product>/{raw.webm, subs.srt, steps.tsv, timeline.json, narration/}`.
2. `assemble.sh <product>` — pads/concats narration into one track aligned to
   the video, optionally ducks a music bed under it (see `assets/README.md`),
   burns `subs.srt` into the picture, encodes h264/aac, writes the final mp4 to
   `~/Desktop/bandit-demos/`, and fails unless ffprobe reports > 15s.

## Tuning

- `SAY_VOICE=Samantha npm run vidrec` — pick a narration voice (`say -v '?'`).
- Step pacing knobs at the top of `record.mjs` (`MIN_STEP_S`, `NARR_PAD_S`).
- Subtitle style in `lib/subs.mjs` (the `.ass` style header; rerun
  `node lib/subs.mjs out/<product>` to restyle without re-recording).
- Music bed: drop `assets/music.mp3` (suggestions in `assets/README.md`).

## Outputs are never committed

`out/` and `assets/*` (except the README) are gitignored; finished videos go
to `~/Desktop/bandit-demos/` only.
