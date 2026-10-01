"""HTTP routes for Productions (Anton proxies them, admin only, as /image/productions/*).

Every route is scoped by X-Burtson-Owner (set by Anton from the JWT); the
scheduler settings are global because there is one GPU.
"""
from __future__ import annotations

import asyncio
import hashlib
import re
from dataclasses import dataclass
from typing import Any, Callable

from fastapi import APIRouter, File, Form, Header, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel, Field

from .dispatcher import Dispatcher
from .store import ProductionsError, Store


@dataclass
class Runtime:
    store: Store
    dispatcher: Dispatcher
    get_object: Callable[[str], tuple[bytes, str] | None]
    put_object: Callable[[str, bytes, str], None]
    normalize_image: Callable[[bytes], tuple[bytes, int, int]]
    safe_owner: Callable[[str], str]
    max_upload_bytes: int


runtime: Runtime | None = None
router = APIRouter(prefix="/api/productions", tags=["productions"])
FRAME_NAME = re.compile(r"^keyframe-(start|end)-[0-9a-f]{12}\.png$")


def rt() -> Runtime:
    if runtime is None:
        raise HTTPException(503, "productions are not configured (no Mongo connection)")
    return runtime


async def call(fn: Callable, *args, **kwargs) -> Any:
    try:
        return await asyncio.to_thread(fn, *args, **kwargs)
    except ProductionsError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


def owner_of(header: str) -> str:
    return header[:200]


# --- request bodies (loose: the store validates and explains) -------------------------
class SettingsBody(BaseModel):
    windowStart: str | None = None
    windowEnd: str | None = None
    days: list[int] | None = None
    timezone: str | None = None
    budgetMinutes: int | None = None
    graceMinutes: int | None = None
    paused: bool | None = None
    defaultTakes: int | None = None


class PauseBody(BaseModel):
    reason: str | None = Field(default=None, max_length=300)


class SessionBody(BaseModel):
    minutes: int = Field(ge=1, le=600)


class QueueBody(BaseModel):
    takes: int | None = Field(default=None, ge=1, le=4)
    priority: int | None = Field(default=None, ge=0, le=100)


class RegenerateBody(BaseModel):
    note: str = Field(min_length=1, max_length=1000)
    prompt: str | None = Field(default=None, max_length=4000)
    takes: int | None = Field(default=None, ge=1, le=4)
    keepSeed: bool = False


class BulkShots(BaseModel):
    sceneId: str
    shots: list[dict] = Field(min_length=1, max_length=200)


# --- scheduler ------------------------------------------------------------------
@router.get("/status")
async def status() -> dict:
    return await call(rt().dispatcher.status)


@router.get("/gpu-intent")
async def gpu_intent(healthy: bool | None = None, fault: str | None = Query(default=None, max_length=300),
                     reason: str | None = Query(default=None, max_length=300),
                     temperatureC: float | None = None, powerW: float | None = None) -> dict:
    """Anton's once-a-minute question; it reports GPU health in the same call."""
    r = rt()
    if healthy is not None or fault:
        await call(r.store.record_health, healthy=bool(healthy) and not fault, fault=fault, reason=reason,
                   temperature_c=temperatureC, power_w=powerW)
    return await call(r.dispatcher.intent)


@router.get("/settings")
async def get_settings() -> dict:
    settings = await call(rt().store.settings)
    return {k: settings.get(k) for k in ("windowStart", "windowEnd", "days", "timezone", "budgetMinutes",
                                         "graceMinutes", "paused", "pausedReason", "defaultTakes")}


@router.put("/settings")
async def put_settings(body: SettingsBody) -> dict:
    await call(rt().store.update_settings, body.model_dump(exclude_none=True))
    return await get_settings()


@router.post("/pause")
async def pause(body: PauseBody | None = None) -> dict:
    await call(rt().store.pause, body.reason if body else None)
    return await get_settings()


@router.post("/resume")
async def resume() -> dict:
    await call(rt().store.resume)
    return await get_settings()


@router.post("/session")
async def start_session(body: SessionBody) -> dict:
    return {"session": await call(rt().store.start_session, body.minutes)}


@router.delete("/session")
async def end_session() -> dict:
    await call(rt().store.end_session)
    return {"session": None}


# --- productions ------------------------------------------------------------------
@router.get("")
async def list_productions(x_burtson_owner: str = Header(default="unknown")) -> dict:
    return {"productions": await call(rt().store.list_productions, owner_of(x_burtson_owner))}


@router.post("", status_code=201)
async def create_production(body: dict, x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await call(rt().store.create_production, owner_of(x_burtson_owner), body)


@router.get("/{production_id}")
async def board(production_id: str, x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await call(rt().store.board, owner_of(x_burtson_owner), production_id)


@router.patch("/{production_id}")
async def update_production(production_id: str, body: dict, x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await call(rt().store.update_production, owner_of(x_burtson_owner), production_id, body)


@router.delete("/{production_id}")
async def delete_production(production_id: str, x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await call(rt().store.delete_production, owner_of(x_burtson_owner), production_id)


@router.post("/{production_id}/episodes", status_code=201)
async def create_episode(production_id: str, body: dict, x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await call(rt().store.create_episode, owner_of(x_burtson_owner), production_id, body)


@router.patch("/{production_id}/episodes/{episode_id}")
async def update_episode(production_id: str, episode_id: str, body: dict,
                         x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await call(rt().store.update_episode, owner_of(x_burtson_owner), production_id, episode_id, body)


@router.delete("/{production_id}/episodes/{episode_id}")
async def delete_episode(production_id: str, episode_id: str, x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await call(rt().store.delete_episode, owner_of(x_burtson_owner), production_id, episode_id)


@router.post("/{production_id}/episodes/{episode_id}/queue")
async def queue_episode(production_id: str, episode_id: str, body: QueueBody | None = None,
                        x_burtson_owner: str = Header(default="unknown")) -> dict:
    body = body or QueueBody()
    return await call(rt().store.queue_episode, owner_of(x_burtson_owner), production_id, episode_id,
                      takes=body.takes, priority=body.priority)


@router.post("/{production_id}/scenes", status_code=201)
async def create_scene(production_id: str, body: dict, x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await call(rt().store.create_scene, owner_of(x_burtson_owner), production_id, body)


@router.patch("/{production_id}/scenes/{scene_id}")
async def update_scene(production_id: str, scene_id: str, body: dict,
                       x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await call(rt().store.update_scene, owner_of(x_burtson_owner), production_id, scene_id, body)


@router.delete("/{production_id}/scenes/{scene_id}")
async def delete_scene(production_id: str, scene_id: str, x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await call(rt().store.delete_scene, owner_of(x_burtson_owner), production_id, scene_id)


@router.post("/{production_id}/shots", status_code=201)
async def create_shot(production_id: str, body: dict, x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await call(rt().store.create_shot, owner_of(x_burtson_owner), production_id, body)


@router.post("/{production_id}/shots/bulk", status_code=201)
async def create_shots(production_id: str, body: BulkShots, x_burtson_owner: str = Header(default="unknown")) -> dict:
    shots = await call(rt().store.create_shots, owner_of(x_burtson_owner), production_id, body.sceneId, body.shots)
    return {"shots": shots}


@router.patch("/{production_id}/shots/{shot_id}")
async def update_shot(production_id: str, shot_id: str, body: dict,
                      x_burtson_owner: str = Header(default="unknown")) -> dict:
    body.pop("keyframe", None)
    body.pop("endFrame", None)  # frames change through the upload route only
    return await call(rt().store.update_shot, owner_of(x_burtson_owner), production_id, shot_id, body)


@router.delete("/{production_id}/shots/{shot_id}")
async def delete_shot(production_id: str, shot_id: str, x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await call(rt().store.delete_shot, owner_of(x_burtson_owner), production_id, shot_id)


@router.post("/{production_id}/shots/{shot_id}/keyframe")
async def upload_frame(production_id: str, shot_id: str, file: UploadFile = File(...),
                       role: str = Form(default="start"), x_burtson_owner: str = Header(default="unknown")) -> dict:
    r = rt()
    owner = owner_of(x_burtson_owner)
    if role not in ("start", "end"):
        raise HTTPException(400, "role must be start or end")
    await call(r.store._owned, "shots", owner, shot_id, production_id)
    body = await file.read(r.max_upload_bytes + 1)
    if len(body) > r.max_upload_bytes:
        raise HTTPException(413, f"image exceeds the {r.max_upload_bytes // (1024 * 1024)} MiB upload limit")
    png, width, height = await asyncio.to_thread(r.normalize_image, body)
    digest = hashlib.sha256(png).hexdigest()
    name = f"keyframe-{role}-{digest[:12]}.png"
    await asyncio.to_thread(r.put_object, frame_key(r, owner, production_id, shot_id, name), png, "image/png")
    ref = {"name": name, "width": width, "height": height, "sha256": digest,
           "filename": (file.filename or "keyframe.png")[:200]}
    return await call(r.store.set_frame, owner, production_id, shot_id, role, ref)


@router.delete("/{production_id}/shots/{shot_id}/keyframe")
async def delete_frame(production_id: str, shot_id: str, role: str = "start",
                       x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await call(rt().store.set_frame, owner_of(x_burtson_owner), production_id, shot_id, role, None)


def frame_key(r: Runtime, owner: str, production_id: str, shot_id: str, name: str) -> str:
    return f"v1/productions/{r.safe_owner(owner)}/{production_id}/shots/{shot_id}/{name}"


@router.get("/{production_id}/shots/{shot_id}/files/{name}")
async def get_frame(production_id: str, shot_id: str, name: str,
                    x_burtson_owner: str = Header(default="unknown")) -> Response:
    r = rt()
    owner = owner_of(x_burtson_owner)
    if not FRAME_NAME.match(name):
        raise HTTPException(404, "file not found")
    await call(r.store._owned, "shots", owner, shot_id, production_id)
    found = await asyncio.to_thread(r.get_object, frame_key(r, owner, production_id, shot_id, name))
    if found is None:
        raise HTTPException(404, "file not found")
    body, content_type = found
    return Response(content=body, media_type=content_type,
                    headers={"Cache-Control": "private, max-age=604800, immutable"})


@router.post("/{production_id}/shots/{shot_id}/queue")
async def queue_shot(production_id: str, shot_id: str, body: QueueBody | None = None,
                     x_burtson_owner: str = Header(default="unknown")) -> dict:
    body = body or QueueBody()
    return await call(rt().store.queue_shot, owner_of(x_burtson_owner), production_id, shot_id,
                      takes=body.takes, priority=body.priority)


@router.post("/{production_id}/shots/{shot_id}/cancel")
async def cancel_shot(production_id: str, shot_id: str, x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await call(rt().store.cancel_shot, owner_of(x_burtson_owner), production_id, shot_id)


@router.post("/{production_id}/shots/{shot_id}/regenerate")
async def regenerate(production_id: str, shot_id: str, body: RegenerateBody,
                     x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await call(rt().store.regenerate, owner_of(x_burtson_owner), production_id, shot_id,
                      note=body.note, prompt=body.prompt, takes=body.takes, keep_seed=body.keepSeed)


@router.post("/{production_id}/shots/{shot_id}/takes/{take_id}/choose")
async def choose(production_id: str, shot_id: str, take_id: str,
                 x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await call(rt().store.choose_take, owner_of(x_burtson_owner), production_id, shot_id, take_id)


@router.post("/{production_id}/shots/{shot_id}/takes/{take_id}/reject")
async def reject(production_id: str, shot_id: str, take_id: str,
                 x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await call(rt().store.reject_take, owner_of(x_burtson_owner), production_id, shot_id, take_id)


@router.post("/{production_id}/shots/{shot_id}/unchoose")
async def unchoose(production_id: str, shot_id: str, x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await call(rt().store.unchoose, owner_of(x_burtson_owner), production_id, shot_id)


@router.post("/{production_id}/jobs/{job_id}/retry")
async def retry_job(production_id: str, job_id: str, x_burtson_owner: str = Header(default="unknown")) -> dict:
    return await call(rt().store.retry_job, owner_of(x_burtson_owner), production_id, job_id)


@router.get("/{production_id}/takes/{take_id}/files/{name}")
async def take_file(production_id: str, take_id: str, name: str,
                    x_burtson_owner: str = Header(default="unknown")) -> Response:
    r = rt()
    take = await call(r.store.take, owner_of(x_burtson_owner), production_id, take_id)
    files = take.get("files") or {}
    if name not in {files.get("video"), files.get("poster"), "metadata.json"} or not take.get("prefix"):
        raise HTTPException(404, "file not found")
    found = await asyncio.to_thread(r.get_object, f"{take['prefix']}/{name}")
    if found is None:
        raise HTTPException(404, "file not found")
    body, content_type = found
    return Response(content=body, media_type=content_type,
                    headers={"Cache-Control": "private, max-age=604800, immutable"})
