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

| Alias | Model | Workflow version | Input |
|---|---|---|---|
| `video-fast` | Wan2.2-TI2V-5B fp16, 24 fps native | `wan22-ti2v-5b-v1` | prompt, optional start image |
| `video-quality` | Wan2.2-I2V-A14B fp8 (high + low noise experts), 16 fps native | `wan22-i2v-a14b-v1` | start image (+ optional end image for first/last-frame) |

Request fields: `prompt`, `model`, `aspect` (`16:9`, `9:16`, `1:1`), `resolution`
(`480p`, `720p`, `1080p`), `durationSeconds` (clamped to 2-10 s; over ~5 s a
second pass continues from the first pass's last frame), `fps` (24 or 30),
`camera` (motion hint mapped to prompt text), `preserveText` (explicit
logo/lettering guidance; defaults on with a start image), `accelerated`
(`video-quality` only: Lightning 4-step LoRAs vs the full 20-step schedule),
`upscaler` (`esrgan` or `lanczos` for 1080p), `variants` (1-4 takes with
different seeds, run back to back while the GPU is held), `seed`,
`referenceId`, `endReferenceId`.

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
