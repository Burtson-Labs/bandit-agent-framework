from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import logging
import math
import os
import random
import shutil
import subprocess
import tempfile
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Iterable, Literal
from urllib.parse import urlencode

import boto3
import httpx
from botocore.client import Config
from fastapi import FastAPI, File, Form, Header, HTTPException, Query, Request, Response, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, Field, field_validator

from . import audio_workflows as aw
from . import estimates as est
from . import library as lib
from . import mix
from . import video_workflows as vw
from . import watch_sync as ws
from .productions import dispatcher as prod_dispatcher
from .productions import routes as prod_routes
from .productions import store as prod_store
from .workflows import fit_canvas, flux_workflow, validate_dimension

COMFY_URL = os.getenv("COMFYUI_BASE_URL", "http://image-worker:8188").rstrip("/")
BUCKET = os.getenv("MINIO_BUCKET", "generated-images")
WORKFLOW_VERSION = "flux-schnell-v1"
MODEL_DIGEST = os.getenv("FLUX_MODEL_SHA256", "unverified")
MODEL_LICENSE = "Apache-2.0"
ASSET_TTL_HOURS = max(1, min(int(os.getenv("ASSET_TTL_HOURS", "24")), 168))
ASSET_TTL = timedelta(hours=ASSET_TTL_HOURS)
REAPER_INTERVAL_SECONDS = max(60, int(os.getenv("REAPER_INTERVAL_SECONDS", "900")))
MAX_UPLOAD_BYTES = max(1, int(os.getenv("MAX_UPLOAD_MIB", "12"))) * 1024 * 1024
MAX_IMAGE_PIXELS = max(1_000_000, int(os.getenv("MAX_IMAGE_PIXELS", "25000000")))
# Ceiling per video variant, including model load. A 10 s 1080p quality clip
# with the full 20-step schedule is the slowest legal request.
VIDEO_VARIANT_TIMEOUT_SECONDS = max(300, int(os.getenv("VIDEO_VARIANT_TIMEOUT_SECONDS", "3600")))
VIDEO_CRF = os.getenv("VIDEO_CRF", "17")
# How long a queued job waits for the GPU worker (Anton claims on submit).
WORKER_WAIT_SECONDS = max(60, int(os.getenv("WORKER_WAIT_SECONDS", "600")))
MAX_SOURCE_BYTES = max(1, int(os.getenv("MAX_SOURCE_MIB", "200"))) * 1024 * 1024
# Audio uploads (narration takes from the gateway, your own music) and finishing.
MAX_AUDIO_UPLOAD_BYTES = max(1, int(os.getenv("MAX_AUDIO_UPLOAD_MIB", "60"))) * 1024 * 1024
MAX_AUDIO_UPLOAD_SECONDS = 15 * 60
MAX_NARRATION_LINES = 20
FINISH_TIMEOUT_SECONDS = max(300, int(os.getenv("FINISH_TIMEOUT_SECONDS", "1800")))
logger = logging.getLogger("burtson.image_api")
# Random seeds stay below 2^53 (less room for per-take/segment offsets) so a
# browser can hold them exactly; responses also carry `seedText`.
JS_SAFE_SEED = 2**53 - 100_000
# Productions state (Mongo). Unset: the Productions routes answer 503.
MONGO_URI = os.getenv("MONGO_URI", "")
MONGO_DB = os.getenv("MONGO_DB", "burtson_studio")
PRODUCTIONS_PREFIX = "v1/productions"
# Every finished take is imported into watch (see app/watch_sync.py). Off without a key.
WATCH_URL = os.getenv("WATCH_URL", "http://watch.watch.svc.cluster.local")
WATCH_SERVICE_KEY = os.getenv("WATCH_SERVICE_KEY", "")
WATCH_SYNC_SECONDS = max(15, int(os.getenv("WATCH_SYNC_SECONDS", "60")))
# Days to keep a History MP4 in MinIO after watch confirmed its copy; 0 keeps it.
WATCH_DROP_LOCAL_MP4_DAYS = max(0.0, float(os.getenv("WATCH_DROP_LOCAL_MP4_DAYS", "7")))


class GenerationRequest(BaseModel):
    prompt: str = Field(min_length=3, max_length=4000)
    # Omitted dimensions default to 1024x1024 for generation; for edits they
    # follow the reference image's aspect ratio (see fit_canvas) — stretching a
    # non-square reference onto a mismatched canvas is what mangles logos.
    width: int | None = None
    height: int | None = None
    model: Literal["flux-schnell"] = "flux-schnell"
    steps: int = Field(default=4, ge=1, le=12)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    referenceId: str | None = Field(default=None, min_length=8, max_length=64)
    maskId: str | None = Field(default=None, min_length=8, max_length=64)
    strength: float = Field(default=0.72, ge=0.05, le=1.0)

    @field_validator("width", "height")
    @classmethod
    def valid_dimension(cls, value: int | None) -> int | None:
        return None if value is None else validate_dimension(value)


class VideoRequest(BaseModel):
    """One request shape for every input combination.

    text only -> text-to-video; + referenceId -> image-to-video;
    + sourceVideoId -> video-conditioned (VACE) with `mode`.
    """
    prompt: str = Field(min_length=3, max_length=4000)
    # video-fast = Wan2.2-TI2V-5B (text or image to video);
    # video-quality = Wan2.2 A14B: T2V (text), I2V (image), VACE-Fun (video).
    # Default is the A14B family: with Lightning it measured faster per clip
    # than the 5B model at 30 steps, and holds lettering better.
    model: Literal["video-fast", "video-quality"] = "video-quality"
    aspect: Literal["16:9", "9:16", "1:1"] = "16:9"
    resolution: Literal["480p", "720p", "1080p"] = "720p"
    # Clamped to what the workflow supports (2-10 s; >5 s chains two passes).
    durationSeconds: float = Field(default=5.0, gt=0, le=60)
    fps: Literal[24, 30] = 24
    camera: vw.CameraMotion = "auto"
    # Adds explicit "keep logos/lettering unchanged" guidance. Defaults on when
    # a start image is supplied.
    preserveText: bool | None = None
    # video-quality only: Lightning 4-step LoRAs (fast) vs the full 20-step schedule.
    # Lightning 4-step LoRAs vs the full 20-step schedule. Default: on for
    # text/image-to-video; off for video-conditioned (VACE) jobs, where the
    # 4-step pass ignored the restyle prompt and the reference identity in
    # testing while the full schedule followed both.
    accelerated: bool | None = None
    upscaler: Literal["esrgan", "lanczos"] = "esrgan"
    variants: int = Field(default=1, ge=1, le=4)
    seed: int | None = Field(default=None, ge=0, le=2**62)
    referenceId: str | None = Field(default=None, min_length=8, max_length=64)
    endReferenceId: str | None = Field(default=None, min_length=8, max_length=64)
    # Video-conditioned generation (video-quality only).
    sourceVideoId: str | None = Field(default=None, min_length=8, max_length=64)
    mode: vw.VideoMode | None = None
    control: vw.Control | None = None
    controlStrength: float = Field(default=1.0, ge=0.1, le=2.0)
    # restyle/motion use a <=5 s window of the source starting here.
    sourceStartSeconds: float = Field(default=0.0, ge=0.0, le=vw.MAX_SOURCE_SECONDS)


@dataclass
class Job:
    id: str
    owner: str
    request: dict
    status: str = "queued"
    createdAt: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    updatedAt: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    images: list[dict] = field(default_factory=list)
    error: str | None = None
    comfyPromptId: str | None = None
    cancelRequested: bool = False
    expiresAt: str = field(default_factory=lambda: (datetime.now(UTC) + ASSET_TTL).isoformat())
    kind: str = "image"
    videos: list[dict] = field(default_factory=list)
    progress: dict | None = None
    # Private MinIO keys addressed by /assets/{index}; never serialized.
    assetKeys: list[str] = field(default_factory=list)
    startedAt: str | None = None
    # time.monotonic() of the current take's first sampler step (not serialized).
    samplingStartedAt: float | None = None
    audios: list[dict] = field(default_factory=list)
    # History file name -> working key of inputs a finish job keeps (narration, music, logo).
    inputFiles: dict[str, str] = field(default_factory=dict)


@dataclass
class Reference:
    id: str
    owner: str
    key: str
    kind: str
    filename: str
    contentType: str
    width: int
    height: int
    bytes: int
    createdAt: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    expiresAt: str = field(default_factory=lambda: (datetime.now(UTC) + ASSET_TTL).isoformat())
    # Source videos only (kind == "video"): normalised to 16 fps, <=10 s.
    durationSeconds: float | None = None
    frames: int | None = None
    sha256: str | None = None
    originalSha256: str | None = None
    originalDurationSeconds: float | None = None


app = FastAPI(title="Burtson Image API", version="0.1.0")
app.include_router(prod_routes.router)
jobs: dict[str, Job] = {}
# Idempotency-Key -> job id: a resubmit with the same key returns the same job.
idempotency: dict[str, str] = {}
dispatcher: prod_dispatcher.Dispatcher | None = None
references: dict[str, Reference] = {}
queue: asyncio.Queue[str] = asyncio.Queue(maxsize=int(os.getenv("QUEUE_CAPACITY", "20")))
worker_task: asyncio.Task | None = None
active_job_id: str | None = None
reaper_task: asyncio.Task | None = None
calibration = est.Calibration()
audio_calibration = est.audio_calibration()
# Finishing runs on the CPU: its own queue, so a mix never waits behind (or holds) the GPU.
finish_queue: asyncio.Queue[str] = asyncio.Queue(maxsize=int(os.getenv("FINISH_QUEUE_CAPACITY", "20")))
finish_task: asyncio.Task | None = None
active_finish_id: str | None = None
library = lib.Library(lib.S3Store(lambda: s3_client(), BUCKET))
watch_sync: ws.WatchSync | None = None


def s3_client():
    client = boto3.client(
        "s3",
        endpoint_url=os.environ["MINIO_ENDPOINT"],
        aws_access_key_id=os.environ["MINIO_ACCESS_KEY"],
        aws_secret_access_key=os.environ["MINIO_SECRET_KEY"],
        # Current botocore prefers flexible CRC checksums, while the deployed
        # MinIO release requires Content-MD5 for bucket lifecycle requests.
        config=Config(signature_version="s3v4", request_checksum_calculation="when_required"),
        region_name=os.getenv("MINIO_REGION", "us-east-1"),
    )
    # The deployed MinIO also refuses DeleteObjects without Content-MD5, which
    # is what the reaper uses.
    for operation in ("PutBucketLifecycleConfiguration", "DeleteObjects"):
        client.meta.events.register_first(f"request-created.s3.{operation}", add_lifecycle_content_md5)
    return client


def add_lifecycle_content_md5(request, **_kwargs) -> None:
    body = request.body.encode() if isinstance(request.body, str) else request.body
    if body is not None:
        digest = hashlib.md5(body, usedforsecurity=False).digest()
        request.headers["Content-MD5"] = base64.b64encode(digest).decode()


@app.on_event("startup")
async def startup() -> None:
    global worker_task, reaper_task
    await asyncio.to_thread(ensure_bucket)
    await asyncio.to_thread(ensure_bucket_lifecycle)
    await asyncio.to_thread(est.load_from, read_stats, calibration)
    await asyncio.to_thread(est.load_from, lambda: read_stats(est.AUDIO_STATS_KEY), audio_calibration)
    await clear_orphaned_prompts()
    worker_task = asyncio.create_task(run_queue())
    global finish_task
    finish_task = asyncio.create_task(run_finish_queue())
    # The reaper backfills the history library before its first sweep.
    reaper_task = asyncio.create_task(run_reaper())
    start_productions()
    start_watch_sync()


def start_watch_sync() -> None:
    global watch_sync
    if not WATCH_SERVICE_KEY:
        logger.info("watch sync: WATCH_SERVICE_KEY not set; takes stay in MinIO only")
        return
    store = prod_routes.runtime.store if prod_routes.runtime is not None else None
    watch_sync = ws.WatchSync(
        library, ws.WatchClient(WATCH_URL, WATCH_SERVICE_KEY),
        productions_db=(lambda: store.db) if store is not None else None,
        read_production_object=lambda key: (production_object(key) or (None,))[0],
        drop_after_days=WATCH_DROP_LOCAL_MP4_DAYS, interval_seconds=WATCH_SYNC_SECONDS,
    )
    watch_sync.start()
    logger.info("watch sync: on (%s, drop local MP4s after %s days)", WATCH_URL, WATCH_DROP_LOCAL_MP4_DAYS)


async def clear_orphaned_prompts() -> None:
    """A fresh process owns no ComfyUI prompts: drop queued ones and stop the
    running one, which would otherwise hold the GPU for a job nobody tracks.
    Best effort; the worker is often scaled to zero."""
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            queued = (await client.get(f"{COMFY_URL}/queue")).json()
            if queued.get("queue_running") or queued.get("queue_pending"):
                await client.post(f"{COMFY_URL}/queue", json={"clear": True})
                await client.post(f"{COMFY_URL}/interrupt")
                logger.warning("cleared %d running and %d queued ComfyUI prompt(s) left by a previous process",
                               len(queued.get("queue_running") or []), len(queued.get("queue_pending") or []))
    except Exception:
        pass


@app.on_event("shutdown")
async def shutdown() -> None:
    if worker_task:
        worker_task.cancel()
    if finish_task:
        finish_task.cancel()
    if reaper_task:
        reaper_task.cancel()
    if dispatcher:
        dispatcher.stop()
    if watch_sync:
        watch_sync.stop()


@app.get("/health/live")
async def live() -> dict:
    return {"status": "ok"}


@app.get("/health/ready")
async def ready() -> dict:
    # Anton's idle reaper reads `active` so it never releases the GPU under a
    # long-running job whose caller stopped polling.
    pending = pending_job_count()
    # Finishing (CPU) is reported separately: it never needs the GPU, so it does not
    # keep Anton's claim alive, but a rollout should still wait for finishJobs 0.
    finishing = finish_job_count()
    return {"status": "ok", "queueDepth": queue.qsize(), "activeJob": active_job_id is not None,
            "active": pending > 0, "activeJobs": pending, "finishJobs": finishing}


def finish_job_count() -> int:
    waiting = [jobs.get(job_id) for job_id in list(finish_queue._queue)]
    return sum(1 for job in waiting if job and not job.cancelRequested) + (1 if active_finish_id else 0)


def pending_job_count() -> int:
    """Running plus queued jobs that are not already cancelled."""
    waiting = [jobs.get(job_id) for job_id in list(queue._queue)]
    count = sum(1 for job in waiting if job and not job.cancelRequested)
    return count + (1 if active_job_id is not None else 0)


def read_stats(key: str = est.STATS_KEY) -> bytes | None:
    try:
        obj = s3_client().get_object(Bucket=BUCKET, Key=key)
    except Exception as exc:
        if "NoSuchKey" in type(exc).__name__ or "NoSuchKey" in str(exc):
            return None
        raise
    return obj["Body"].read()


def write_stats(key: str = est.STATS_KEY, source: est.Calibration | None = None) -> None:
    try:
        body = (source or calibration).to_json()
        s3_client().put_object(Bucket=BUCKET, Key=key, Body=io.BytesIO(body), ContentType="application/json")
    except Exception as exc:
        logger.warning("could not persist video timing stats: %s", type(exc).__name__)


@app.get("/health/worker")
async def worker_health() -> dict:
    try:
        async with httpx.AsyncClient(timeout=2) as client:
            response = await client.get(f"{COMFY_URL}/system_stats")
            response.raise_for_status()
        return {"status": "ok", "worker": "ready", "queueDepth": queue.qsize()}
    except Exception as exc:
        raise HTTPException(503, f"image worker is not ready: {exc}") from exc


def ensure_bucket() -> None:
    # Provision the bucket and its lifecycle out of band. Runtime credentials
    # intentionally do not need cluster-wide create-bucket permission.
    s3_client().head_bucket(Bucket=BUCKET)


def ensure_bucket_lifecycle() -> None:
    """Install a coarse server-side expiry rule as defense in depth.

    S3 lifecycle expiration is day-granular, while the application reaper below
    enforces the exact hour TTL. A permission failure is non-fatal because some
    deployments deliberately give runtime credentials object-only access.
    """
    if os.getenv("CONFIGURE_BUCKET_LIFECYCLE", "true").lower() not in {"1", "true", "yes"}:
        return
    # One extra day over the app TTL: the reaper (which first copies finished
    # jobs into the history library) is the exact expiry; the lifecycle rule is
    # only a backstop and must not beat a backfill delayed by an outage.
    days = max(1, math.ceil(ASSET_TTL_HOURS / 24)) + 1
    try:
        s3_client().put_bucket_lifecycle_configuration(
            Bucket=BUCKET,
            LifecycleConfiguration={"Rules": [{
                "ID": "expire-burtson-image-assets",
                "Status": "Enabled",
                "Filter": {"Prefix": "v1/tenant/"},
                "Expiration": {"Days": days},
                "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1},
            }]},
        )
    except Exception as exc:
        logger.warning("could not configure bucket lifecycle; app reaper remains active: %s", exc)


@app.post("/api/images/references", status_code=201)
async def upload_reference(
    file: UploadFile = File(...),
    kind: Literal["reference", "mask", "logo"] = Form(default="reference"),
    x_burtson_owner: str = Header(default="unknown"),
) -> dict:
    body = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(body) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"image exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB upload limit")
    normalized, width, height = normalize_upload(body, kind)
    reference_id = uuid.uuid4().hex
    owner = x_burtson_owner[:200]
    created = datetime.now(UTC)
    key = (
        f"v1/tenant/{safe_owner(owner)}/{created:%Y/%m/%d}/"
        f"references/{reference_id}.png"
    )
    expires_at = created + ASSET_TTL
    await asyncio.to_thread(upload, key, normalized, "image/png", expires_at)
    reference = Reference(
        id=reference_id, owner=owner, key=key, kind=kind,
        filename=(file.filename or f"{kind}.png")[:200], contentType="image/png",
        width=width, height=height, bytes=len(normalized),
        createdAt=created.isoformat(), expiresAt=expires_at.isoformat(),
    )
    references[reference_id] = reference
    await asyncio.to_thread(save_reference, reference)
    return public_reference(reference)


def reference_record_key(owner: str, reference_id: str) -> str:
    return f"v1/tenant/{safe_owner(owner)}/reference-records/{reference_id}.json"


def save_reference(reference: Reference) -> None:
    """Persist the reference record next to its file so it survives a restart.

    Same prefix and TTL as the upload itself.
    """
    try:
        upload(reference_record_key(reference.owner, reference.id), json.dumps(asdict(reference)).encode(),
               "application/json", datetime.fromisoformat(reference.expiresAt))
    except Exception as exc:
        logger.warning("could not persist reference %s: %s", reference.id, type(exc).__name__)


def load_reference(reference_id: str, owner: str) -> Reference | None:
    if not all(ch.isalnum() for ch in reference_id):
        return None
    try:
        obj = s3_client().get_object(Bucket=BUCKET, Key=reference_record_key(owner, reference_id))
        reference = Reference(**json.loads(obj["Body"].read()))
    except Exception:
        return None
    references[reference.id] = reference
    return reference


@app.post("/api/videos/sources", status_code=201)
async def upload_source_video(request: Request, x_burtson_owner: str = Header(default="unknown")) -> dict:
    """Accept a source video as the raw request body (streamed to disk).

    Content is identified by probing, never by extension or Content-Type. The
    stored copy is normalised once: first 10 s, 16 fps (VACE's native rate),
    long side <= 1280, H.264 yuv420p, no audio. Jobs crop/scale it to their
    own aspect and resolution inside the workflow.
    """
    owner = x_burtson_owner[:200]
    with tempfile.TemporaryDirectory(prefix="burtson-source-") as work:
        original = os.path.join(work, "original")
        digest = hashlib.sha256()
        size = 0
        with open(original, "wb") as handle:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_SOURCE_BYTES:
                    raise HTTPException(413, f"video exceeds the {MAX_SOURCE_BYTES // (1024 * 1024)} MiB upload limit")
                digest.update(chunk)
                handle.write(chunk)
        if size == 0:
            raise HTTPException(400, "video upload is empty")
        normalized, info = await asyncio.to_thread(normalize_source_video, original, work)
    reference_id = uuid.uuid4().hex
    created = datetime.now(UTC)
    key = f"v1/tenant/{safe_owner(owner)}/{created:%Y/%m/%d}/references/{reference_id}.mp4"
    expires_at = created + ASSET_TTL
    await asyncio.to_thread(upload, key, normalized, "video/mp4", expires_at)
    reference = Reference(
        id=reference_id, owner=owner, key=key, kind="video",
        filename=(request.headers.get("x-filename") or "source.mp4")[:200], contentType="video/mp4",
        width=info["width"], height=info["height"], bytes=len(normalized),
        createdAt=created.isoformat(), expiresAt=expires_at.isoformat(),
        durationSeconds=info["duration"], frames=info["frames"],
        sha256=hashlib.sha256(normalized).hexdigest(), originalSha256=digest.hexdigest(),
        originalDurationSeconds=info["originalDuration"],
    )
    references[reference_id] = reference
    await asyncio.to_thread(save_reference, reference)
    return public_reference(reference)


def normalize_source_video(path: str, work: str) -> tuple[bytes, dict]:
    original = probe_source(path)
    if original is None:
        raise HTTPException(400, "unsupported or corrupt video: no decodable video stream")
    if original["duration"] < 0.5:
        raise HTTPException(400, "video must be at least half a second long")
    output = os.path.join(work, "normalized.mp4")
    long_side = "if(gt(iw,ih),min(1280,iw),-2)", "if(gt(iw,ih),-2,min(1280,ih))"
    try:
        run_ffmpeg([
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", path,
            "-t", str(vw.MAX_SOURCE_SECONDS), "-an", "-sn", "-dn", "-map_metadata", "-1",
            "-vf", f"fps={vw.SOURCE_FPS},scale=w='{long_side[0]}':h='{long_side[1]}':flags=lanczos,"
                   "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", output,
        ])
    except RuntimeError as exc:
        raise HTTPException(400, "the video could not be decoded") from exc
    info = probe_video(output)
    if not info.get("frames") or not info.get("width"):
        raise HTTPException(400, "the video could not be decoded")
    info["originalDuration"] = original["duration"]
    info["duration"] = info.get("duration") or round((info["frames"] - 1) / vw.SOURCE_FPS, 2)
    with open(output, "rb") as handle:
        return handle.read(), info


def probe_source(path: str) -> dict | None:
    """Return {duration} when ffprobe finds a real video stream, else None."""
    result = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=codec_type,codec_name,width,height:format=duration,format_name",
        "-of", "json", path,
    ], capture_output=True, text=True, timeout=60, check=False)
    if result.returncode != 0:
        return None
    data = json.loads(result.stdout or "{}")
    streams = [s for s in data.get("streams", []) if s.get("codec_type") == "video" and s.get("width")]
    fmt = data.get("format") or {}
    # Still images (png/jpeg "video" streams) are not source videos.
    if not streams or fmt.get("format_name", "") in {"image2", "png_pipe", "jpeg_pipe", "webp_pipe"}:
        return None
    try:
        duration = float(fmt.get("duration") or 0)
    except ValueError:
        duration = 0.0
    return {"duration": round(duration, 2)}


@app.post("/api/images/generations", status_code=202)
async def generate(request: GenerationRequest, x_burtson_owner: str = Header(default="unknown")) -> dict:
    if queue.full():
        raise HTTPException(429, "image queue is full")
    owner = x_burtson_owner[:200]
    if request.maskId and not request.referenceId:
        raise HTTPException(400, "maskId requires referenceId")
    width, height = request.width, request.height
    if request.referenceId:
        reference = owned_reference(request.referenceId, owner, expected_kind="reference")
        if width is None or height is None:
            width, height = fit_canvas(reference.width, reference.height)
    if request.maskId:
        owned_reference(request.maskId, owner, expected_kind="mask")
    job_id = uuid.uuid4().hex
    payload = request.model_dump()
    payload["width"] = width or 1024
    payload["height"] = height or 1024
    payload["seed"] = request.seed if request.seed is not None else random.randrange(0, JS_SAFE_SEED)
    job = Job(id=job_id, owner=owner, request=payload)
    jobs[job_id] = job
    await queue.put(job_id)
    return public_job(job)


@app.post("/api/videos/generations", status_code=202)
async def generate_video(request: VideoRequest, x_burtson_owner: str = Header(default="unknown"),
                         idempotency_key: str | None = Header(default=None, max_length=200)) -> dict:
    job = create_video_job(request, x_burtson_owner[:200], idempotency_key=idempotency_key)
    return public_job(job)


def create_video_job(request: VideoRequest, owner: str, *, idempotency_key: str | None = None,
                     origin: dict | None = None) -> Job:
    """Validate, estimate and enqueue a video job (HTTP route and Productions dispatcher).

    ``origin`` marks a production take: its outputs go to the non-expiring
    ``v1/productions/`` prefix and it stays out of the History library.
    Must run on the event loop thread (it puts on the asyncio queue).
    """
    if idempotency_key:
        existing = jobs.get(idempotency.get(idempotency_key, ""))
        if existing is not None and existing.owner == owner:
            return existing
    if queue.full():
        raise HTTPException(429, "generation queue is full")
    if request.referenceId:
        owned_reference(request.referenceId, owner, expected_kind="reference")
    if request.endReferenceId:
        owned_reference(request.endReferenceId, owner, expected_kind="reference")
    source = owned_reference(request.sourceVideoId, owner, expected_kind="video") if request.sourceVideoId else None
    payload = request.model_dump()
    payload["sourceFrames"] = source.frames if source else 0
    payload["sourceSha256"] = source.sha256 if source else None
    payload["sourceOriginalSha256"] = source.originalSha256 if source else None
    payload["seed"] = request.seed if request.seed is not None else random.randrange(0, JS_SAFE_SEED)
    if payload["accelerated"] is None:
        payload["accelerated"] = not request.sourceVideoId
    if payload["preserveText"] is None:
        payload["preserveText"] = request.referenceId is not None
    # Compile once up front so impossible combinations fail with 400 at submit
    # time rather than minutes later on the GPU.
    try:
        plan = video_plan(payload, variant=0, start_image="start.png" if request.referenceId else None,
                          end_image="end.png" if request.endReferenceId else None,
                          source_video="source.mp4" if source else None)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    payload["plan"] = plan.describe()
    payload["durationSeconds"] = plan.duration_seconds
    # Estimate at submit time (GPU-ready basis), kept for estimate-vs-actual.
    payload["estimate"] = est.estimate_plan(calibration, plan, request.variants)
    if origin:
        payload["origin"] = origin
    job = Job(id=uuid.uuid4().hex, owner=owner, request=payload, kind="video")
    jobs[job.id] = job
    if idempotency_key:
        idempotency[idempotency_key] = job.id
    queue.put_nowait(job.id)
    return job


def video_plan(request: dict, *, variant: int, start_image: str | None, end_image: str | None,
               source_video: str | None = None) -> vw.VideoPlan:
    return vw.plan_video(
        model=request["model"], prompt=request["prompt"],
        # Variants are independent takes; segments inside one take use seed+n.
        seed=request["seed"] + variant * 1000,
        aspect=request["aspect"], resolution=request["resolution"],
        duration_seconds=request["durationSeconds"], output_fps=request["fps"],
        camera=request["camera"], preserve_text=request["preserveText"],
        accelerated=request["accelerated"], upscaler=request["upscaler"],
        start_image=start_image, end_image=end_image,
        source_video=source_video, source_frames=request.get("sourceFrames") or 0,
        source_start_seconds=request.get("sourceStartSeconds") or 0.0,
        mode=request.get("mode"), control=request.get("control"),
        control_strength=request.get("controlStrength", 1.0),
    )


@app.get("/api/videos/jobs/{job_id}")
async def get_video_job(job_id: str, x_burtson_owner: str = Header(default="unknown")) -> dict:
    return public_job(owned_job(job_id, x_burtson_owner))


@app.post("/api/jobs/cancel-all")
async def cancel_all_jobs() -> dict:
    """Cancel every running and queued job (Anton's forced release).

    Not owner-scoped: only Anton calls it (ClusterIP-only, no ingress), after
    its own admin/partner check, when an operator chooses "release now".
    """
    cancelled = 0
    for job in list(jobs.values()):
        if job.status in {"queued", "running"} and not job.cancelRequested:
            job.cancelRequested = True
            job.updatedAt = datetime.now(UTC).isoformat()
            cancelled += 1
    if active_job_id is not None:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                await client.post(f"{COMFY_URL}/interrupt")
        except httpx.HTTPError:
            pass
    return {"cancelled": cancelled}


@app.get("/api/images/jobs/{job_id}")
async def get_job(job_id: str, x_burtson_owner: str = Header(default="unknown")) -> dict:
    job = owned_job(job_id, x_burtson_owner)
    return public_job(job)


@app.delete("/api/images/jobs/{job_id}", status_code=202)
async def cancel_job(job_id: str, x_burtson_owner: str = Header(default="unknown")) -> dict:
    job = owned_job(job_id, x_burtson_owner)
    if job.status in {"completed", "failed", "cancelled"}:
        return public_job(job)
    job.cancelRequested = True
    job.updatedAt = datetime.now(UTC).isoformat()
    return public_job(job)


@app.get("/api/images/jobs/{job_id}/assets/{index}")
async def get_asset(job_id: str, index: int, x_burtson_owner: str = Header(default="unknown")) -> Response:
    if job_id not in jobs:
        # The in-memory job is gone (restart or TTL); finished outputs live on
        # in the history library under the same job id and asset index.
        found = await asyncio.to_thread(library.legacy_asset, x_burtson_owner[:200], job_id, index)
        if found is None:
            raise HTTPException(404, "image job not found")
        body, content_type = found
        return Response(content=body, media_type=content_type, headers={"Cache-Control": "private, max-age=86400"})
    job = owned_job(job_id, x_burtson_owner)
    if is_expired(job.expiresAt):
        raise HTTPException(410, "image asset has expired")
    keys = job.assetKeys or [image["key"] for image in job.images]
    if index < 0 or index >= len(keys):
        raise HTTPException(404, "image asset not found")
    obj = await asyncio.to_thread(s3_client().get_object, Bucket=BUCKET, Key=keys[index])
    body = await asyncio.to_thread(obj["Body"].read)
    return Response(content=body, media_type=obj.get("ContentType", "image/png"))


def owned_job(job_id: str, owner: str) -> Job:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "image job not found")
    if job.owner != owner:
        raise HTTPException(403, "image job belongs to another user")
    return job


def owned_reference(reference_id: str, owner: str, *, expected_kind: str | None = None) -> Reference:
    # After a restart the record is reloaded from MinIO (see save_reference).
    reference = references.get(reference_id) or load_reference(reference_id, owner)
    if not reference:
        raise HTTPException(404, "image reference not found or expired")
    if reference.owner != owner:
        raise HTTPException(403, "image reference belongs to another user")
    if is_expired(reference.expiresAt):
        raise HTTPException(410, "image reference has expired")
    if expected_kind and reference.kind != expected_kind:
        raise HTTPException(400, f"expected a {expected_kind} image")
    return reference


def public_job(job: Job) -> dict:
    value = asdict(job)
    value.pop("owner", None)
    value.pop("cancelRequested", None)
    value.pop("assetKeys", None)
    value.pop("samplingStartedAt", None)
    value.pop("inputFiles", None)
    value["images"] = [
        {field: content for field, content in image.items() if field != "key"}
        for image in value["images"]
    ]
    for output in value["images"] + value["videos"] + value["audios"]:
        if output.get("seed") is not None:
            output["seedText"] = str(output["seed"])
    if value["request"].get("seed") is not None:
        value["seedText"] = str(value["request"]["seed"])
    return value


def public_reference(reference: Reference) -> dict:
    value = asdict(reference)
    value.pop("owner", None)
    value.pop("key", None)
    return value


async def run_queue() -> None:
    global active_job_id
    while True:
        job_id = await queue.get()
        job = jobs[job_id]
        active_job_id = job_id
        job.startedAt = datetime.now(UTC).isoformat()
        try:
            if job.cancelRequested:
                job.status = "cancelled"
            elif job.kind == "video":
                await execute_video(job)
            elif job.kind == "audio":
                await execute_music(job)
            else:
                await execute(job)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("job %s (%s) failed: %s", job.id, job.kind, type(exc).__name__)
            job.status = "failed"
            job.error = str(exc)[:1000]
        finally:
            active_job_id = None
            job.updatedAt = datetime.now(UTC).isoformat()
            queue.task_done()
        await record_in_library(job)


async def record_in_library(job: Job) -> None:
    """Keep the finished job in the owner's durable history (never raises).

    Production takes stay out of History: they live in v1/productions/ and
    are indexed in Mongo.
    """
    if job.status not in {"completed", "failed", "cancelled"}:
        return
    if is_production(job.request):
        return
    try:
        tenant_dir = os.path.dirname(job.assetKeys[0]) if job.assetKeys else None
        input_keys = {ref.id: ref.key for ref in references.values() if ref.owner == job.owner}
        await asyncio.to_thread(
            library.record, lib.job_metadata(job), status=job.status, tenant_dir=tenant_dir,
            input_keys=input_keys, started_at=job.startedAt, completed_at=job.updatedAt,
        )
    except Exception:
        logger.exception("could not record job %s in the history library", job.id)
    if watch_sync is not None and job.status == "completed":
        watch_sync.kick()


async def execute(job: Job) -> None:
    request = job.request
    job.status = "running"
    job.updatedAt = datetime.now(UTC).isoformat()
    async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=30)) as client:
        if not await wait_for_worker(client, job):
            return
        reference_name = await upload_comfy_reference(client, job, request.get("referenceId"))
        mask_name = await upload_comfy_reference(client, job, request.get("maskId"))
        workflow = flux_workflow(
            request["prompt"], request["width"], request["height"], request["steps"], request["seed"],
            reference_name=reference_name, mask_name=mask_name, strength=request.get("strength", 0.72),
        )
        submitted = await client.post(f"{COMFY_URL}/prompt", json={"prompt": workflow, "client_id": job.id})
        submitted.raise_for_status()
        prompt_id = submitted.json()["prompt_id"]
        job.comfyPromptId = prompt_id
        while True:
            if job.cancelRequested:
                await client.post(f"{COMFY_URL}/interrupt")
                job.status = "cancelled"
                return
            await asyncio.sleep(2)
            history = await client.get(f"{COMFY_URL}/history/{prompt_id}")
            history.raise_for_status()
            entry = history.json().get(prompt_id)
            if entry:
                break
        outputs = entry.get("outputs", {}).get("7", {}).get("images", [])
        if not outputs:
            raise RuntimeError("ComfyUI completed without an image output")
        created = datetime.now(UTC)
        for index, image in enumerate(outputs, start=1):
            response = await client.get(f"{COMFY_URL}/view", params=image)
            response.raise_for_status()
            key = f"v1/tenant/{safe_owner(job.owner)}/{created:%Y/%m/%d}/{job.id}/image-{index:02d}.png"
            expires_at = datetime.fromisoformat(job.expiresAt)
            await asyncio.to_thread(upload, key, response.content, "image/png", expires_at)
            job.assetKeys.append(key)
            job.images.append({
                "url": f"/image/jobs/{job.id}/assets/{index - 1}", "key": key,
                "width": request["width"], "height": request["height"],
                "model": request["model"], "seed": request["seed"], "workflowVersion": WORKFLOW_VERSION,
                "modelDigest": MODEL_DIGEST, "modelLicense": MODEL_LICENSE,
                "expiresAt": job.expiresAt, "mode": "edit" if reference_name else "generate",
            })
        metadata_key = f"v1/tenant/{safe_owner(job.owner)}/{created:%Y/%m/%d}/{job.id}/metadata.json"
        metadata = json.dumps({
            "jobId": job.id, "owner": job.owner, "createdAt": job.createdAt,
            "request": request, "workflowVersion": WORKFLOW_VERSION,
            "modelDigest": MODEL_DIGEST, "modelLicense": MODEL_LICENSE,
            "expiresAt": job.expiresAt, "images": job.images,
        }, indent=2).encode()
        await asyncio.to_thread(upload, metadata_key, metadata, "application/json", datetime.fromisoformat(job.expiresAt))
        job.status = "completed"


async def upload_comfy_reference(client: httpx.AsyncClient, job: Job, reference_id: str | None) -> str | None:
    if not reference_id:
        return None
    reference = owned_reference(reference_id, job.owner)
    obj = await asyncio.to_thread(s3_client().get_object, Bucket=BUCKET, Key=reference.key)
    body = await asyncio.to_thread(obj["Body"].read)
    extension, content_type = (".mp4", "video/mp4") if reference.kind == "video" else (".png", "image/png")
    name = f"burtson-{job.id}-{reference.kind}-{reference.id}{extension}"
    response = await client.post(
        f"{COMFY_URL}/upload/image",
        files={"image": (name, body, content_type)},
        data={"type": "input", "overwrite": "true"},
    )
    response.raise_for_status()
    payload = response.json()
    return payload.get("name") or name


async def execute_video(job: Job) -> None:
    """Run each requested variant as one ComfyUI prompt, sequentially.

    The GPU stays claimed for the whole job, so variants reuse the warm models.
    A variant that fails after earlier ones succeeded leaves the job completed
    with the delivered takes and an error note, rather than discarding them.
    """
    request = job.request
    job.status = "running"
    job.progress = {"stage": "preparing", "percent": 0, "variant": 1, "variants": request["variants"]}
    job.updatedAt = datetime.now(UTC).isoformat()
    created = datetime.now(UTC)
    prefix = output_prefix(job, created)
    # Production takes never expire (no lifecycle tag; outside v1/tenant/).
    expires_at = None if is_production(request) else datetime.fromisoformat(job.expiresAt)
    async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=120)) as client:
        if not await wait_for_worker(client, job):
            return
        start_name = await upload_comfy_reference(client, job, request.get("referenceId"))
        end_name = await upload_comfy_reference(client, job, request.get("endReferenceId"))
        source_name = await upload_comfy_reference(client, job, request.get("sourceVideoId"))
        for variant in range(request["variants"]):
            if job.cancelRequested:
                job.status = "cancelled"
                return
            plan = video_plan(request, variant=variant, start_image=start_name, end_image=end_name,
                              source_video=source_name)
            take_started = time.monotonic()
            job.samplingStartedAt = None
            try:
                raw = await run_video_prompt(client, job, plan, variant)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if job.status == "cancelled":
                    return
                if not job.videos:
                    raise
                job.error = f"variant {variant + 1} failed: {str(exc)[:500]}"
                break
            if job.status == "cancelled":
                return
            job.progress = {**(job.progress or {}), "stage": "encoding"}
            final, poster, probe = await asyncio.to_thread(finalize_video, raw, plan)
            number = variant + 1
            video_key = f"{prefix}/video-{number:02d}.mp4"
            poster_key = f"{prefix}/poster-{number:02d}.jpg"
            job.progress = {**(job.progress or {}), "stage": "uploading"}
            await asyncio.to_thread(upload, video_key, final, "video/mp4", expires_at)
            await asyncio.to_thread(upload, poster_key, poster, "image/jpeg", expires_at)
            job.assetKeys.extend([video_key, poster_key])
            record_take_timing(plan, take_started, job.samplingStartedAt, first=variant == 0)
            job.videos.append({
                "url": f"/image/jobs/{job.id}/assets/{len(job.assetKeys) - 2}",
                "posterUrl": f"/image/jobs/{job.id}/assets/{len(job.assetKeys) - 1}",
                "variant": number, "seed": plan.seed, "model": plan.model.alias,
                "workflowVersion": plan.workflow_version,
                "width": probe.get("width", plan.out_width), "height": probe.get("height", plan.out_height),
                "fps": plan.output_fps, "durationSeconds": probe.get("duration", plan.duration_seconds),
                "frames": probe.get("frames"), "codec": probe.get("codec"), "pixelFormat": probe.get("pix_fmt"),
                "bytes": len(final), "sha256": hashlib.sha256(final).hexdigest(),
                "modelLicense": plan.model.license,
                "modelDigests": {name: vw.CHECKPOINT_SHA256.get(name, "unverified")
                                 for name in vw.plan_checkpoints(plan)},
                "expiresAt": job.expiresAt,
                "mode": ("video-to-video" if source_name else
                         "image-to-video" if start_name else "text-to-video"),
                "sourceSha256": request.get("sourceSha256"),
                "plan": plan.describe(),
            })
    metadata = json.dumps({
        "jobId": job.id, "owner": job.owner, "createdAt": job.createdAt, "kind": "video",
        "request": request, "videos": job.videos, "error": job.error,
        "comfyuiWorkflow": "server-owned; see workflowVersion", "expiresAt": job.expiresAt,
    }, indent=2).encode()
    await asyncio.to_thread(upload, f"{prefix}/metadata.json", metadata, "application/json", expires_at)
    job.progress = {**(job.progress or {}), "stage": "completed", "percent": 100}
    job.status = "completed"


async def wait_for_worker(client: httpx.AsyncClient, job: Job) -> bool:
    """Hold a job until the GPU worker answers (Anton claims on submit).

    Returns False when the job was cancelled while waiting; raises when the
    worker never comes up.
    """
    deadline = time.monotonic() + WORKER_WAIT_SECONDS
    announced = False
    while True:
        try:
            response = await client.get(f"{COMFY_URL}/system_stats", timeout=5)
            if response.status_code == 200:
                return True
        except httpx.HTTPError:
            pass
        if job.cancelRequested:
            job.status = "cancelled"
            return False
        if not announced:
            job.progress = {**(job.progress or {}), "stage": "waiting_for_gpu", "percent": 0}
            announced = True
        if time.monotonic() > deadline:
            raise RuntimeError(f"the GPU worker did not become ready within {WORKER_WAIT_SECONDS} s")
        await asyncio.sleep(3)


def record_take_timing(plan: vw.VideoPlan, started: float, sampling_started: float | None, *, first: bool) -> None:
    """Feed a finished take back into the estimator and persist the stats."""
    elapsed = time.monotonic() - started
    load = None
    if first and sampling_started is not None:
        # Model load + conditioning before the first sampler step.
        load = max(0.0, sampling_started - started)
        elapsed -= load
    calibration.record(est.key_of(plan), elapsed / est.generated_seconds(plan), load)
    asyncio.get_running_loop().run_in_executor(None, write_stats)


class EstimateRequest(BaseModel):
    """What the form currently says; uploads are described, not required."""
    model: Literal["video-fast", "video-quality"] = "video-quality"
    aspect: Literal["16:9", "9:16", "1:1"] = "16:9"
    resolution: Literal["480p", "720p", "1080p"] = "720p"
    durationSeconds: float = Field(default=5.0, gt=0, le=60)
    fps: Literal[24, 30] = 24
    variants: int = Field(default=1, ge=1, le=4)
    accelerated: bool | None = None
    upscaler: Literal["esrgan", "lanczos"] = "esrgan"
    hasImage: bool = False
    hasEndImage: bool = False
    hasVideo: bool = False
    sourceSeconds: float = Field(default=vw.MAX_SOURCE_SECONDS, gt=0, le=600)
    sourceStartSeconds: float = Field(default=0.0, ge=0.0, le=vw.MAX_SOURCE_SECONDS)
    mode: vw.VideoMode | None = None
    control: vw.Control | None = None


@app.post("/api/videos/estimate")
async def estimate_video(request: EstimateRequest) -> dict:
    """Seconds a job with these settings should take, excluding the GPU claim.

    Invalid combinations come back as {"valid": false, "error": ...} so the
    form can explain them inline.
    """
    accelerated = request.accelerated if request.accelerated is not None else not request.hasVideo
    try:
        plan = vw.plan_video(
            model=request.model, prompt="estimate", seed=0, aspect=request.aspect,
            resolution=request.resolution, duration_seconds=request.durationSeconds,
            output_fps=request.fps, accelerated=accelerated, upscaler=request.upscaler,
            start_image="start.png" if request.hasImage else None,
            end_image="end.png" if request.hasEndImage else None,
            source_video="source.mp4" if request.hasVideo else None,
            source_frames=round(min(request.sourceSeconds, vw.MAX_SOURCE_SECONDS) * vw.SOURCE_FPS) + 1,
            source_start_seconds=request.sourceStartSeconds,
            mode=request.mode if request.hasVideo else None,
            control=request.control if request.hasVideo else None,
        )
    except ValueError as exc:
        return {"valid": False, "error": str(exc)}
    return {"valid": True, "pipeline": plan.kind, "durationSeconds": plan.duration_seconds,
            "accelerated": accelerated, **est.estimate_plan(calibration, plan, request.variants)}


def estimate_job_seconds(job: Job) -> float:
    """Seconds a whole job should take once the GPU is ready."""
    if job.kind == "audio":
        return float(est.estimate_music(audio_calibration, float(job.request.get("durationSeconds") or 30),
                                        int(job.request.get("variants") or 1),
                                        loopable=bool(job.request.get("loopable")))["seconds"])
    if job.kind == "finish":
        return float((job.request.get("estimate") or {}).get("seconds") or 60.0)
    if job.kind != "video":
        return 20.0
    try:
        plan = video_plan(job.request, variant=0,
                          start_image="start.png" if job.request.get("referenceId") else None,
                          end_image="end.png" if job.request.get("endReferenceId") else None,
                          source_video="source.mp4" if job.request.get("sourceVideoId") else None)
    except ValueError:
        return 300.0 * max(1, int(job.request.get("variants") or 1))
    return float(est.estimate_plan(calibration, plan, int(job.request.get("variants") or 1))["seconds"])


def remaining_seconds(job: Job, now: datetime | None = None) -> float:
    """What's left of a job: the estimate while queued, estimate minus elapsed once running."""
    if job.cancelRequested or job.status in {"completed", "failed", "cancelled"}:
        return 0.0
    estimate = estimate_job_seconds(job)
    if job.status != "running" or not job.startedAt:
        return estimate
    if (job.progress or {}).get("stage") == "waiting_for_gpu":
        return estimate + est.CLAIM_SECONDS
    elapsed = ((now or datetime.now(UTC)) - datetime.fromisoformat(job.startedAt)).total_seconds()
    # Never promise "done" while it is still running.
    return max(estimate - elapsed, 15.0)


@app.get("/api/videos/queue")
async def video_queue(jobId: str | None = None, x_burtson_owner: str = Header(default="unknown")) -> dict:
    """Queue depth and wait, plus position/ETA for one of the caller's jobs.

    Other callers' jobs are counted, never described. Excludes a pending GPU
    claim unless the running job is already waiting for it.
    """
    now = datetime.now(UTC)
    running = jobs.get(active_job_id) if active_job_id else None
    running_left = remaining_seconds(running, now) if running else 0.0
    waiting = [jobs[job_id] for job_id in list(queue._queue) if job_id in jobs]
    waiting = [job for job in waiting if not job.cancelRequested]
    result: dict[str, Any] = {
        "depth": len(waiting),
        "running": running is not None,
        "waitSeconds": round(running_left + sum(estimate_job_seconds(job) for job in waiting)),
    }
    if not jobId:
        return result
    job = owned_job(jobId, x_burtson_owner)
    if job.kind == "finish":
        return finish_queue_position(job, result)
    if running is not None and running.id == job.id:
        result.update(position=0, aheadSeconds=0, etaSeconds=round(running_left))
    elif job in waiting:
        index = waiting.index(job)
        ahead = running_left + sum(estimate_job_seconds(other) for other in waiting[:index])
        result.update(position=index + 1, aheadSeconds=round(ahead),
                      etaSeconds=round(ahead + estimate_job_seconds(job)))
    else:
        result.update(position=None, aheadSeconds=None, etaSeconds=None)
    result["status"] = job.status
    return result


async def run_video_prompt(client: httpx.AsyncClient, job: Job, plan: vw.VideoPlan, variant: int) -> bytes:
    workflow = vw.wan_video_workflow(plan, filename_prefix=f"burtson-video/{job.id}-{variant + 1}")
    samplers = vw.sampler_nodes(plan)
    total_steps = sum(steps for _, steps in samplers) or 1
    base = {"variant": variant + 1, "variants": job.request["variants"]}
    job.progress = {**base, "stage": "loading_model", "percent": 0}
    watcher = asyncio.create_task(watch_progress(job, samplers, total_steps, base))
    try:
        submitted = await client.post(f"{COMFY_URL}/prompt", json={"prompt": workflow, "client_id": job.id})
        if submitted.status_code >= 400:
            raise RuntimeError(f"ComfyUI rejected the video workflow: {submitted.text[:600]}")
        prompt_id = submitted.json()["prompt_id"]
        job.comfyPromptId = prompt_id
        deadline = time.monotonic() + VIDEO_VARIANT_TIMEOUT_SECONDS
        while True:
            if job.cancelRequested:
                await client.post(f"{COMFY_URL}/interrupt")
                job.status = "cancelled"
                return b""
            if time.monotonic() > deadline:
                await client.post(f"{COMFY_URL}/interrupt")
                raise TimeoutError(f"video variant exceeded {VIDEO_VARIANT_TIMEOUT_SECONDS} s")
            await asyncio.sleep(3)
            history = await client.get(f"{COMFY_URL}/history/{prompt_id}")
            history.raise_for_status()
            entry = history.json().get(prompt_id)
            if entry:
                break
    finally:
        watcher.cancel()
    status = entry.get("status", {})
    if status.get("status_str") == "error":
        raise RuntimeError(f"ComfyUI failed: {comfy_error(status)}")
    outputs = entry.get("outputs", {}).get("save", {}).get("images", [])
    if not outputs:
        raise RuntimeError("ComfyUI completed without a video output")
    response = await client.get(f"{COMFY_URL}/view", params=outputs[0])
    response.raise_for_status()
    return response.content


def comfy_error(status: dict) -> str:
    for kind, data in status.get("messages", []):
        if kind == "execution_error" and isinstance(data, dict):
            return f"{data.get('node_type')}: {data.get('exception_message', '').strip()[:400]}"
    return "unknown error"


async def watch_progress(job: Job, samplers: list[tuple[str, int]], total_steps: int, base: dict) -> None:
    """Best-effort step progress from ComfyUI's websocket; polling stays authoritative."""
    stages = {"upscale": "upscaling", "resize": "resizing", "interpolate": "interpolating",
              "video": "encoding", "save": "encoding"}
    offsets: dict[str, tuple[int, int]] = {}
    running = 0
    for node, steps in samplers:
        offsets[node] = (running, steps)
        running += steps
    ws_url = COMFY_URL.replace("http://", "ws://").replace("https://", "wss://") + f"/ws?clientId={job.id}"
    try:
        import websockets

        async with websockets.connect(ws_url, max_size=None, open_timeout=10) as socket:
            async for message in socket:
                if isinstance(message, bytes):
                    continue  # latent previews
                event = json.loads(message)
                data = event.get("data") or {}
                if data.get("prompt_id") not in (None, job.comfyPromptId):
                    continue
                node = data.get("node")
                if event.get("type") == "progress" and node in offsets:
                    if job.samplingStartedAt is None:
                        job.samplingStartedAt = time.monotonic()
                    offset, _ = offsets[node]
                    done = offset + int(data.get("value", 0))
                    job.progress = {**base, "stage": "sampling", "node": node,
                                    "step": done, "steps": total_steps,
                                    "percent": round(90 * done / total_steps)}
                elif event.get("type") == "executing" and node:
                    stage = ("decoding" if node.endswith("_decode") else stages.get(node))
                    if stage:
                        job.progress = {**(job.progress or base), "stage": stage}
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.info("progress stream unavailable for job %s: %s", job.id, type(exc).__name__)


def finalize_video(raw: bytes, plan: vw.VideoPlan) -> tuple[bytes, bytes, dict]:
    """Final delivery encode: H.264 High, yuv420p, +faststart, exact output fps.

    ComfyUI hands over a near-lossless (CRF 12) H.264 intermediate at the
    workflow rate (native fps x RIFE multiplier); this resamples to the exact
    delivery rate and makes the file web/social-upload friendly.
    """
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg is not installed in the image API")
    with tempfile.TemporaryDirectory(prefix="burtson-video-") as work:
        source = os.path.join(work, "source.mp4")
        final = os.path.join(work, "final.mp4")
        poster = os.path.join(work, "poster.jpg")
        with open(source, "wb") as handle:
            handle.write(raw)
        run_ffmpeg([
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-an",
            "-vf", f"fps={plan.output_fps},scale={plan.out_width}:{plan.out_height}:flags=lanczos,setsar=1",
            "-c:v", "libx264", "-preset", "medium", "-crf", VIDEO_CRF, "-profile:v", "high",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", final,
        ])
        # The first frame of image-to-video is the uploaded photo itself; a
        # frame a little way in represents the generated motion better.
        poster_at = f"{min(1.0, plan.duration_seconds / 3):.2f}"
        run_ffmpeg([
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", poster_at,
            "-i", final, "-frames:v", "1", "-q:v", "3", poster,
        ])
        probe = probe_video(final)
        with open(final, "rb") as handle:
            final_bytes = handle.read()
        with open(poster, "rb") as handle:
            poster_bytes = handle.read()
    return final_bytes, poster_bytes, probe


def run_ffmpeg(command: list[str]) -> None:
    result = subprocess.run(command, capture_output=True, text=True, timeout=900, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.strip()[-400:]}")


def probe_video(path: str) -> dict:
    result = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
        "-show_entries", "stream=codec_name,pix_fmt,width,height,nb_read_frames:format=duration",
        "-of", "json", path,
    ], capture_output=True, text=True, timeout=120, check=False)
    if result.returncode != 0:
        return {}
    data = json.loads(result.stdout or "{}")
    stream = (data.get("streams") or [{}])[0]
    duration = (data.get("format") or {}).get("duration")
    return {
        "codec": stream.get("codec_name"), "pix_fmt": stream.get("pix_fmt"),
        "width": stream.get("width"), "height": stream.get("height"),
        "frames": int(stream["nb_read_frames"]) if stream.get("nb_read_frames") else None,
        "duration": round(float(duration), 2) if duration else None,
    }


def upload(key: str, body: bytes, content_type: str, expires_at: datetime | None) -> None:
    """Store an object; ``expires_at=None`` writes it without expiry metadata."""
    client = s3_client()
    if expires_at is None:
        client.put_object(Bucket=BUCKET, Key=key, Body=io.BytesIO(body), ContentType=content_type)
        return
    expires_epoch = int(expires_at.timestamp())
    client.put_object(
        Bucket=BUCKET, Key=key, Body=io.BytesIO(body), ContentType=content_type,
        Metadata={"expires-at": expires_at.isoformat()},
        Tagging=urlencode({"expires-at": str(expires_epoch)}),
    )


def is_production(request: dict) -> bool:
    return (request.get("origin") or {}).get("kind") == "production"


def output_prefix(job: Job, created: datetime) -> str:
    origin = job.request.get("origin") or {}
    if origin.get("kind") == "production":
        return production_take_prefix(job.owner, origin["productionId"], origin["takeId"])
    return f"v1/tenant/{safe_owner(job.owner)}/{created:%Y/%m/%d}/{job.id}"


def production_take_prefix(owner: str, production_id: str, take_id: str) -> str:
    return f"{PRODUCTIONS_PREFIX}/{safe_owner(owner)}/{production_id}/takes/{take_id}"


def normalize_upload(body: bytes, kind: str) -> tuple[bytes, int, int]:
    if not body:
        raise HTTPException(400, "image upload is empty")
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    try:
        with Image.open(io.BytesIO(body)) as source:
            source.load()
            image = ImageOps.exif_transpose(source)
            if image.width < 64 or image.height < 64:
                raise HTTPException(400, "image must be at least 64x64 pixels")
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise HTTPException(413, "image dimensions are too large")
            if kind == "mask":
                image = image.convert("L")
            elif kind == "logo":
                # Logo bookends composite the real logo onto a card: keep its alpha.
                image = image.convert("RGBA")
            else:
                # ComfyUI's LoadImage discards the alpha channel outright, so a
                # transparent-background logo would arrive on whatever RGB values
                # hide under the transparency (usually black) and the sampler
                # eats its edges. Composite onto white before it gets there.
                rgba = image.convert("RGBA")
                backdrop = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
                image = Image.alpha_composite(backdrop, rgba).convert("RGB")
            output = io.BytesIO()
            image.save(output, format="PNG", optimize=True)
            return output.getvalue(), image.width, image.height
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(400, "unsupported or corrupt image upload") from exc


def is_expired(value: str) -> bool:
    return datetime.fromisoformat(value) <= datetime.now(UTC)


async def run_reaper() -> None:
    while True:
        try:
            # Copy anything not yet in the history library before it can expire.
            keep = await asyncio.to_thread(library.backfill)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("history backfill failed; skipping this reaper sweep")
            await asyncio.sleep(REAPER_INTERVAL_SECONDS)
            continue
        try:
            await asyncio.to_thread(reap_expired_objects, keep + pending_input_keys())
            now = datetime.now(UTC)
            for job_id, job in list(jobs.items()):
                if datetime.fromisoformat(job.expiresAt) <= now:
                    jobs.pop(job_id, None)
            for reference_id, reference in list(references.items()):
                if datetime.fromisoformat(reference.expiresAt) <= now:
                    references.pop(reference_id, None)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("asset reaper failed")
        await asyncio.sleep(REAPER_INTERVAL_SECONDS)


def pending_input_keys() -> list[str]:
    """Uploads that queued or running jobs still need (and will copy into History)."""
    keys: list[str] = []
    for job in list(jobs.values()):
        if job.status in {"queued", "running"}:
            ids = [job.request.get(f) for f in ("referenceId", "endReferenceId", "sourceVideoId", "maskId")]
            ids += list(job.request.get("inputReferences") or [])
            for reference_id in ids:
                reference = references.get(reference_id or "")
                if reference:
                    keys += [reference.key, reference_record_key(reference.owner, reference.id)]
    return keys


def reap_expired_objects(keep: Iterable[str] = ()) -> int:
    """Delete working files past the TTL, except ``keep`` entries: job
    directories whose copy into the history library failed this pass, and the
    exact keys of uploads that pending jobs still need."""
    client = s3_client()
    cutoff = datetime.now(UTC) - ASSET_TTL
    paginator = client.get_paginator("list_objects_v2")
    expired: list[dict] = []
    deleted = 0
    keep = list(keep)
    exact = set(keep)
    prefixes = tuple(f"{prefix.rstrip('/')}/" for prefix in keep)
    for page in paginator.paginate(Bucket=BUCKET, Prefix="v1/tenant/"):
        for item in page.get("Contents", []):
            modified = item.get("LastModified")
            if item["Key"] in exact or (prefixes and item["Key"].startswith(prefixes)):
                continue
            if modified and modified <= cutoff:
                expired.append({"Key": item["Key"]})
            if len(expired) == 1000:
                client.delete_objects(Bucket=BUCKET, Delete={"Objects": expired, "Quiet": True})
                deleted += len(expired)
                expired = []
    if expired:
        client.delete_objects(Bucket=BUCKET, Delete={"Objects": expired, "Quiet": True})
        deleted += len(expired)
    if deleted:
        logger.info("deleted %d expired image assets", deleted)
    return deleted


safe_owner = lib.safe_owner


# --- History library (Burtson Studio) -------------------------------------------
# Owner-scoped like every other route: Anton sets X-Burtson-Owner from the JWT.
# Anton proxies these as /image/library/* (see README).


class TakeChange(BaseModel):
    index: int = Field(ge=0, le=64)
    favorite: bool | None = None
    hidden: bool | None = None


class LibraryItemChange(BaseModel):
    favorite: bool | None = None
    hidden: bool | None = None
    # Explicit null moves the item out of its project.
    projectId: str | None = Field(default=None, min_length=1, max_length=64)
    outputs: list[TakeChange] | None = Field(default=None, max_length=16)


class ProjectBody(BaseModel):
    name: str = Field(min_length=1, max_length=200)


def library_call(fn, *args):
    try:
        return fn(*args)
    except lib.LibraryError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@app.get("/api/watch/sync")
async def watch_sync_status() -> dict:
    """The last watch sync pass (cluster-internal; not proxied by Anton)."""
    return {"enabled": watch_sync is not None, "lastPass": watch_sync.last_pass if watch_sync else None}


@app.get("/api/library")
async def list_library(
    q: str = "", kind: Literal["image", "video"] | None = None, model: str | None = None,
    status: Literal["completed", "failed"] | None = None, since: str | None = None,
    view: str = Query(default="all", pattern=r"^(all|favorites|unassigned|project:[A-Za-z0-9]{1,64})$"),
    includeHidden: bool = False, limit: int = Query(default=lib.DEFAULT_PAGE, ge=1, le=lib.MAX_PAGE),
    cursor: str | None = Query(default=None, max_length=200),
    x_burtson_owner: str = Header(default="unknown"),
) -> dict:
    """One page of the caller's history (newest first), projects and sidebar counts.

    Follow ``nextCursor`` for the next page.
    """
    return await asyncio.to_thread(lambda: library_call(lambda: library.list(
        x_burtson_owner[:200], q=q[:200], kind=kind, model=model, status=status, since=since, view=view,
        include_hidden=includeHidden, limit=limit, cursor=cursor)))


@app.post("/api/library/sync")
async def sync_library(x_burtson_owner: str = Header(default="unknown")) -> dict:
    """Copy the caller's not-yet-recorded finished jobs into history now."""
    owner = x_burtson_owner[:200]
    failed = await asyncio.to_thread(library.backfill, owner)
    return {"failed": len(failed)}


@app.get("/api/library/items/{job_id}")
async def get_library_item(job_id: str, x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await asyncio.to_thread(library_call, library.get_item, x_burtson_owner[:200], job_id)


@app.patch("/api/library/items/{job_id}")
async def update_library_item(job_id: str, change: LibraryItemChange,
                              x_burtson_owner: str = Header(default="unknown")) -> dict:
    """Favourite/hide the item or individual takes, or move it to a project."""
    changes = change.model_dump(include=change.model_fields_set)
    if "outputs" in changes and changes["outputs"] is None:
        changes.pop("outputs")
    return await asyncio.to_thread(library_call, library.update_item, x_burtson_owner[:200], job_id, changes)


@app.get("/api/library/items/{job_id}/files/{name}")
async def get_library_file(job_id: str, name: str, x_burtson_owner: str = Header(default="unknown")) -> Response:
    body, content_type = await asyncio.to_thread(
        library_call, library.read_file, x_burtson_owner[:200], job_id, name)
    # Library files never change once written.
    return Response(content=body, media_type=content_type,
                    headers={"Cache-Control": "private, max-age=604800, immutable"})


@app.post("/api/library/projects", status_code=201)
async def create_project(body: ProjectBody, x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await asyncio.to_thread(library_call, library.create_project, x_burtson_owner[:200], body.name)


@app.patch("/api/library/projects/{project_id}")
async def rename_project(project_id: str, body: ProjectBody,
                         x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await asyncio.to_thread(
        library_call, library.rename_project, x_burtson_owner[:200], project_id, body.name)


@app.delete("/api/library/projects/{project_id}")
async def delete_project(project_id: str, x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await asyncio.to_thread(library_call, library.delete_project, x_burtson_owner[:200], project_id)


# --- Productions (overnight shots) ------------------------------------------------
# State and the durable queue live in Mongo (app/productions); this process's
# in-memory queue stays the executor and is fed one take at a time.


def estimate_take(request: dict) -> dict:
    """Estimate one take of a production shot (raises ValueError for impossible combinations)."""
    accelerated = request.get("accelerated")
    plan = vw.plan_video(
        model=request["model"], prompt="estimate", seed=0, aspect=request.get("aspect", "16:9"),
        resolution=request["resolution"], duration_seconds=float(request["durationSeconds"]), output_fps=24,
        camera=request.get("camera", "auto"), preserve_text=bool(request.get("preserveText")),
        accelerated=True if accelerated is None else bool(accelerated),
        start_image="start.png" if request.get("keyframe") else None,
        end_image="end.png" if request.get("endFrame") else None,
    )
    return est.estimate_plan(calibration, plan, 1)


class ProductionExecutor:
    """image-api's own queue as the Productions dispatcher sees it (called from a worker thread)."""

    def __init__(self, loop: asyncio.AbstractEventLoop):
        self.loop = loop

    def interactive_busy(self) -> bool:
        # Called only when no production take is in flight, so anything queued
        # or running here is someone's interactive job: it goes first.
        return pending_job_count() > 0

    def worker_ready(self) -> bool:
        try:
            return httpx.get(f"{COMFY_URL}/system_stats", timeout=3).status_code == 200
        except httpx.HTTPError:
            return False

    def submit(self, job: dict) -> str:
        future = asyncio.run_coroutine_threadsafe(self._submit(job), self.loop)
        return future.result(timeout=60)

    async def _submit(self, job: dict) -> str:
        request = job["request"]
        owner = job["owner"]
        # Fresh reference records every attempt: production frames live in
        # v1/productions/ and never expire, so nothing can 404 after a restart.
        start = self._frame_reference(job, request.get("keyframe"))
        end = self._frame_reference(job, request.get("endFrame"))
        try:
            video = VideoRequest(
                prompt=request["prompt"], model=request["model"], aspect=request.get("aspect", "16:9"),
                resolution=request["resolution"], durationSeconds=request["durationSeconds"], fps=24,
                camera=request.get("camera", "auto"), preserveText=request.get("preserveText"),
                accelerated=request.get("accelerated"), variants=1, seed=int(job["seed"]),
                referenceId=start, endReferenceId=end,
            )
        except Exception as exc:  # pydantic validation
            raise prod_dispatcher.SubmitError("invalid", str(exc)[:500]) from exc
        origin = {"kind": "production", "productionId": job["productionId"], "shotId": job["shotId"],
                  "takeId": job["_id"]}
        try:
            created = create_video_job(video, owner, idempotency_key=f"{job['_id']}:{job.get('attempts', 1)}",
                                       origin=origin)
        except HTTPException as exc:
            error_class = "invalid" if exc.status_code == 400 else "transient"
            raise prod_dispatcher.SubmitError(error_class, str(exc.detail)) from exc
        return created.id

    def _frame_reference(self, job: dict, name: str | None) -> str | None:
        if not name:
            return None
        key = (f"{PRODUCTIONS_PREFIX}/{safe_owner(job['owner'])}/{job['productionId']}/shots/"
               f"{job['shotId']}/{name}")
        try:
            obj = s3_client().head_object(Bucket=BUCKET, Key=key)
        except Exception as exc:
            raise prod_dispatcher.SubmitError("invalid", f"the shot's frame {name} is missing") from exc
        reference = Reference(
            id=uuid.uuid4().hex, owner=job["owner"], key=key, kind="reference", filename=name,
            contentType="image/png", width=0, height=0, bytes=int(obj.get("ContentLength") or 0),
            expiresAt=(datetime.now(UTC) + timedelta(days=7)).isoformat(),
        )
        references[reference.id] = reference
        return reference.id

    def status(self, image_job_id: str) -> dict | None:
        job = jobs.get(image_job_id)
        if job is None:
            return None
        return {"status": job.status, "error": job.error, "startedAt": job.startedAt, "updatedAt": job.updatedAt,
                "videos": list(job.videos), "progress": dict(job.progress or {})}

    def cancel(self, image_job_id: str) -> None:
        job = jobs.get(image_job_id)
        if job is None or job.status in {"completed", "failed", "cancelled"}:
            return
        job.cancelRequested = True
        if active_job_id == image_job_id:
            try:
                httpx.post(f"{COMFY_URL}/interrupt", timeout=5)
            except httpx.HTTPError:
                pass

    def take_fields(self, job: dict, image_job: dict) -> dict:
        video = image_job["videos"][0]
        number = int(video.get("variant") or 1)
        return {
            "prefix": production_take_prefix(job["owner"], job["productionId"], job["_id"]),
            "files": {"video": f"video-{number:02d}.mp4", "poster": f"poster-{number:02d}.jpg"},
            "width": video.get("width"), "height": video.get("height"), "fps": video.get("fps"),
            "durationSeconds": video.get("durationSeconds"), "frames": video.get("frames"),
            "bytes": video.get("bytes"), "sha256": video.get("sha256"),
            "workflowVersion": video.get("workflowVersion"), "modelDigests": video.get("modelDigests"),
            "modelLicense": video.get("modelLicense"), "mode": video.get("mode"),
        }


def production_object(key: str) -> tuple[bytes, str] | None:
    try:
        obj = s3_client().get_object(Bucket=BUCKET, Key=key)
    except Exception as exc:
        if "NoSuchKey" in type(exc).__name__ or "NoSuchKey" in str(exc):
            return None
        raise
    return obj["Body"].read(), obj.get("ContentType") or "application/octet-stream"


def start_productions() -> None:
    """Connect to Mongo and start the dispatcher; without MONGO_URI Productions stay off (503)."""
    global dispatcher
    if not MONGO_URI:
        logger.info("productions: MONGO_URI not set; Productions are disabled")
        return
    from pymongo import MongoClient

    client = MongoClient(MONGO_URI, w="majority", serverSelectionTimeoutMS=5000, appname="image-api")
    store = prod_store.Store(client[MONGO_DB], estimator=estimate_take)
    holder = f"{os.getenv('HOSTNAME', 'image-api')}:{uuid.uuid4().hex[:8]}"
    dispatcher = prod_dispatcher.Dispatcher(store, ProductionExecutor(asyncio.get_running_loop()), holder=holder,
                                            load_seconds=calibration.load_seconds)
    prod_routes.runtime = prod_routes.Runtime(
        store=store, dispatcher=dispatcher, get_object=production_object,
        put_object=lambda key, body, content_type: upload(key, body, content_type, None),
        normalize_image=lambda body: normalize_upload(body, "reference"), safe_owner=safe_owner,
        max_upload_bytes=MAX_UPLOAD_BYTES,
    )
    dispatcher.start()
    logger.info("productions: dispatcher started as %s", holder)


# --- Audio: music (ACE-Step 1.5, GPU), audio uploads, finishing (CPU mix) ---------------
# Anton proxies these as /image/audio*, /image/finish* (see README).


class MusicRequest(BaseModel):
    prompt: str = Field(min_length=3, max_length=2000)
    genre: str | None = Field(default=None, max_length=80)
    mood: str | None = Field(default=None, max_length=80)
    bpm: int | None = Field(default=None, ge=40, le=220)
    keyscale: str | None = Field(default=None, max_length=12)
    timeSignature: Literal["2", "3", "4", "6"] = "4"
    durationSeconds: float = Field(default=30.0, ge=aw.MIN_SECONDS, le=aw.MAX_SECONDS)
    instrumental: bool = True
    lyrics: str | None = Field(default=None, max_length=4000)
    language: str = Field(default="en", max_length=8)
    loopable: bool = False
    seed: int | None = Field(default=None, ge=0, le=2**62)
    variants: int = Field(default=1, ge=1, le=4)
    title: str | None = Field(default=None, max_length=120)
    # Optional watch collection name for these tracks (e.g. "Burtson Stock Audio").
    collection: str | None = Field(default=None, max_length=80)
    # Sound effects have no licence-clean model yet; "sfx" is refused with the reason.
    kind: Literal["music", "sfx"] = "music"


class MusicEstimateRequest(BaseModel):
    durationSeconds: float = Field(default=30.0, gt=0, le=600)
    variants: int = Field(default=1, ge=1, le=4)
    instrumental: bool = True
    loopable: bool = False


class TakeRef(BaseModel):
    itemId: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    take: int = Field(default=0, ge=0, le=64)


class FinishMusic(BaseModel):
    itemId: str | None = Field(default=None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    take: int = Field(default=0, ge=0, le=64)
    audioId: str | None = Field(default=None, min_length=8, max_length=64)
    prompt: str | None = Field(default=None, min_length=3, max_length=2000)
    genre: str | None = Field(default=None, max_length=80)
    mood: str | None = Field(default=None, max_length=80)
    bpm: int | None = Field(default=None, ge=40, le=220)
    seed: int | None = Field(default=None, ge=0, le=2**62)

    def source(self) -> str:
        chosen = [name for name, present in (("item", self.itemId), ("upload", self.audioId),
                                             ("prompt", self.prompt)) if present]
        if len(chosen) != 1:
            raise ValueError("music needs exactly one of itemId, audioId or prompt")
        return chosen[0]


class NarrationLine(BaseModel):
    audioId: str = Field(min_length=8, max_length=64)
    text: str | None = Field(default=None, max_length=2000)
    voice: str | None = Field(default=None, max_length=80)
    startSeconds: float | None = Field(default=None, ge=0, le=600)


class FinishLogo(BaseModel):
    referenceId: str = Field(min_length=8, max_length=64)
    start: bool = True
    end: bool = True
    background: str = Field(default="#000000", pattern=r"^#?[0-9a-fA-F]{6}$")
    seconds: float = Field(default=2.0, ge=1.0, le=5.0)


class FinishRequest(BaseModel):
    video: TakeRef
    music: FinishMusic | None = None
    musicStartSeconds: float = Field(default=0.0, ge=0.0, le=600)
    narration: list[NarrationLine] = Field(default_factory=list, max_length=MAX_NARRATION_LINES)
    originalAudio: Literal["auto", "keep", "drop"] = "auto"
    sfx: Any = None
    levels: Literal["voice-forward", "balanced", "music-forward"] = "balanced"
    captions: bool = False
    fadeInSeconds: float = Field(default=0.5, ge=0.0, le=5.0)
    fadeOutSeconds: float = Field(default=1.5, ge=0.0, le=8.0)
    videoFades: bool = False
    fit: Literal["audio", "video"] = "audio"
    logo: FinishLogo | None = None
    title: str | None = Field(default=None, max_length=120)


class FinishEstimateRequest(BaseModel):
    videoSeconds: float = Field(default=5.0, gt=0, le=600)
    resolution: Literal["480p", "720p", "1080p"] = "720p"
    narrationLines: int = Field(default=0, ge=0, le=MAX_NARRATION_LINES)
    narrationSeconds: float = Field(default=0.0, ge=0, le=1200)
    captions: bool = False
    logo: bool = False
    videoFades: bool = False
    musicPrompt: bool = False
    musicSeconds: float | None = Field(default=None, gt=0, le=aw.MAX_SECONDS)


class AudioLibraryRequest(BaseModel):
    audioId: str = Field(min_length=8, max_length=64)
    title: str | None = Field(default=None, max_length=120)
    text: str | None = Field(default=None, max_length=4000)
    voice: str | None = Field(default=None, max_length=80)
    kind: Literal["narration", "upload"] = "narration"
    collection: str | None = Field(default=None, max_length=80)


@app.get("/api/audio/capabilities")
async def audio_capabilities() -> dict:
    return {
        "music": {"available": True, "model": aw.MODEL_ALIAS, "label": aw.MODEL_LABEL, "licence": aw.MODEL_LICENSE,
                  "workflowVersion": aw.WORKFLOW_VERSION, "minSeconds": aw.MIN_SECONDS, "maxSeconds": aw.MAX_SECONDS,
                  "maxVariants": 4, "languages": list(aw.LANGUAGES), "timeSignatures": list(aw.TIME_SIGNATURES),
                  "keyscales": list(aw.KEYSCALES), "loopCrossfadeSeconds": aw.LOOP_CROSSFADE_SECONDS},
        "sfx": {"available": False, "reason": aw.SFX_UNAVAILABLE_REASON},
        "narration": {"via": "gateway", "endpoint": "/api/stealth/tts", "defaultVoice": "en_US-heart-local"},
        "finish": {"levels": list(mix.LEVELS), "maxNarrationLines": MAX_NARRATION_LINES,
                   "maxAudioUploadMiB": MAX_AUDIO_UPLOAD_BYTES // (1024 * 1024),
                   "voiceLufs": mix.VOICE_LUFS, "truePeak": mix.VOICE_TP,
                   "bedDb": {name: preset.bed_db for name, preset in mix.LEVELS.items()}},
    }


def music_plan_from(request: dict, variant: int) -> aw.MusicPlan:
    return aw.plan_music(
        prompt=request["prompt"], seed=int(request["seed"]) + variant * 1000,
        duration_seconds=float(request["durationSeconds"]), instrumental=bool(request["instrumental"]),
        lyrics=request.get("lyrics"), genre=request.get("genre"), mood=request.get("mood"), bpm=request.get("bpm"),
        keyscale=request.get("keyscale"), time_signature=request.get("timeSignature") or "4",
        language=request.get("language") or "en", loopable=bool(request.get("loopable")),
    )


@app.post("/api/audio/generations", status_code=202)
async def generate_music(request: MusicRequest, x_burtson_owner: str = Header(default="unknown"),
                         idempotency_key: str | None = Header(default=None, max_length=200)) -> dict:
    return public_job(create_music_job(request, x_burtson_owner[:200], idempotency_key=idempotency_key))


def create_music_job(request: MusicRequest, owner: str, *, idempotency_key: str | None = None,
                     origin: dict | None = None) -> Job:
    if request.kind == "sfx":
        raise HTTPException(400, aw.SFX_UNAVAILABLE_REASON)
    if idempotency_key:
        existing = jobs.get(idempotency.get(idempotency_key, ""))
        if existing is not None and existing.owner == owner:
            return existing
    if queue.full():
        raise HTTPException(429, "generation queue is full")
    payload = request.model_dump()
    payload["seed"] = request.seed if request.seed is not None else random.randrange(0, JS_SAFE_SEED)
    payload["model"] = aw.MODEL_ALIAS
    try:
        plan = music_plan_from(payload, 0)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    payload["plan"] = plan.describe()
    payload["estimate"] = est.estimate_music(audio_calibration, plan.duration_seconds, request.variants,
                                             loopable=plan.loopable)
    if origin:
        payload["origin"] = origin
    job = Job(id=uuid.uuid4().hex, owner=owner, request=payload, kind="audio")
    jobs[job.id] = job
    if idempotency_key:
        idempotency[idempotency_key] = job.id
    queue.put_nowait(job.id)
    return job


@app.post("/api/audio/estimate")
async def estimate_audio(request: MusicEstimateRequest) -> dict:
    if not (aw.MIN_SECONDS <= request.durationSeconds <= aw.MAX_SECONDS):
        return {"valid": False, "error": f"duration must be {aw.MIN_SECONDS:g}-{aw.MAX_SECONDS:g} s"}
    if request.loopable and request.durationSeconds < aw.LOOP_CROSSFADE_SECONDS * 3:
        return {"valid": False, "error": f"a loopable track must be at least {aw.LOOP_CROSSFADE_SECONDS * 3:g} s"}
    return {"valid": True, **est.estimate_music(audio_calibration, request.durationSeconds, request.variants,
                                                loopable=request.loopable)}


async def execute_music(job: Job) -> None:
    """One ComfyUI prompt per take, then mastering on the CPU (WAV, MP3, waveform)."""
    request = job.request
    job.status = "running"
    job.progress = {"stage": "preparing", "percent": 0, "variant": 1, "variants": request["variants"]}
    job.updatedAt = datetime.now(UTC).isoformat()
    prefix = output_prefix(job, datetime.now(UTC))
    expires_at = datetime.fromisoformat(job.expiresAt)
    async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=120)) as client:
        if not await wait_for_worker(client, job):
            return
        for variant in range(request["variants"]):
            if job.cancelRequested:
                job.status = "cancelled"
                return
            plan = music_plan_from(request, variant)
            take_started = time.monotonic()
            job.samplingStartedAt = None
            try:
                raw = await run_music_prompt(client, job, plan, variant)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if job.status == "cancelled":
                    return
                if not job.audios:
                    raise
                job.error = f"take {variant + 1} failed: {str(exc)[:500]}"
                break
            if job.status == "cancelled":
                return
            job.progress = {**(job.progress or {}), "stage": "encoding"}
            mastered = await asyncio.to_thread(master_music_bytes, raw, plan)
            number = variant + 1
            keys = [f"{prefix}/audio-{number:02d}.wav", f"{prefix}/audio-{number:02d}.mp3", f"{prefix}/wave-{number:02d}.jpg"]
            job.progress = {**(job.progress or {}), "stage": "uploading"}
            for key, body, content_type in zip(keys, (mastered["wavBytes"], mastered["mp3Bytes"], mastered["waveBytes"]),
                                               ("audio/wav", "audio/mpeg", "image/jpeg")):
                await asyncio.to_thread(upload, key, body, content_type, expires_at)
            job.assetKeys.extend(keys)
            record_music_timing(plan, take_started, job.samplingStartedAt, first=variant == 0)
            base = len(job.assetKeys) - 3
            job.audios.append({
                "url": f"/image/jobs/{job.id}/assets/{base}", "mp3Url": f"/image/jobs/{job.id}/assets/{base + 1}",
                "waveformUrl": f"/image/jobs/{job.id}/assets/{base + 2}",
                "variant": number, "seed": plan.seed, "model": aw.MODEL_ALIAS, "mode": "music",
                "workflowVersion": aw.WORKFLOW_VERSION, "durationSeconds": mastered["durationSeconds"],
                "sampleRate": mastered["sampleRate"], "channels": mastered["channels"],
                "lufs": mastered["lufs"], "truePeak": mastered["truePeak"],
                "bytes": len(mastered["wavBytes"]), "sha256": hashlib.sha256(mastered["wavBytes"]).hexdigest(),
                "mp3Bytes": len(mastered["mp3Bytes"]), "modelLicense": aw.MODEL_LICENSE,
                "modelDigests": dict(aw.CHECKPOINT_SHA256), "bpm": plan.bpm, "keyscale": plan.keyscale,
                "timeSignature": plan.time_signature, "instrumental": plan.instrumental, "loopable": plan.loopable,
                "title": request.get("title"), "expiresAt": job.expiresAt, "plan": plan.describe(),
            })
    metadata = json.dumps({
        "jobId": job.id, "owner": job.owner, "createdAt": job.createdAt, "kind": "audio",
        "request": request, "audios": job.audios, "error": job.error,
        "comfyuiWorkflow": "server-owned; see workflowVersion", "expiresAt": job.expiresAt,
    }, indent=2).encode()
    await asyncio.to_thread(upload, f"{prefix}/metadata.json", metadata, "application/json", expires_at)
    job.progress = {**(job.progress or {}), "stage": "completed", "percent": 100}
    job.status = "completed"


async def run_music_prompt(client: httpx.AsyncClient, job: Job, plan: aw.MusicPlan, variant: int) -> bytes:
    workflow = aw.ace_workflow(plan, filename_prefix=f"burtson-audio/{job.id}-{variant + 1}")
    base = {"variant": variant + 1, "variants": job.request["variants"]}
    job.progress = {**base, "stage": "loading_model", "percent": 0}
    watcher = asyncio.create_task(watch_progress(job, [("sampler", aw.STEPS)], aw.STEPS, base))
    try:
        submitted = await client.post(f"{COMFY_URL}/prompt", json={"prompt": workflow, "client_id": job.id})
        if submitted.status_code >= 400:
            raise RuntimeError(f"ComfyUI rejected the music workflow: {submitted.text[:600]}")
        prompt_id = submitted.json()["prompt_id"]
        job.comfyPromptId = prompt_id
        deadline = time.monotonic() + 900
        while True:
            if job.cancelRequested:
                await client.post(f"{COMFY_URL}/interrupt")
                job.status = "cancelled"
                return b""
            if time.monotonic() > deadline:
                await client.post(f"{COMFY_URL}/interrupt")
                raise TimeoutError("music take exceeded 900 s")
            await asyncio.sleep(2)
            history = await client.get(f"{COMFY_URL}/history/{prompt_id}")
            history.raise_for_status()
            entry = history.json().get(prompt_id)
            if entry:
                break
    finally:
        watcher.cancel()
    status = entry.get("status", {})
    if status.get("status_str") == "error":
        raise RuntimeError(f"ComfyUI failed: {comfy_error(status)}")
    outputs = entry.get("outputs", {}).get("save", {}).get("audio", [])
    if not outputs:
        raise RuntimeError("ComfyUI completed without an audio output")
    response = await client.get(f"{COMFY_URL}/view", params=outputs[0])
    response.raise_for_status()
    return response.content


def master_music_bytes(raw: bytes, plan: aw.MusicPlan) -> dict:
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg is not installed in the image API")
    with tempfile.TemporaryDirectory(prefix="burtson-music-") as work:
        source = os.path.join(work, "raw.flac")
        with open(source, "wb") as handle:
            handle.write(raw)
        result = mix.master_music(source, work, duration=plan.duration_seconds, loopable=plan.loopable)
        return read_mastered(result)


def read_mastered(result: dict) -> dict:
    out = dict(result)
    for name, key in (("wav", "wavBytes"), ("mp3", "mp3Bytes"), ("waveform", "waveBytes")):
        with open(result[name], "rb") as handle:
            out[key] = handle.read()
    return out


def record_music_timing(plan: aw.MusicPlan, started: float, sampling_started: float | None, *, first: bool) -> None:
    elapsed = time.monotonic() - started
    load = None
    if first and sampling_started is not None:
        load = max(0.0, sampling_started - started)
        elapsed -= load
    audio_calibration.record(est.MUSIC_KEY, elapsed / max(1.0, plan.render_seconds), load)
    asyncio.get_running_loop().run_in_executor(None, write_stats, est.AUDIO_STATS_KEY, audio_calibration)


@app.post("/api/audio/sources", status_code=201)
async def upload_audio_source(request: Request, x_burtson_owner: str = Header(default="unknown")) -> dict:
    """An audio file as the raw body (narration from the gateway, your own music).

    Identified by probing; stored as 48 kHz stereo 16-bit WAV with the upload TTL."""
    owner = x_burtson_owner[:200]
    with tempfile.TemporaryDirectory(prefix="burtson-audio-src-") as work:
        original = os.path.join(work, "original")
        digest = hashlib.sha256()
        size = 0
        with open(original, "wb") as handle:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_AUDIO_UPLOAD_BYTES:
                    raise HTTPException(413, f"audio exceeds the {MAX_AUDIO_UPLOAD_BYTES // (1024 * 1024)} MiB upload limit")
                digest.update(chunk)
                handle.write(chunk)
        if size == 0:
            raise HTTPException(400, "audio upload is empty")
        normalized, info = await asyncio.to_thread(normalize_audio_upload, original, work)
    reference = await asyncio.to_thread(
        store_audio_reference, owner, normalized, info, digest.hexdigest(),
        (request.headers.get("x-filename") or "audio.wav")[:200])
    return public_reference(reference)


def normalize_audio_upload(path: str, work: str) -> tuple[bytes, dict]:
    probe = mix.probe_media(path)
    if not probe or not probe.get("audio"):
        raise HTTPException(400, "unsupported or corrupt audio: no decodable audio stream")
    if probe["duration"] < 0.2:
        raise HTTPException(400, "audio must be at least 0.2 s long")
    if probe["duration"] > MAX_AUDIO_UPLOAD_SECONDS:
        raise HTTPException(400, f"audio must be at most {MAX_AUDIO_UPLOAD_SECONDS // 60} minutes")
    output = os.path.join(work, "normalized.wav")
    try:
        run_ffmpeg(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", path, "-vn", "-sn", "-dn",
                    "-map_metadata", "-1", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", output])
    except RuntimeError as exc:
        raise HTTPException(400, "the audio could not be decoded") from exc
    info = mix.probe_media(output)
    with open(output, "rb") as handle:
        return handle.read(), {"duration": info.get("duration") or probe["duration"]}


def store_audio_reference(owner: str, body: bytes, info: dict, original_sha: str, filename: str) -> Reference:
    reference_id = uuid.uuid4().hex
    created = datetime.now(UTC)
    key = f"v1/tenant/{safe_owner(owner)}/{created:%Y/%m/%d}/references/{reference_id}.wav"
    expires_at = created + ASSET_TTL
    upload(key, body, "audio/wav", expires_at)
    reference = Reference(
        id=reference_id, owner=owner, key=key, kind="audio", filename=filename, contentType="audio/wav",
        width=0, height=0, bytes=len(body), createdAt=created.isoformat(), expiresAt=expires_at.isoformat(),
        durationSeconds=info["duration"], sha256=hashlib.sha256(body).hexdigest(), originalSha256=original_sha,
    )
    references[reference_id] = reference
    save_reference(reference)
    return reference


@app.post("/api/audio/library", status_code=201)
async def save_audio_to_library(body: AudioLibraryRequest, x_burtson_owner: str = Header(default="unknown")) -> dict:
    """Keep an uploaded take (a narration line from the gateway, your own track) in History."""
    owner = x_burtson_owner[:200]
    reference = owned_reference(body.audioId, owner, expected_kind="audio")
    job = Job(id=uuid.uuid4().hex, owner=owner, kind="audio", status="running", request={
        "mode": body.kind, "title": body.title, "text": body.text, "voice": body.voice,
        "prompt": body.text or body.title or reference.filename, "model": body.voice or "upload",
        "collection": body.collection, "audioId": reference.id, "instrumental": body.kind != "narration",
    })
    jobs[job.id] = job
    job.startedAt = datetime.now(UTC).isoformat()
    try:
        await asyncio.to_thread(save_upload_as_take, job, reference, body)
        job.status = "completed"
    except Exception as exc:
        job.status = "failed"
        job.error = str(exc)[:500]
    job.updatedAt = datetime.now(UTC).isoformat()
    await record_in_library(job)
    if job.status != "completed":
        raise HTTPException(500, f"could not save the audio: {job.error}")
    return await asyncio.to_thread(library_call, library.get_item, owner, job.id)


def save_upload_as_take(job: Job, reference: Reference, body: AudioLibraryRequest) -> None:
    obj = s3_client().get_object(Bucket=BUCKET, Key=reference.key)
    raw = obj["Body"].read()
    with tempfile.TemporaryDirectory(prefix="burtson-audio-save-") as work:
        source = os.path.join(work, "source.wav")
        with open(source, "wb") as handle:
            handle.write(raw)
        # Narration keeps its own level (the mix sets voice loudness); uploads are left as they are too.
        mastered = read_mastered(mix.master_wav(source, work, normalise=False))
    prefix = output_prefix(job, datetime.now(UTC))
    expires_at = datetime.fromisoformat(job.expiresAt)
    keys = [f"{prefix}/audio-01.wav", f"{prefix}/audio-01.mp3", f"{prefix}/wave-01.jpg"]
    for key, data, content_type in zip(keys, (mastered["wavBytes"], mastered["mp3Bytes"], mastered["waveBytes"]),
                                       ("audio/wav", "audio/mpeg", "image/jpeg")):
        upload(key, data, content_type, expires_at)
    job.assetKeys.extend(keys)
    job.audios.append({
        "url": f"/image/jobs/{job.id}/assets/0", "mp3Url": f"/image/jobs/{job.id}/assets/1",
        "waveformUrl": f"/image/jobs/{job.id}/assets/2", "variant": 1, "mode": body.kind,
        "model": body.voice or "upload", "durationSeconds": mastered["durationSeconds"],
        "sampleRate": mastered["sampleRate"], "channels": mastered["channels"], "lufs": mastered["lufs"],
        "truePeak": mastered["truePeak"], "bytes": len(mastered["wavBytes"]),
        "sha256": hashlib.sha256(mastered["wavBytes"]).hexdigest(), "mp3Bytes": len(mastered["mp3Bytes"]),
        "title": body.title, "text": body.text, "voice": body.voice, "sourceSha256": reference.originalSha256,
        "instrumental": body.kind != "narration", "expiresAt": job.expiresAt,
    })
    metadata = json.dumps({"jobId": job.id, "owner": job.owner, "createdAt": job.createdAt, "kind": "audio",
                           "request": job.request, "audios": job.audios, "error": None,
                           "expiresAt": job.expiresAt}, indent=2).encode()
    upload(f"{prefix}/metadata.json", metadata, "application/json", expires_at)


# --- Finish video ------------------------------------------------------------------------


@app.post("/api/finish/estimate")
async def estimate_finish(request: FinishEstimateRequest) -> dict:
    hold = request.narrationSeconds > request.videoSeconds
    encode = request.captions or request.logo or request.videoFades or hold
    output = max(request.videoSeconds, request.narrationSeconds + mix.NARRATION_LEAD + mix.NARRATION_TAIL
                 if hold else request.videoSeconds) + (3.0 if request.logo else 0.0)
    music_seconds = None
    if request.musicPrompt:
        music_seconds = min(aw.MAX_SECONDS, max(aw.MIN_SECONDS, request.musicSeconds or output + 1))
    return {"valid": True, "encode": encode, "outputSeconds": round(output, 2),
            **est.estimate_finish(audio_calibration, output_seconds=output, encode=encode,
                                  resolution=request.resolution, music_seconds=music_seconds)}


@app.post("/api/finish", status_code=202)
async def finish_video(request: FinishRequest, x_burtson_owner: str = Header(default="unknown"),
                       idempotency_key: str | None = Header(default=None, max_length=200)) -> dict:
    owner = x_burtson_owner[:200]
    if idempotency_key:
        existing = jobs.get(idempotency.get(idempotency_key, ""))
        if existing is not None and existing.owner == owner:
            return public_job(existing)
    if finish_queue.full():
        raise HTTPException(429, "finishing queue is full")
    payload = await asyncio.to_thread(validate_finish, request, owner)
    job = Job(id=uuid.uuid4().hex, owner=owner, request=payload, kind="finish")
    jobs[job.id] = job
    if idempotency_key:
        idempotency[idempotency_key] = job.id
    finish_queue.put_nowait(job.id)
    return public_job(job)


def validate_finish(request: FinishRequest, owner: str) -> dict:
    """Resolve and check every input at submit time (400 for impossible requests)."""
    if request.sfx not in (None, False, [], {}):
        raise HTTPException(400, "sound effects are not available: " + aw.SFX_UNAVAILABLE_REASON)
    item = library_call(library.get_item, owner, request.video.itemId)
    if item.get("kind") != "video" or item.get("status") != "completed":
        raise HTTPException(400, "video must be a completed video item in History")
    output = next((o for o in item.get("outputs") or [] if o.get("index") == request.video.take), None)
    if output is None or not output.get("file"):
        raise HTTPException(400, f"take {request.video.take} not found in that item")
    music_source = None
    if request.music is not None:
        try:
            music_source = request.music.source()
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if music_source == "item":
            track = library_call(library.get_item, owner, request.music.itemId)
            take = next((o for o in track.get("outputs") or [] if o.get("index") == request.music.take), None)
            if track.get("kind") != "audio" or take is None:
                raise HTTPException(400, "music must be an audio item (and take) in History")
        elif music_source == "upload":
            owned_reference(request.music.audioId, owner, expected_kind="audio")
    for line in request.narration:
        owned_reference(line.audioId, owner, expected_kind="audio")
    if request.captions and not any((line.text or "").strip() for line in request.narration):
        raise HTTPException(400, "captions need narration lines with text")
    if request.logo is not None:
        owned_reference(request.logo.referenceId, owner, expected_kind="logo")
        if not (request.logo.start or request.logo.end):
            raise HTTPException(400, "logo needs start and/or end")
    payload = request.model_dump()
    payload.pop("sfx", None)
    payload["musicSource"] = music_source
    payload["prompt"] = item.get("prompt") or ""
    payload["model"] = "finish"
    payload["mode"] = "finished"
    payload["sourceItem"] = {"id": item["id"], "take": request.video.take, "file": output["file"],
                             "sha256": output.get("sha256"), "durationSeconds": output.get("durationSeconds"),
                             "width": output.get("width"), "height": output.get("height"), "fps": output.get("fps"),
                             "prompt": item.get("prompt")}
    payload["inputReferences"] = [line.audioId for line in request.narration] + \
        ([request.music.audioId] if music_source == "upload" else []) + \
        ([request.logo.referenceId] if request.logo else [])
    narration_seconds = 0.0
    for line in request.narration:
        reference = references.get(line.audioId)
        narration_seconds += (reference.durationSeconds or 0.0) + mix.NARRATION_GAP if reference else 0.0
    video_seconds = float(output.get("durationSeconds") or 5.0)
    hold = request.fit == "audio" and narration_seconds + mix.NARRATION_LEAD > video_seconds
    encode = bool(request.captions or request.logo or request.videoFades or hold)
    out_seconds = max(video_seconds, narration_seconds + mix.NARRATION_LEAD + mix.NARRATION_TAIL if hold else 0) + \
        (3.0 if request.logo else 0.0)
    payload["estimate"] = est.estimate_finish(
        audio_calibration, output_seconds=out_seconds, encode=encode,
        resolution=est.resolution_of(output.get("width"), output.get("height")),
        music_seconds=min(aw.MAX_SECONDS, max(aw.MIN_SECONDS, out_seconds + 1)) if music_source == "prompt" else None)
    return payload


def finish_queue_position(job: Job, result: dict) -> dict:
    waiting = [jobs[job_id] for job_id in list(finish_queue._queue) if job_id in jobs]
    waiting = [other for other in waiting if not other.cancelRequested]
    if active_finish_id == job.id:
        left = max(15.0, estimate_job_seconds(job) - elapsed_seconds(job))
        result.update(position=0, aheadSeconds=0, etaSeconds=round(left))
    elif job in waiting:
        index = waiting.index(job)
        running = jobs.get(active_finish_id or "")
        ahead = (max(15.0, estimate_job_seconds(running) - elapsed_seconds(running)) if running else 0.0) + \
            sum(estimate_job_seconds(other) for other in waiting[:index])
        result.update(position=index + 1, aheadSeconds=round(ahead), etaSeconds=round(ahead + estimate_job_seconds(job)))
    else:
        result.update(position=None, aheadSeconds=None, etaSeconds=None)
    result["status"] = job.status
    result["queue"] = "finish"
    return result


def elapsed_seconds(job: Job) -> float:
    if not job.startedAt:
        return 0.0
    return (datetime.now(UTC) - datetime.fromisoformat(job.startedAt)).total_seconds()


async def run_finish_queue() -> None:
    global active_finish_id
    while True:
        job_id = await finish_queue.get()
        job = jobs[job_id]
        active_finish_id = job_id
        job.startedAt = datetime.now(UTC).isoformat()
        try:
            if job.cancelRequested:
                job.status = "cancelled"
            else:
                await asyncio.wait_for(execute_finish(job), timeout=FINISH_TIMEOUT_SECONDS)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("finish job %s failed: %s", job.id, type(exc).__name__)
            job.status = "failed"
            job.error = (str(exc) or type(exc).__name__)[:1000]
        finally:
            active_finish_id = None
            job.updatedAt = datetime.now(UTC).isoformat()
            finish_queue.task_done()
        await record_in_library(job)


def library_bytes(owner: str, item_id: str, name: str) -> bytes:
    body, _ = library_call(library.read_file, owner, item_id, name)
    return body


def reference_bytes(reference_id: str, owner: str) -> bytes:
    reference = owned_reference(reference_id, owner)
    return s3_client().get_object(Bucket=BUCKET, Key=reference.key)["Body"].read()


async def execute_finish(job: Job) -> None:
    request = job.request
    owner = job.owner
    job.status = "running"
    job.progress = {"stage": "preparing", "percent": 0}
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="burtson-finish-") as work:
        source = request["sourceItem"]
        video_path = os.path.join(work, "take.mp4")
        body = await asyncio.to_thread(library_bytes, owner, source["id"], source["file"])
        await asyncio.to_thread(write_file, video_path, body)
        lines: list[mix.Line] = []
        line_paths: dict[str, str] = {}
        for i, line in enumerate(request.get("narration") or []):
            path = os.path.join(work, f"line-{i:02d}.wav")
            await asyncio.to_thread(write_file, path, await asyncio.to_thread(reference_bytes, line["audioId"], owner))
            line_paths[f"input-narration-{i + 1:02d}.wav"] = references[line["audioId"]].key
            lines.append(mix.Line(path=path, duration=0.0, lufs=0.0, text=line.get("text") or "",
                                  start=line.get("startSeconds")))
        job.progress = {"stage": "measuring", "percent": 5}
        spec = await asyncio.to_thread(measure_finish_inputs, video_path, lines, request)
        music_path = None
        music_info: dict[str, Any] = {"source": request.get("musicSource")}
        if request.get("musicSource") == "prompt":
            job.progress = {"stage": "waiting_for_music", "percent": 10}
            music_path, music_info = await generate_bed_for(job, spec, work)
            if job.cancelRequested:
                job.status = "cancelled"
                return
        elif request.get("musicSource") == "item":
            music = request["music"]
            track = await asyncio.to_thread(library_call, library.get_item, owner, music["itemId"])
            take = next(o for o in track["outputs"] if o["index"] == music.get("take", 0))
            music_path = os.path.join(work, "music.wav")
            await asyncio.to_thread(write_file, music_path,
                                    await asyncio.to_thread(library_bytes, owner, music["itemId"], take["file"]))
            music_info.update(itemId=music["itemId"], take=music.get("take", 0), title=track.get("title"),
                              sha256=take.get("sha256"))
        elif request.get("musicSource") == "upload":
            music_path = os.path.join(work, "music.wav")
            await asyncio.to_thread(write_file, music_path,
                                    await asyncio.to_thread(reference_bytes, request["music"]["audioId"], owner))
            job.inputFiles["input-music.wav"] = references[request["music"]["audioId"]].key
            music_info.update(audioId=request["music"]["audioId"])
        if music_path:
            spec.music = await asyncio.to_thread(measure_bed, music_path, float(request.get("musicStartSeconds") or 0),
                                                 mix.timeline(spec).total)
        logo_info = None
        if request.get("logo"):
            logo = request["logo"]
            logo_path = os.path.join(work, "logo.png")
            await asyncio.to_thread(write_file, logo_path,
                                    await asyncio.to_thread(reference_bytes, logo["referenceId"], owner))
            card = os.path.join(work, "card.png")
            await asyncio.to_thread(mix.logo_card, logo_path, card, spec.width, spec.height, logo["background"])
            spec.logo = mix.Logo(path=card, start=logo["start"], end=logo["end"], seconds=float(logo["seconds"]))
            job.inputFiles["input-logo.png"] = references[logo["referenceId"]].key
            logo_info = {k: logo[k] for k in ("start", "end", "background", "seconds")}
        if request.get("captions"):
            tl = mix.timeline(spec)
            cues = mix.caption_cues(spec.lines, tl.line_starts, mix.caption_chars(spec.width, spec.height))
            spec.captions = []
            for j, (text, a, b) in enumerate(cues):
                png = os.path.join(work, f"cap{j:03d}.png")
                await asyncio.to_thread(mix.caption_png, text, png, spec.width, spec.height)
                spec.captions.append((text, a, b, png))
        job.inputFiles.update(line_paths)
        job.progress = {"stage": "mixing", "percent": 40}
        graph = mix.build_graph(spec)
        output = os.path.join(work, "finished.mp4")
        script = os.path.join(work, "graph.txt")
        await asyncio.to_thread(write_file, script, graph.filter.encode())
        command = mix.ffmpeg_command(graph, script, output, fps=spec.fps, crf=VIDEO_CRF)
        job.progress = {"stage": "encoding", "percent": 50}
        mix_started = time.monotonic()
        await asyncio.to_thread(mix.run, command, FINISH_TIMEOUT_SECONDS)
        mix_elapsed = time.monotonic() - mix_started
        final = await asyncio.to_thread(mix.measure, output)
        poster_path = os.path.join(work, "poster.jpg")
        await asyncio.to_thread(run_ffmpeg, [
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{min(graph.timeline.total / 3, graph.timeline.main_offset + 1.0):.2f}", "-i", output,
            "-frames:v", "1", "-q:v", "3", poster_path])
        probe = await asyncio.to_thread(probe_video, output)
        final_bytes = await asyncio.to_thread(read_file, output)
        poster_bytes = await asyncio.to_thread(read_file, poster_path)
    job.progress = {"stage": "uploading", "percent": 90}
    prefix = output_prefix(job, datetime.now(UTC))
    expires_at = datetime.fromisoformat(job.expiresAt)
    await asyncio.to_thread(upload, f"{prefix}/video-01.mp4", final_bytes, "video/mp4", expires_at)
    await asyncio.to_thread(upload, f"{prefix}/poster-01.jpg", poster_bytes, "image/jpeg", expires_at)
    job.assetKeys.extend([f"{prefix}/video-01.mp4", f"{prefix}/poster-01.jpg"])
    encode = not graph.copy_video
    key = est.finish_key(encode, est.resolution_of(spec.width, spec.height))
    audio_calibration.record(key, max(0.0, mix_elapsed) / max(1.0, graph.timeline.total))
    asyncio.get_running_loop().run_in_executor(None, write_stats, est.AUDIO_STATS_KEY, audio_calibration)
    job.videos.append({
        "url": f"/image/jobs/{job.id}/assets/0", "posterUrl": f"/image/jobs/{job.id}/assets/1", "variant": 1,
        "model": "finish", "mode": "finished", "workflowVersion": "finish-v1",
        "width": probe.get("width", spec.width), "height": probe.get("height", spec.height), "fps": spec.fps,
        "durationSeconds": probe.get("duration", round(graph.timeline.total, 2)), "frames": probe.get("frames"),
        "codec": probe.get("codec"), "pixelFormat": probe.get("pix_fmt"), "bytes": len(final_bytes),
        "sha256": hashlib.sha256(final_bytes).hexdigest(), "sourceItemId": source["id"], "sourceTake": source["take"],
        "sourceSha256": source.get("sha256"), "expiresAt": job.expiresAt,
        "mix": {"levels": request.get("levels"), "lufs": round(final["lufs"], 2), "truePeak": round(final["truePeak"], 2),
                "narrationLines": len(spec.lines), "voices": sorted({l.get("voice") for l in request.get("narration") or []
                                                                     if l.get("voice")}),
                "music": music_info if music_path else None, "originalAudio": spec.original is not None,
                "captions": len(spec.captions), "logo": logo_info, "videoCopied": graph.copy_video,
                "heldSeconds": round(graph.timeline.hold_seconds, 2), "applied": graph.levels,
                "elapsedSeconds": round(time.monotonic() - started, 1)},
    })
    metadata = json.dumps({
        "jobId": job.id, "owner": job.owner, "createdAt": job.createdAt, "kind": "finish", "request": request,
        "videos": job.videos, "inputFiles": job.inputFiles, "graph": graph.filter, "error": None,
        "expiresAt": job.expiresAt,
    }, indent=2).encode()
    await asyncio.to_thread(upload, f"{prefix}/metadata.json", metadata, "application/json", expires_at)
    job.progress = {"stage": "completed", "percent": 100}
    job.status = "completed"


def write_file(path: str, body: bytes) -> None:
    with open(path, "wb") as handle:
        handle.write(body)


def read_file(path: str) -> bytes:
    with open(path, "rb") as handle:
        return handle.read()


def measure_finish_inputs(video_path: str, lines: list[mix.Line], request: dict) -> mix.MixSpec:
    probe = mix.probe_media(video_path)
    video = probe.get("video") or {}
    if not video:
        raise RuntimeError("the take has no video stream")
    for line in lines:
        line.duration = mix.probe_media(line.path).get("duration") or 0.0
        line.lufs = mix.measure(line.path)["lufs"]
    original = None
    choice = request.get("originalAudio") or "auto"
    if choice != "drop" and probe.get("audio"):
        measured = mix.measure(video_path)
        if measured["lufs"] > mix.SILENT_LUFS:
            original = mix.Bed(path=None, duration=probe["duration"], lufs=measured["lufs"], role="original")
    elif choice == "keep" and not probe.get("audio"):
        logger.info("finish: originalAudio=keep but the take has no audio track")
    return mix.MixSpec(
        video_path=video_path, video_duration=probe["duration"], width=int(video["width"]), height=int(video["height"]),
        fps=float(video.get("fps") or 24), lines=lines, original=original, levels=request.get("levels") or "balanced",
        fade_in=float(request.get("fadeInSeconds", 0.5)), fade_out=float(request.get("fadeOutSeconds", 1.5)),
        video_fades=bool(request.get("videoFades")), fit=request.get("fit") or "audio",
        logo=(mix.Logo(path="pending", start=request["logo"]["start"], end=request["logo"]["end"],
                       seconds=float(request["logo"]["seconds"])) if request.get("logo") else None),
    )


def measure_bed(path: str, offset: float, total: float) -> mix.Bed:
    duration = mix.probe_media(path).get("duration") or 0.0
    if offset >= duration:
        raise RuntimeError(f"musicStartSeconds {offset:g} is past the end of the track ({duration:g} s)")
    # Measure the part that will play (the whole remainder when it has to loop).
    window = None if duration - offset < total else total + 0.5
    measured = mix.measure(path, start=offset, duration=window)
    return mix.Bed(path=path, duration=duration, lufs=measured["lufs"], offset=offset, role="music")


async def generate_bed_for(job: Job, spec: mix.MixSpec, work: str) -> tuple[str, dict]:
    """Queue a music job sized to the finished length, wait for it, return its WAV."""
    music = job.request["music"]
    length = min(aw.MAX_SECONDS, max(aw.MIN_SECONDS, mix.timeline(spec).total + 1.0))
    request = MusicRequest(prompt=music["prompt"], genre=music.get("genre"), mood=music.get("mood"),
                           bpm=music.get("bpm"), seed=music.get("seed"), durationSeconds=round(length, 2),
                           instrumental=True, title=f"Bed for {job.request.get('title') or 'finished video'}"[:120])
    child = create_music_job(request, job.owner, origin={"kind": "finish", "jobId": job.id})
    job.request["musicJobId"] = child.id
    while child.status in {"queued", "running"}:
        if job.cancelRequested:
            child.cancelRequested = True
            return "", {}
        stage = (child.progress or {}).get("stage") or child.status
        job.progress = {"stage": "waiting_for_music", "percent": 10, "musicJobId": child.id, "musicStage": stage}
        await asyncio.sleep(2)
    if child.status != "completed" or not child.audios:
        raise RuntimeError(f"the music bed failed: {child.error or child.status}")
    path = os.path.join(work, "music.wav")
    body = await asyncio.to_thread(lambda: s3_client().get_object(Bucket=BUCKET, Key=child.assetKeys[0])["Body"].read())
    await asyncio.to_thread(write_file, path, body)
    take = child.audios[0]
    return path, {"source": "prompt", "itemId": child.id, "take": 0, "prompt": music["prompt"], "seed": take.get("seed"),
                  "sha256": take.get("sha256")}
