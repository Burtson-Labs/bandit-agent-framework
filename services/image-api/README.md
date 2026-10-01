# Burtson image API

Private, asynchronous adapter in front of ComfyUI. It accepts a stable image
generation contract, owns a small in-process queue, submits a versioned workflow,
and writes images plus provenance metadata to MinIO.

The service has no public ingress and no Kubernetes credentials. Anton authenticates
callers, claims the single GPU, and proxies `/image/generations` and job requests.
ComfyUI is also ClusterIP-only.

The initial production model is FLUX.1 Schnell because its Apache-2.0 license is
commercially permissive and its four-step workflow is a good fit for an on-demand
single RTX 5090. Model files are mounted, not baked into either image.

## Video (Wan 2.2)

`POST /api/videos/generations` queues a video job on the same in-process queue,
GPU claim, job/asset endpoints and TTL as images (Anton proxies it as
`POST /image/videos`; poll `GET /image/jobs/{id}`). Server-owned workflows live
in `app/video_workflows.py`:

One request shape covers every input combination; the inputs present pick the
pipeline. `video-quality` is the default: on the 5090 an A14B clip with the
Lightning 4-step LoRAs measured faster than the 5B model at 30 steps (5 s at
720p: 5B 246 s; A14B 1080p about 190 s per take including upscaling), so the 5B
model now runs 20 steps and is the lighter-VRAM draft option.

| Inputs | `video-fast` | `video-quality` |
|---|---|---|
| text | Wan2.2-TI2V-5B (`wan22-ti2v-5b-v1`) | Wan2.2-T2V-A14B (`wan22-t2v-a14b-v1`) |
| text + image (`referenceId`) | TI2V-5B image-to-video | Wan2.2-I2V-A14B (`wan22-i2v-a14b-v1`); + `endReferenceId` = first/last frame |
| text [+ image] + video (`sourceVideoId`) | 400 | Wan2.2-VACE-Fun-A14B (`wan22-vace-fun-a14b-v1`) with `mode` |

Video modes: `restyle` (keep the source's motion via a `control` video —
`edges` = core Canny, `depth` = Depth Anything 3 Mono-Large, `pose` = SDPose
wholebody — and take the look from the prompt and optional image), `motion`
(animate the reference image with the source's motion; pose by default;
requires `referenceId`), `extend` (continue the source from its last 17 frames,
up to 4 s; output is the whole source plus the new footage). `controlStrength`
0.1-2.0 (video jobs default to the full 20-step schedule: with the 4-step
Lightning LoRAs VACE ignored the restyle prompt and the reference identity in
testing); `sourceStartSeconds` picks the <= 5 s window for restyle/motion.

Source videos go to `POST /api/videos/sources` as the raw request body
(Anton: `POST /image/sources`, 200 MiB). They are identified by ffprobe, not by
extension; still images and undecodable files get 400. The stored copy is the
first 10 s at 16 fps, long side <= 1280, H.264, no audio; both the original and
normalised SHA-256 are recorded and the latter is copied into every job's
provenance.

Request fields: `prompt`, `model`, `aspect` (`16:9`, `9:16`, `1:1`), `resolution`
(`480p`, `720p`, `1080p`), `durationSeconds` (clamped to 2-10 s; over ~5 s a
second pass continues from the first pass's last frame), `fps` (24 or 30),
`camera` (motion hint mapped to prompt text), `preserveText` (explicit
logo/lettering guidance; defaults on with a start image), `accelerated`
(`video-quality` only: Lightning 4-step LoRAs vs the full 20-step schedule),
`upscaler` (`esrgan` or `lanczos` for 1080p), `variants` (1-4 takes with
different seeds, run back to back while the GPU is held), `seed`,
`referenceId`, `endReferenceId`, `sourceVideoId`, `mode`, `control`,
`controlStrength`, `sourceStartSeconds`. Impossible combinations (for example
`mode: motion` without an image, or a source video on `video-fast`) return 400
at submit time.

1080p renders natively at 720p, then Real-ESRGAN x2 and an exact lanczos resize.
Frame rates above native use RIFE v4.26 interpolation (16 -> 48 -> 24 fps,
16 -> 32 -> 30 fps, 24 -> 48 -> 30 fps). ComfyUI writes a CRF 12 H.264
intermediate; the API does the delivery encode with ffmpeg (H.264 High,
yuv420p, `+faststart`, exact fps) and a JPEG poster frame, then stores both in
MinIO with a `metadata.json` provenance record (workflow version, seeds, plan,
per-file model SHA-256, output SHA-256).

`GET /health/ready` reports `active` while a job runs or is queued; Anton's
idle reaper keeps the GPU claimed in that state so a long video is never cut off
because its caller stopped polling.

## Audio (music, uploads, Finish video)

Videos come out finished with sound: music, narration and the take's own audio,
mixed on the CPU. Models and licences are in
`/mnt/ai-models/comfyui/manifests/MODELS-audio.md`.

- **Music**: ACE-Step 1.5 turbo (MIT; text embedding Qwen3-Embedding-0.6B,
  Apache-2.0) on ComfyUI's native ACE-Step 1.5 nodes at the pinned commit
  (`app/audio_workflows.py`, workflow `ace15-turbo-v1`, model alias
  `music-ace15`). `POST /api/audio/generations` (Anton: `POST /image/audio`,
  auto-claims the GPU) queues a job (`kind: "audio"`) on the shared GPU queue:
  `prompt`, `genre`, `mood`, `bpm` (40-220), `keyscale` ("C major"),
  `timeSignature`, `durationSeconds` (3-240), `instrumental` or `lyrics`
  (section tags like `[Verse]`), `language`, `loopable` (renders 4 s extra and
  crossfades the tail into the head), `seed`, `variants` (1-4), `title`,
  `collection` (watch collection name). Each take is mastered on the CPU to a
  48 kHz 16-bit stereo WAV at -16 LUFS / -1.5 dBTP (two-pass loudnorm), a LAME
  V0 MP3 and a waveform JPEG; assets per take are WAV, MP3, waveform.
  `POST /api/audio/estimate` works like the video estimate (own calibration,
  `v1/stats/audio-timings.json`).
- **Sound effects** are not available: no candidate passed the licence bar
  (MMAudio CC-BY-NC; ThinkSound research-only with a Stability community VAE;
  HunyuanVideo-Foley Tencent community licence; Stable Audio 3 SFX Stability
  community licence). `kind: "sfx"` and a finish `sfx` field are refused with
  the reason; `GET /api/audio/capabilities` reports it.
- **Narration** comes from the gateway (`POST /api/stealth/tts`, local Heart
  and friends or Kokoro), called by the client with its own token; the audio is
  uploaded with `POST /api/audio/sources` (raw body, 60 MiB, probed, stored as
  48 kHz WAV with the upload TTL; Anton: `POST /image/audio/sources`).
  `POST /api/audio/library` keeps an upload in History (`mode: "narration"` or
  `"upload"`).
- **Finish video**: `POST /api/finish` (Anton: `POST /image/finish`, auto-claims
  only when `music.prompt` asks for a generated bed) queues a CPU job on its own
  queue (one at a time, never holds the GPU): a History video take plus any of
  a music bed (History audio item, upload, or a prompt generated to fit),
  narration lines (`audioId`, `text`, `voice`, `startSeconds` or sequential),
  the take's own audio (`originalAudio`), `levels`
  (`voice-forward` bed -24 dB / `balanced` -20 / `music-forward` -15),
  `captions` (narration text burned in, timed by line length), fades, `fit`
  (`audio` holds the last frame until the narration ends), and logo bookends
  (a real logo uploaded with `kind=logo`, centred on a solid card). The mix
  (`app/mix.py`) is the walkthrough recipe: each line gained to speech at -16
  LUFS, the bed set from its measured loudness under the voice, looped with
  crossfades, faded, ducked by a sidechain compressor keyed on the voice, and a
  -1.5 dBTP limiter over the sum. The video stream is copied unless captions,
  bookends, fades or a held frame need a re-encode. The result is a History
  video item with `mode: "finished"` (`outputs[0].mix` has the levels and the
  measured loudness; narration, music and logo inputs are kept as
  `input-*.wav/png`), imported to watch like any take. `POST /api/finish/estimate`
  estimates it; `/health/ready` reports `finishJobs`.
- History lists audio items (`kind=audio`); every audio take is imported to watch
  as `studio:{jobId}:audio{n}` (the WAV; watch makes the playback file and
  waveform).

## Estimates, queue and GPU handling

- `POST /api/videos/estimate` (Anton: `POST /image/videos/estimate`) takes the
  form's current settings (`hasImage`/`hasVideo` instead of upload ids) and
  returns `seconds` (GPU-ready basis), `claimSeconds` to add when the GPU is not
  claimed, the per-take/load breakdown, and `{valid: false, error}` for
  combinations that cannot run (e.g. Draft with a source video, Draft at 1080p).
- Rates come from `app/estimates.py`: seconds per generated second per take,
  keyed `pipeline|model|resolution|schedule`, seeded with the 5090 smoke-test
  measurements. Every finished take records its real rate (model load measured
  separately, up to the first sampler step); the median of the last 15 samples
  per key is used, padded toward the seed until 3 samples exist. Samples persist
  in MinIO at `v1/stats/video-timings.json` (outside the TTL'd tenant prefix).
- `GET /api/videos/queue?jobId=` (Anton: `GET /image/queue`): depth, total wait,
  and the caller's position and ETA. Each submitted job also stores the
  estimate it was given (`request.estimate`).
- Jobs wait (stage `waiting_for_gpu`, up to `WORKER_WAIT_SECONDS`, default 600)
  for the worker, so Anton can claim the GPU on submit instead of the client.
- `/health/ready` reports `activeJobs`; `POST /api/jobs/cancel-all` backs
  Anton's forced release.

## History library (Burtson Studio)

Working files under `v1/tenant/` still expire after `ASSET_TTL_HOURS` (bucket
lifecycle plus the app reaper). Finished jobs are kept separately, per user, in
`v1/library/{owner}/` — outside both expiry rules:

- When a job reaches `completed`, `failed` or `cancelled` it is recorded:
  outputs, posters and inputs (start/end image, source video, mask) are copied
  server-side to `v1/library/{owner}/items/{jobId}/`, a 640 px JPEG `thumb-NN.jpg`
  is made per take, `metadata.json` is copied, and the entry is written to
  `items/{jobId}/item.json`. Failed/cancelled jobs get only an item.json.
- One object per item: `item.json` holds the entry plus the user's state
  (`favorite`/`hidden` per item and per take, `projectId`); projects are in
  `v1/library/{owner}/projects.json`. A change writes one small object. Reads
  come from an in-memory index built on first use (parallel GETs of every
  item.json) and are filtered and paged server-side. A phase-1 single
  `index.json` is split into item.json files on first load.
- A backfill scans `v1/tenant/**/metadata.json` at startup and before every
  reaper sweep and records any job not in the library yet. The sweep skips
  jobs whose copy failed and uploads that queued/running jobs still use, so
  nothing is reaped before it is persisted. The bucket lifecycle rule runs one
  day behind the app TTL as a backstop only.
- Hiding is a soft delete. The only library file the service ever deletes is a
  take's MP4, and only after watch has confirmed its copy (see below).
- `GET /api/images/jobs/{id}/assets/{index}` falls back to the library once the
  in-memory job is gone, so result links keep working after a restart.
- Reference records are persisted beside the upload
  (`v1/tenant/{owner}/reference-records/{id}.json`, same TTL), so an upload
  still works for a job submitted after a restart.
- On startup image-api clears ComfyUI's queue and interrupts the running
  prompt if any: a fresh process owns none of them.

| Route (image-api) | Anton | Purpose |
|---|---|---|
| `GET /api/library` | `GET /image/library` | one page, newest first: `q`, `kind`, `model`, `status` (`completed`/`failed`), `since`, `view` (`all`/`favorites`/`unassigned`/`project:<id>`), `includeHidden`, `limit` (≤ 200), `cursor`; returns `items`, `nextCursor`, `total`, `counts`, `models`, `projects` |
| `POST /api/library/sync` | `POST /image/library/sync` | record the caller's unrecorded jobs now |
| `GET /api/library/items/{id}` | `GET /image/library/items/{id}` | one item |
| `PATCH /api/library/items/{id}` | `PATCH /image/library/items/{id}` | `favorite`, `hidden`, `projectId` (null clears), `outputs: [{index, favorite?, hidden?}]` |
| `GET /api/library/items/{id}/files/{name}` | `GET /image/library/items/{id}/files/{name}` | `video-NN.mp4`, `poster-NN.jpg`, `image-NN.png`, `thumb-NN.jpg`, `input-*.png/mp4`, `metadata.json` |
| `POST /api/library/projects` | `POST /image/library/projects` | create `{name}` |
| `PATCH /api/library/projects/{id}` | `PATCH /image/library/projects/{id}` | rename `{name}` |
| `DELETE /api/library/projects/{id}` | `DELETE /image/library/projects/{id}` | delete; its items stay, unassigned |

Every route is scoped by `X-Burtson-Owner`, which Anton sets from the JWT.

## watch (every take in watch.burtson.ai)

Every finished take is imported into watch, Mark's R2-backed library, where he
renames, deletes, organises and shares them (`app/watch_sync.py`). History video
takes and images go to watch's "Burtson Video Studio" collection; production
takes to one collection per production (`studio:production:{id}`), titled
`E01 S02 Shot 03 · {shot} · take 1`. Tags: `studio:{jobId}:take{n}`,
`studio:{jobId}:image{n}`, `studio:{takeId}:take{n}` (idempotent imports).

- A pass runs every `WATCH_SYNC_SECONDS` (60) and right after a job is
  recorded. It looks up pending takes first (so nothing already in watch is
  uploaded again), imports the rest through
  `POST http://watch.watch.svc.cluster.local/api/internal/studio/imports`
  (header `X-Watch-Service-Key` from the `watch-studio-import` secret), backs off
  1/5/15/30/60 min on errors, and refreshes imported takes: the current title
  in watch, or `deleted` when Mark deleted it there. Deleted takes are never
  imported again. Hidden History takes wait until un-hidden.
- State is on the take: `outputs[n].watch` in History (`state` present /
  deleted / pending / refused, `videoId`, `url`, `title`, `collectionName`,
  `importedAt`), `watch` on a Productions take.
- `WATCH_DROP_LOCAL_MP4_DAYS` (default 7; 0 keeps them): days after the watch
  copy is confirmed before the History MP4 is deleted from MinIO. Thumbnails,
  posters, inputs and metadata stay (Remix needs them). A dropped take's file
  route serves the watch copy (presigned R2 URL, fetched by image-api), so
  History playback and download keep working.
- `GET /api/watch/sync` (cluster-internal, not proxied): the last pass's counters.
- Without `WATCH_SERVICE_KEY` the sync is off and nothing else changes.

## Productions (overnight shots)

Admin-only planning and overnight rendering for Burtson Video Studio: a
production (series or film) holds episodes, scenes and shots; each shot is one
2-5 s Wan 2.2 pass rendered as N takes. Design: `Burtson-Studio-Productions-Design.md`
(phase 1).

- **State** lives in Mongo (`MONGO_URI`, database `MONGO_DB`, default
  `burtson_studio`, own least-privilege user): `productions, episodes, scenes,
  shots, takes, jobs, settings, nights, gpu_events`. Without `MONGO_URI` the
  routes answer 503 and nothing else changes.
- **Durable queue** (`app/productions/store.py`): a job per take with the id
  `tk_` + sha256(shot|revision|take)[:24], so queueing a shot revision twice is a
  no-op and the take keeps the job's id. Editing a shot's prompt, camera,
  duration, model, resolution, schedule or frames bumps its revision and
  cancels its queued takes of older revisions. Leases are atomic
  (`findOneAndUpdate`); retries follow the design's error classes: transient
  (back off 1/5/15/30 min, 5 attempts), lost (image-api restarted; requeued at
  once, the first two do not count), oom and timeout (one retry), invalid
  (dead at once), released (a forced GPU release; requeued, not counted).
- **Dispatcher** (`app/productions/dispatcher.py`, every 10 s): feeds this
  process's in-memory queue **one take at a time**, only while the night window
  (default 22:00-07:00 America/Chicago, every night) or a manual session is
  open, nothing interactive is queued or running, the queue is not paused, the
  GPU is healthy and the worker answers. It never starts a take whose estimate
  would end after the window end plus grace (10 min), and stops at the night's
  GPU budget (480 min). After a restart, in-flight takes are found missing and
  requeued (`lost`); ComfyUI's orphaned prompts are cleared at startup.
- **Outputs** go to `v1/productions/{owner}/{productionId}/takes/{takeId}/`
  without expiry tags (outside `v1/tenant/`, so neither the reaper nor the
  bucket lifecycle touches them) and are never recorded in History. Shot
  frames are stored under `.../shots/{shotId}/keyframe-{start|end}-{sha}.png`;
  each attempt gets fresh reference records for them.
- **Anton** asks `GET /api/productions/gpu-intent` once a minute (reporting GPU
  health in the query) and gets `{wantGpu, releaseWhenDone, reason, until,
  healthy}`. `wantGpu` is false with nothing queued, so an empty queue never
  claims the GPU. A GPU fault (`fault=`) pauses the queue until resumed.
- `POST /api/videos/generations` accepts `Idempotency-Key`: a resubmit with
  the same key returns the existing job.

| Route (image-api; Anton: `/image/productions/*`, admin only) | Purpose |
|---|---|
| `GET /api/productions/status` | window, intent, health, tonight's queue and fit, take in flight, last night |
| `GET/PUT /api/productions/settings` | `windowStart`, `windowEnd`, `days` (0 = Monday), `timezone`, `budgetMinutes`, `graceMinutes`, `defaultTakes` |
| `POST /api/productions/pause` / `resume`, `POST/DELETE /api/productions/session` | pause dispatch; manual "run now" for N minutes |
| `GET /api/productions/gpu-intent` | Anton's once-a-minute question |
| `GET/POST /api/productions`, `GET/PATCH/DELETE /api/productions/{id}` | list, create, board (episodes, scenes, shots with takes and jobs, ETA), edit, delete |
| `POST/PATCH/DELETE .../{id}/episodes[/{eid}]`, `POST .../episodes/{eid}/queue` | episodes; queue every unapproved shot |
| `POST/PATCH/DELETE .../{id}/scenes[/{sid}]` | scenes |
| `POST .../{id}/shots`, `POST .../{id}/shots/bulk`, `PATCH/DELETE .../shots/{shotId}` | shots |
| `POST/DELETE .../shots/{shotId}/keyframe` (`role` start/end), `GET .../shots/{shotId}/files/{name}` | start and end frames |
| `POST .../shots/{shotId}/queue`, `/cancel`, `/regenerate`, `/unchoose`, `.../takes/{takeId}/choose`, `/reject` | queue takes, review |
| `POST .../{id}/jobs/{jobId}/retry`, `GET .../{id}/takes/{takeId}/files/{name}` | retry a dead take; take video, poster, metadata |
