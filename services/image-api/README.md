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
0.1-2.0; `sourceStartSeconds` picks the <= 5 s window for restyle/motion.

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
