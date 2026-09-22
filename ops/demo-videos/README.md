# Demo videos

Playwright-recorded product walkthroughs with Bandit TTS narration, a ducked
music bed, and burned-in subtitles. Output goes to `~/Desktop/bandit-demos/`
for review only — nothing here publishes anything anywhere.

## Run

```bash
cd ops/demo-videos
pnpm install
pnpm demo artifacts-dashboard
```

Final cut: `~/Desktop/bandit-demos/<scene>-<YYYY-MM-DD>.mp4` (override the
folder with `DEMO_DEST_DIR`). First run downloads the Playwright chromium
build automatically.

This directory is a standalone pnpm project (`.npmrc` has
`ignore-workspace=true`) — it is not part of the monorepo workspace or the
turbo graph.

## Pipeline

`pnpm demo <scene>` runs three stages, also available individually:

| Stage | Command | Output (in `out/<scene>/`) |
| --- | --- | --- |
| Narrate | `pnpm narrate <scene>` | `audio/line-NN.mp3` + `audio/durations.json` |
| Record | `pnpm record <scene>` | `video.webm`, `steps.json`, `subtitles.srt`, `narration.txt` |
| Assemble | `pnpm assemble <scene>` | the final mp4 on the Desktop |

Recording is paced by the narration: each step stays on screen at least as
long as its audio line, and assembly lays each line down at its step's
recorded timestamp, so voice, subtitles, and screen always agree.

## TTS

Narration is **Kokoro 82M, running locally on CPU** — default voice
`af_sarah`. Apache-2.0 weights and Apache-2.0 runtime (sherpa-onnx), no GPU,
no network, and **no cost per line**, which matters because a scene gets
re-cut a dozen times while its timing is tuned. A 9-line scene narrates in
about 18 seconds.

```bash
pnpm fetch-voice      # ~326 MB, once; skipped if voice-lab already has it
pnpm narrate <scene>
```

Pick a voice per scene (`voice: 'af_sarah'`) or per run (`KOKORO_VOICE`).
The bundle ships 54 voices, 28 of them English; names are read from the
model's own metadata, so swapping `KOKORO_BUNDLE` changes the gallery
without a code edit. An unknown name fails with the list of what is
available rather than silently narrating in someone else's voice.

Two other engines remain, chosen with `DEMO_TTS_ENGINE=kokoro|bandit|say`:

- **`bandit`** — Bandit cloud TTS, the endpoint the Stealth extension uses
  (`POST {apiUrl}/api/stealth/tts` with `{ Text, ModelName }`, see
  `apps/bandit-stealth/src/voiceProviders.ts`), authenticated with the `bai_`
  key from `~/.bandit/config.json`. Voices `en_US-brian-premium` and
  `en_US-jessica-premium`. Costs quota per line.
- **`say`** — macOS `say`, the last resort so a cut still exists with no
  model and no key. A `macos-say` cut is a draft.

Whichever ran is recorded per line in `audio/durations.json`. Setting
`DEMO_TTS_ENGINE` explicitly is honoured even when that engine cannot run, so
a misconfigured container fails loudly instead of quietly narrating in the
wrong voice.

## Music bed

`assemble.sh` mixes `assets/music-bed.mp3` (gitignored) under the voice —
looped, held low, sidechain-ducked while narration plays. Missing file =
clean voice-only mix.

`pnpm fetch-music` downloads a free Mixkit track (the raw asset URLs need a
browser user-agent; the script handles it). Good picks if you fetch
manually from <https://mixkit.co/free-stock-music/>: "Tech House Vibes"
(id 130 — current default), "Hazy After Hours" (id 132), "Serene View"
(id 443). Save as `assets/music-bed.mp3`.

ffmpeg note: assembly needs the `subtitles` (libass) filter and probes for
it — some system builds (including slim Homebrew ones) ship without it, in
which case the bundled `ffmpeg-static` devDependency is used instead.

## Adding a scene

Drop `scenes/<name>.ts` default-exporting a `Scene` (see `src/types.ts`):
steps are `{ title, narration, subtitle?, action }` — `narration` is what
TTS speaks, `subtitle` overrides the burned-in text when they should differ
(e.g. speak "docs dot burtson dot A I", display `docs.burtson.ai`).
Keep lines short and punchy (one sentence ≈ 4–6s of audio), keep claims to
shipped features, and make actions defensive (`visit`/`glideDown`/`tryClick`
from `src/actions.ts` never fail a take). Then `pnpm demo <name>`.

## Authenticated scenes

Some scenes (e.g. `web-ide`) can record signed-in surfaces. Auth comes only
from a Playwright storage-state file — scenes never see, store, or prompt
for credentials.

One-time capture (sign in by hand in the opened browser, then close it):

```bash
npx playwright codegen https://stealth.banditailabs.com --save-storage=auth.json
```

Then: `STORAGE_STATE=./auth.json pnpm demo web-ide`. `auth.json` is
gitignored — never commit it. Without `STORAGE_STATE`, auth-aware scenes
degrade to their public variant and say so in the run output.

## What's stubbed / future work

- **Signed-in web-IDE walkthrough** — the `web-ide` scene's authenticated
  steps are best-effort (the web app lives in its own repo); expect to tune
  selectors/paths after the first `STORAGE_STATE` run. Recorded so far:
  the public variant.
- **CLI terminal capture** — harness scaffold at
  `ops/demo-videos/harness/cli-xterm/` (xterm.js page + static server).
  Run `node --import tsx harness/cli-xterm/serve.ts` then point Playwright
  at `http://127.0.0.1:4177/`. Next: node-pty bridge so a live `bandit`
  session drives the terminal (same pipeline as other scenes). Until then
  the page shows a fixture permission card for selector work.
- **Other authed surfaces** (artifacts dashboard internals, account pages)
  wait on the storage-state flow above.

## Ground rules

- `~/Desktop/bandit-demos/` is review output — never committed, never
  published, never uploaded.
- `out/`, `assets/music-bed.mp3`, and `auth.json` are gitignored.
- Narration claims stick to shipped features.
