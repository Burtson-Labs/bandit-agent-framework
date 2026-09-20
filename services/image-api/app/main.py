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
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Literal
from urllib.parse import urlencode

import boto3
import httpx
from botocore.client import Config
from fastapi import FastAPI, File, Form, Header, HTTPException, Response, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, Field, field_validator

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
logger = logging.getLogger("burtson.image_api")


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


app = FastAPI(title="Burtson Image API", version="0.1.0")
jobs: dict[str, Job] = {}
references: dict[str, Reference] = {}
queue: asyncio.Queue[str] = asyncio.Queue(maxsize=int(os.getenv("QUEUE_CAPACITY", "20")))
worker_task: asyncio.Task | None = None
reaper_task: asyncio.Task | None = None


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
    client.meta.events.register_first(
        "request-created.s3.PutBucketLifecycleConfiguration",
        add_lifecycle_content_md5,
    )
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
    worker_task = asyncio.create_task(run_queue())
    reaper_task = asyncio.create_task(run_reaper())


@app.on_event("shutdown")
async def shutdown() -> None:
    if worker_task:
        worker_task.cancel()
    if reaper_task:
        reaper_task.cancel()


@app.get("/health/live")
async def live() -> dict:
    return {"status": "ok"}


@app.get("/health/ready")
async def ready() -> dict:
    return {"status": "ok", "queueDepth": queue.qsize()}


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
    days = max(1, math.ceil(ASSET_TTL_HOURS / 24))
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
    kind: Literal["reference", "mask"] = Form(default="reference"),
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
    return public_reference(reference)


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
    payload["seed"] = request.seed if request.seed is not None else random.randrange(0, 2**63)
    job = Job(id=job_id, owner=owner, request=payload)
    jobs[job_id] = job
    await queue.put(job_id)
    return public_job(job)


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
    job = owned_job(job_id, x_burtson_owner)
    if is_expired(job.expiresAt):
        raise HTTPException(410, "image asset has expired")
    if index < 0 or index >= len(job.images):
        raise HTTPException(404, "image asset not found")
    obj = await asyncio.to_thread(s3_client().get_object, Bucket=BUCKET, Key=job.images[index]["key"])
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
    reference = references.get(reference_id)
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
    value["images"] = [
        {field: content for field, content in image.items() if field != "key"}
        for image in value["images"]
    ]
    return value


def public_reference(reference: Reference) -> dict:
    value = asdict(reference)
    value.pop("owner", None)
    value.pop("key", None)
    return value


async def run_queue() -> None:
    while True:
        job_id = await queue.get()
        job = jobs[job_id]
        try:
            if job.cancelRequested:
                job.status = "cancelled"
            else:
                await execute(job)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            job.status = "failed"
            job.error = str(exc)[:1000]
        finally:
            job.updatedAt = datetime.now(UTC).isoformat()
            queue.task_done()


async def execute(job: Job) -> None:
    request = job.request
    job.status = "running"
    job.updatedAt = datetime.now(UTC).isoformat()
    async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=30)) as client:
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
    name = f"burtson-{job.id}-{reference.kind}-{reference.id}.png"
    response = await client.post(
        f"{COMFY_URL}/upload/image",
        files={"image": (name, body, "image/png")},
        data={"type": "input", "overwrite": "true"},
    )
    response.raise_for_status()
    payload = response.json()
    return payload.get("name") or name


def upload(key: str, body: bytes, content_type: str, expires_at: datetime) -> None:
    client = s3_client()
    expires_epoch = int(expires_at.timestamp())
    client.put_object(
        Bucket=BUCKET, Key=key, Body=io.BytesIO(body), ContentType=content_type,
        Metadata={"expires-at": expires_at.isoformat()},
        Tagging=urlencode({"expires-at": str(expires_epoch)}),
    )


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
            await asyncio.to_thread(reap_expired_objects)
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


def reap_expired_objects() -> int:
    client = s3_client()
    cutoff = datetime.now(UTC) - ASSET_TTL
    paginator = client.get_paginator("list_objects_v2")
    expired: list[dict] = []
    deleted = 0
    for page in paginator.paginate(Bucket=BUCKET, Prefix="v1/tenant/"):
        for item in page.get("Contents", []):
            modified = item.get("LastModified")
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


def safe_owner(owner: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in owner).strip("-")
    return cleaned[:100] or "unknown"
