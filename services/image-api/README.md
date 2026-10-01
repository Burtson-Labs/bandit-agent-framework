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
- Hiding is a soft delete; the service never deletes library files.
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
