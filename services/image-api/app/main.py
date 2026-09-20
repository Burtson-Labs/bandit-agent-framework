from __future__ import annotations

import asyncio
import io
import json
import os
import random
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Literal

import boto3
import httpx
from botocore.client import Config
from fastapi import FastAPI, Header, HTTPException, Response
from pydantic import BaseModel, Field, field_validator

from .workflows import flux_workflow, validate_dimension

COMFY_URL = os.getenv("COMFYUI_BASE_URL", "http://image-worker:8188").rstrip("/")
BUCKET = os.getenv("MINIO_BUCKET", "generated-images")
WORKFLOW_VERSION = "flux-schnell-v1"
MODEL_DIGEST = os.getenv("FLUX_MODEL_SHA256", "unverified")
MODEL_LICENSE = "Apache-2.0"


class GenerationRequest(BaseModel):
    prompt: str = Field(min_length=3, max_length=4000)
    width: int = 1024
    height: int = 1024
    model: Literal["flux-schnell"] = "flux-schnell"
    steps: int = Field(default=4, ge=1, le=12)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)

    @field_validator("width", "height")
    @classmethod
    def valid_dimension(cls, value: int) -> int:
        return validate_dimension(value)


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


app = FastAPI(title="Burtson Image API", version="0.1.0")
jobs: dict[str, Job] = {}
queue: asyncio.Queue[str] = asyncio.Queue(maxsize=int(os.getenv("QUEUE_CAPACITY", "20")))
worker_task: asyncio.Task | None = None


def s3_client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["MINIO_ENDPOINT"],
        aws_access_key_id=os.environ["MINIO_ACCESS_KEY"],
        aws_secret_access_key=os.environ["MINIO_SECRET_KEY"],
        config=Config(signature_version="s3v4"),
        region_name=os.getenv("MINIO_REGION", "us-east-1"),
    )


@app.on_event("startup")
async def startup() -> None:
    global worker_task
    await asyncio.to_thread(ensure_bucket)
    worker_task = asyncio.create_task(run_queue())


@app.on_event("shutdown")
async def shutdown() -> None:
    if worker_task:
        worker_task.cancel()


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


@app.post("/api/images/generations", status_code=202)
async def generate(request: GenerationRequest, x_burtson_owner: str = Header(default="unknown")) -> dict:
    if queue.full():
        raise HTTPException(429, "image queue is full")
    job_id = uuid.uuid4().hex
    payload = request.model_dump()
    payload["seed"] = request.seed if request.seed is not None else random.randrange(0, 2**63)
    job = Job(id=job_id, owner=x_burtson_owner[:200], request=payload)
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


def public_job(job: Job) -> dict:
    value = asdict(job)
    value.pop("owner", None)
    value.pop("cancelRequested", None)
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
    workflow = flux_workflow(
        request["prompt"], request["width"], request["height"], request["steps"], request["seed"]
    )
    job.status = "running"
    job.updatedAt = datetime.now(UTC).isoformat()
    async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=30)) as client:
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
            await asyncio.to_thread(upload, key, response.content, "image/png")
            job.images.append({
                "url": f"/image/jobs/{job.id}/assets/{index - 1}", "key": key,
                "width": request["width"], "height": request["height"],
                "model": request["model"], "seed": request["seed"], "workflowVersion": WORKFLOW_VERSION,
                "modelDigest": MODEL_DIGEST, "modelLicense": MODEL_LICENSE,
            })
        metadata_key = f"v1/tenant/{safe_owner(job.owner)}/{created:%Y/%m/%d}/{job.id}/metadata.json"
        metadata = json.dumps({
            "jobId": job.id, "owner": job.owner, "createdAt": job.createdAt,
            "request": request, "workflowVersion": WORKFLOW_VERSION,
            "modelDigest": MODEL_DIGEST, "modelLicense": MODEL_LICENSE, "images": job.images,
        }, indent=2).encode()
        await asyncio.to_thread(upload, metadata_key, metadata, "application/json")
        job.status = "completed"


def upload(key: str, body: bytes, content_type: str) -> None:
    client = s3_client()
    client.put_object(Bucket=BUCKET, Key=key, Body=io.BytesIO(body), ContentType=content_type)


def safe_owner(owner: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in owner).strip("-")
    return cleaned[:100] or "unknown"
