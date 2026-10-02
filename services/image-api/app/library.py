"""Durable per-user history of finished generations (Burtson Studio).

Job outputs are first written under ``v1/tenant/`` where the bucket lifecycle
and the app reaper delete them after ``ASSET_TTL_HOURS``. When a job reaches a
terminal state it is recorded here: its outputs, posters and inputs are copied
server-side to ``v1/library/{owner}/items/{jobId}/`` (outside both expiry
rules), a JPEG thumbnail is made for each take, and the entry is written to
``items/{jobId}/item.json`` next to them. Each item.json also holds the user's
own state for it: favourite, hidden (soft-deleted), per-take keep/discard and
projectId. Projects live in ``v1/library/{owner}/projects.json``.

Storage is one small object per item, so a write never rewrites the whole
history. Reads are served from an in-memory index built on first use per owner
(parallel GETs of every item.json), filtered and paged server-side. A legacy
single ``index.json`` (phase 1, 2026-10-01) is split into item.json files on
first load.

A backfill pass scans ``v1/tenant/`` for ``metadata.json`` files whose job is
not in the library yet, so outputs made before this module existed, or while
the service was restarting, are kept too. It runs at startup and before every
reaper sweep, so nothing is reaped before it has been copied.

The service runs as a single replica with an in-process queue, so one lock per
owner around read-modify-write is enough. If it ever scales out, item.json is
the source of truth and the in-memory index becomes a cache to invalidate.
"""
from __future__ import annotations

import io
import json
import logging
import posixpath
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Iterable, Protocol

from PIL import Image

logger = logging.getLogger("burtson.image_api.library")

TENANT_PREFIX = "v1/tenant/"
LIBRARY_PREFIX = "v1/library/"
ITEM_VERSION = 2
DEFAULT_PAGE = 60
MAX_PAGE = 200
THUMB_SIZE = (640, 640)
MAX_PROJECT_NAME = 80
MAX_PROJECTS = 200

INPUT_ROLES = {
    # request field -> (role, file stem)
    "referenceId": "reference",
    "endReferenceId": "end",
    "sourceVideoId": "source",
    "maskId": "mask",
}
# List field -> role stem; item n (0-based) is stored as {stem}{n + 2}
# (input-reference2.png, input-reference3.png, ...).
LIST_INPUT_ROLES = {"extraReferenceIds": "reference"}
FILE_NAME = re.compile(
    r"^(?:(?:image|thumb|poster|video)-\d{2}\.(?:png|jpg|mp4)"
    r"|audio-\d{2}\.(?:wav|mp3)|lyrics-\d{2}\.lrc"
    r"|input-(?:reference[2-9]?|end|source|mask|person-[1-4])\.(?:png|mp4)"
    r"|input-(?:music|logo|narration-\d{2})\.(?:wav|png)"
    r"|metadata\.json)$"
)
CONTENT_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".json": "application/json",
                 ".wav": "audio/wav", ".mp3": "audio/mpeg", ".lrc": "text/plain; charset=utf-8"}
# metadata.json "kind" -> History kind. A finished (mixed) video is a video take.
HISTORY_KIND = {"finish": "video"}


class ObjectStore(Protocol):
    def get(self, key: str) -> bytes | None: ...
    def put(self, key: str, body: bytes, content_type: str) -> None: ...
    def copy(self, source: str, target: str, content_type: str) -> bool: ...
    def list(self, prefix: str) -> Iterable[tuple[str, datetime | None]]: ...
    def delete(self, key: str) -> None: ...


class S3Store:
    """ObjectStore over a boto3 S3 client factory (MinIO)."""

    def __init__(self, client_factory, bucket: str):
        self._client = client_factory
        self._bucket = bucket

    def get(self, key: str) -> bytes | None:
        try:
            obj = self._client().get_object(Bucket=self._bucket, Key=key)
        except Exception as exc:
            if "NoSuchKey" in type(exc).__name__ or "NoSuchKey" in str(exc) or "404" in str(exc):
                return None
            raise
        return obj["Body"].read()

    def put(self, key: str, body: bytes, content_type: str) -> None:
        self._client().put_object(Bucket=self._bucket, Key=key, Body=io.BytesIO(body), ContentType=content_type)

    def copy(self, source: str, target: str, content_type: str) -> bool:
        try:
            # REPLACE drops the source's expires-at tag and metadata: library
            # copies are not working files.
            self._client().copy_object(
                Bucket=self._bucket, Key=target, CopySource={"Bucket": self._bucket, "Key": source},
                MetadataDirective="REPLACE", ContentType=content_type, TaggingDirective="REPLACE", Tagging="",
            )
        except Exception as exc:
            if "NoSuchKey" in type(exc).__name__ or "NoSuchKey" in str(exc) or "404" in str(exc):
                return False
            raise
        return True

    def delete(self, key: str) -> None:
        self._client().delete_object(Bucket=self._bucket, Key=key)

    def list(self, prefix: str) -> Iterable[tuple[str, datetime | None]]:
        paginator = self._client().get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self._bucket, Prefix=prefix):
            for item in page.get("Contents", []):
                yield item["Key"], item.get("LastModified")


def safe_owner(owner: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in owner).strip("-")
    return cleaned[:100] or "unknown"


def content_type_for(name: str) -> str:
    return CONTENT_TYPES.get(posixpath.splitext(name)[1], "application/octet-stream")


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


class LibraryError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


@dataclass
class TakeFile:
    source_key: str
    name: str


class Library:
    def __init__(self, store: ObjectStore):
        self.store = store
        self._cache: dict[str, dict] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()
        # Set by the watch sync: fetches a take's file from watch once the local copy was dropped.
        self.remote_file: Any = None

    # --- index ------------------------------------------------------------
    def _lock(self, owner_key: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(owner_key, threading.Lock())

    @staticmethod
    def _prefix(owner_key: str) -> str:
        return f"{LIBRARY_PREFIX}{owner_key}"

    def item_key(self, owner: str, job_id: str, name: str) -> str:
        return f"{self._prefix(safe_owner(owner))}/items/{job_id}/{name}"

    def _item_object(self, owner_key: str, job_id: str) -> str:
        return f"{self._prefix(owner_key)}/items/{job_id}/item.json"

    def _load(self, owner_key: str) -> dict:
        cached = self._cache.get(owner_key)
        if cached is not None:
            return cached
        prefix = self._prefix(owner_key)
        keys = [key for key, _ in self.store.list(f"{prefix}/items/") if key.endswith("/item.json")]
        projects_raw = self.store.get(f"{prefix}/projects.json")
        index: dict = {"items": {}, "projects": json.loads(projects_raw) if projects_raw else {}}
        if keys:
            with ThreadPoolExecutor(max_workers=16) as pool:
                for raw in pool.map(self.store.get, keys):
                    if raw:
                        item = json.loads(raw)
                        index["items"][item["id"]] = item
        elif projects_raw is None:
            legacy = self.store.get(f"{prefix}/index.json")
            if legacy:
                # Phase-1 single-document index: split it into item.json files.
                old = json.loads(legacy)
                index["projects"] = old.get("projects") or {}
                index["items"] = old.get("items") or {}
                for item in index["items"].values():
                    self._put_item(owner_key, item)
                self._put_projects(owner_key, index)
                logger.info("library: migrated %d item(s) from index.json", len(index["items"]))
        self._cache[owner_key] = index
        return index

    def _put_item(self, owner_key: str, item: dict) -> None:
        item["version"] = ITEM_VERSION
        self.store.put(self._item_object(owner_key, item["id"]),
                       json.dumps(item, separators=(",", ":")).encode(), "application/json")

    def _put_projects(self, owner_key: str, index: dict) -> None:
        self.store.put(f"{self._prefix(owner_key)}/projects.json",
                       json.dumps(index["projects"], separators=(",", ":")).encode(), "application/json")

    def _owned_item(self, index: dict, owner: str, job_id: str) -> dict:
        item = index["items"].get(job_id)
        if item is None:
            raise LibraryError(404, "history item not found")
        if item.get("owner") not in (None, owner):
            raise LibraryError(403, "history item belongs to another user")
        return item

    # --- reads ------------------------------------------------------------
    def list(self, owner: str, *, q: str = "", kind: str | None = None, model: str | None = None,
             status: str | None = None, since: str | None = None, view: str = "all",
             include_hidden: bool = False, limit: int = DEFAULT_PAGE, cursor: str | None = None) -> dict:
        """One page of the caller's items, newest first, plus sidebar counts.

        ``view``: all | favorites | unassigned | project:<id>. ``status``:
        completed | failed (failed or cancelled). ``cursor`` is the opaque
        ``nextCursor`` of the previous page.
        """
        owner_key = safe_owner(owner)
        with self._lock(owner_key):
            index = self._load(owner_key)
            mine = [item for item in index["items"].values() if item.get("owner") in (None, owner)]
            projects = sorted(index["projects"].values(), key=lambda project: project["name"].lower())
        visible = [item for item in mine if include_hidden or not item.get("hidden")]
        by_project: dict[str, int] = {}
        for item in visible:
            if item.get("projectId"):
                by_project[item["projectId"]] = by_project.get(item["projectId"], 0) + 1
        counts = {"all": len(visible), "favorites": sum(1 for item in visible if starred(item)),
                  "unassigned": sum(1 for item in visible if not item.get("projectId")), "byProject": by_project}
        needle = q.strip().lower()
        since_dt = parse_time(since)

        def keep(item: dict) -> bool:
            if view == "favorites" and not starred(item):
                return False
            if view == "unassigned" and item.get("projectId"):
                return False
            if view.startswith("project:") and item.get("projectId") != view[8:]:
                return False
            if kind and item.get("kind") != kind:
                return False
            if model and item.get("model") != model:
                return False
            if status == "completed" and item.get("status") != "completed":
                return False
            if status == "failed" and item.get("status") == "completed":
                return False
            if since_dt and (parse_time(item.get("createdAt")) or since_dt) < since_dt:
                return False
            return not needle or needle in (item.get("prompt") or "").lower() or item["id"].startswith(needle)

        matches = sorted((item for item in visible if keep(item)), key=sort_key, reverse=True)
        total = len(matches)
        if cursor:
            matches = [item for item in matches if sort_key(item) < tuple(cursor.split("|", 1))]
        limit = max(1, min(limit, MAX_PAGE))
        page = matches[:limit]
        return {
            "items": [public_item(item) for item in page],
            "projects": projects,
            "total": total,
            "nextCursor": "|".join(sort_key(page[-1])) if len(matches) > limit else None,
            "counts": counts,
            "models": sorted({item["model"] for item in mine if item.get("model")}),
        }

    def get_item(self, owner: str, job_id: str) -> dict:
        owner_key = safe_owner(owner)
        with self._lock(owner_key):
            return public_item(self._owned_item(self._load(owner_key), owner, job_id))

    def has(self, owner: str, job_id: str) -> bool:
        owner_key = safe_owner(owner)
        with self._lock(owner_key):
            return job_id in self._load(owner_key)["items"]

    def read_file(self, owner: str, job_id: str, name: str) -> tuple[bytes, str]:
        if not FILE_NAME.match(name):
            raise LibraryError(404, "file not found")
        owner_key = safe_owner(owner)
        with self._lock(owner_key):
            item = self._owned_item(self._load(owner_key), owner, job_id)
        known = set(item.get("assetFiles") or []) | set((item.get("inputs") or {}).values())
        known |= {output.get("thumb") for output in item.get("outputs") or []}
        known.add("metadata.json")
        if name not in known:
            raise LibraryError(404, "file not found")
        body = self.store.get(self.item_key(owner, job_id, name))
        if body is None and self.remote_file is not None:
            # The MP4 may have been dropped here after its import to watch was confirmed.
            output = next((o for o in item.get("outputs") or [] if o.get("file") == name), None)
            if output is not None and (output.get("watch") or {}).get("state") == "present":
                body = self.remote_file(owner, output)
        if body is None:
            raise LibraryError(404, "file not found")
        return body, content_type_for(name)

    def legacy_asset(self, owner: str, job_id: str, index: int) -> tuple[bytes, str] | None:
        """Serve /api/images/jobs/{id}/assets/{index} after the in-memory job is gone."""
        owner_key = safe_owner(owner)
        with self._lock(owner_key):
            item = self._load(owner_key)["items"].get(job_id)
        if item is None or item.get("owner") not in (None, owner):
            return None
        files = item.get("assetFiles") or []
        if index < 0 or index >= len(files):
            return None
        body = self.store.get(self.item_key(owner, job_id, files[index]))
        return (body, content_type_for(files[index])) if body is not None else None

    # --- watch sync ---------------------------------------------------------
    def owner_keys(self) -> list[str]:
        """Every owner folder that has library items."""
        keys = set()
        for key, _ in self.store.list(LIBRARY_PREFIX):
            rest = key[len(LIBRARY_PREFIX):]
            if "/items/" in rest and rest.endswith("/item.json"):
                keys.add(rest.split("/", 1)[0])
        return sorted(keys)

    def items_of(self, owner_key: str) -> list[dict]:
        """Deep copies of one owner folder's items (for the sync to read without the lock)."""
        with self._lock(owner_key):
            return json.loads(json.dumps(list(self._load(owner_key)["items"].values())))

    def set_output_state(self, owner_key: str, job_id: str, index: int, **changes: Any) -> None:
        """Merge sync state (``watch``, ``localDropped``) into one take; one item.json write."""
        with self._lock(owner_key):
            item = self._load(owner_key)["items"].get(job_id)
            if item is None:
                return
            output = next((o for o in item.get("outputs") or [] if o["index"] == index), None)
            if output is None:
                return
            for key, value in changes.items():
                if key == "watch" and isinstance(value, dict):
                    output["watch"] = {**(output.get("watch") or {}), **value}
                else:
                    output[key] = value
            self._put_item(owner_key, item)

    def read_raw(self, owner_key: str, job_id: str, name: str) -> bytes | None:
        return self.store.get(f"{self._prefix(owner_key)}/items/{job_id}/{name}")

    def drop_raw(self, owner_key: str, job_id: str, name: str) -> None:
        self.store.delete(f"{self._prefix(owner_key)}/items/{job_id}/{name}")

    # --- user state ---------------------------------------------------------
    def update_item(self, owner: str, job_id: str, changes: dict) -> dict:
        owner_key = safe_owner(owner)
        with self._lock(owner_key):
            index = self._load(owner_key)
            item = self._owned_item(index, owner, job_id)
            for flag in ("favorite", "hidden"):
                if flag in changes and changes[flag] is not None:
                    item[flag] = bool(changes[flag])
            if "projectId" in changes:
                project_id = changes["projectId"]
                if project_id is not None and project_id not in index["projects"]:
                    raise LibraryError(404, "project not found")
                item["projectId"] = project_id
            for change in changes.get("outputs") or []:
                output = next((o for o in item.get("outputs") or [] if o["index"] == change.get("index")), None)
                if output is None:
                    raise LibraryError(404, f"take {change.get('index')} not found")
                for flag in ("favorite", "hidden"):
                    if change.get(flag) is not None:
                        output[flag] = bool(change[flag])
            item["updatedAt"] = now_iso()
            self._put_item(owner_key, item)
            return public_item(item)

    def create_project(self, owner: str, name: str) -> dict:
        name = clean_name(name)
        owner_key = safe_owner(owner)
        with self._lock(owner_key):
            index = self._load(owner_key)
            if len(index["projects"]) >= MAX_PROJECTS:
                raise LibraryError(400, f"at most {MAX_PROJECTS} projects")
            project = {"id": uuid.uuid4().hex[:12], "name": name, "createdAt": now_iso(), "updatedAt": now_iso()}
            index["projects"][project["id"]] = project
            self._put_projects(owner_key, index)
            return project

    def rename_project(self, owner: str, project_id: str, name: str) -> dict:
        name = clean_name(name)
        owner_key = safe_owner(owner)
        with self._lock(owner_key):
            index = self._load(owner_key)
            project = index["projects"].get(project_id)
            if project is None:
                raise LibraryError(404, "project not found")
            project.update(name=name, updatedAt=now_iso())
            self._put_projects(owner_key, index)
            return project

    def delete_project(self, owner: str, project_id: str) -> dict:
        """Remove a project; its items stay in history without a project."""
        owner_key = safe_owner(owner)
        with self._lock(owner_key):
            index = self._load(owner_key)
            if index["projects"].pop(project_id, None) is None:
                raise LibraryError(404, "project not found")
            moved = 0
            for item in index["items"].values():
                if item.get("projectId") == project_id:
                    item["projectId"] = None
                    self._put_item(owner_key, item)
                    moved += 1
            self._put_projects(owner_key, index)
            return {"deleted": project_id, "itemsUnassigned": moved}

    # --- ingestion ----------------------------------------------------------
    def record(self, metadata: dict, *, status: str = "completed", tenant_dir: str | None = None,
               input_keys: dict[str, str] | None = None, started_at: str | None = None,
               completed_at: str | None = None) -> dict | None:
        """Copy a finished job's files into the library and index it.

        ``metadata`` has the shape of the job's ``metadata.json`` (jobId, owner,
        createdAt, request, images|videos, error). Idempotent: recording a job
        again keeps the user's favourite/hidden/project state on it.
        """
        job_id = metadata.get("jobId")
        owner = metadata.get("owner") or "unknown"
        if not job_id:
            return None
        owner_key = safe_owner(owner)
        request = dict(metadata.get("request") or {})
        request.pop("plan", None)
        kind = metadata.get("kind") or ("video" if metadata.get("videos") else
                                        "audio" if metadata.get("audios") else "image")
        kind = HISTORY_KIND.get(kind, kind)
        takes, asset_files = self._copy_outputs(owner, job_id, kind, metadata, tenant_dir) if status == "completed" else ([], [])
        inputs = self._copy_inputs(owner, job_id, request, input_keys or {})
        inputs.update(self._copy_named_inputs(owner, job_id, metadata.get("inputFiles") or {}))
        if status == "completed":
            self.store.put(self.item_key(owner, job_id, "metadata.json"),
                           json.dumps(metadata, indent=2).encode(), "application/json")
        entry = {
            "id": job_id, "owner": owner, "kind": kind, "status": status,
            "createdAt": metadata.get("createdAt") or now_iso(),
            "startedAt": started_at, "completedAt": completed_at or now_iso(),
            "prompt": request.get("prompt") or request.get("text") or request.get("title") or "",
            "model": request.get("model"), "title": request.get("title"),
            "mode": takes[0].get("mode") if takes else request.get("mode"),
            "request": request, "outputs": takes, "assetFiles": asset_files, "inputs": inputs,
            "error": metadata.get("error"), "persistedAt": now_iso(),
        }
        with self._lock(owner_key):
            index = self._load(owner_key)
            previous = index["items"].get(job_id)
            if previous:
                for flag in ("favorite", "hidden", "projectId"):
                    entry[flag] = previous.get(flag)
                states = {output["index"]: output for output in previous.get("outputs") or []}
                for output in entry["outputs"]:
                    old = states.get(output["index"])
                    if old:
                        output["favorite"] = old.get("favorite", False)
                        output["hidden"] = old.get("hidden", False)
                        for key in ("watch", "localDropped"):
                            if key in old:
                                output[key] = old[key]
            else:
                entry.update(favorite=False, hidden=False, projectId=None)
            index["items"][job_id] = entry
            self._put_item(owner_key, entry)
        return public_item(entry)

    def _copy_outputs(self, owner: str, job_id: str, kind: str, metadata: dict,
                      tenant_dir: str | None) -> tuple[list[dict], list[str]]:
        takes: list[dict] = []
        asset_files: list[str] = []
        if kind == "video":
            for position, video in enumerate(metadata.get("videos") or []):
                number = int(video.get("variant") or position + 1)
                files = [TakeFile(f"{tenant_dir}/video-{number:02d}.mp4", f"video-{number:02d}.mp4"),
                         TakeFile(f"{tenant_dir}/poster-{number:02d}.jpg", f"poster-{number:02d}.jpg")]
                if not self._copy_all(owner, job_id, files):
                    logger.warning("library: video take %s of %s is gone; skipped", number, job_id)
                    continue
                asset_files += [f.name for f in files]
                thumb = self._thumbnail(owner, job_id, files[1].name, number)
                extra = {key: video[key] for key in ("mix", "sourceItemId", "sourceTake") if video.get(key) is not None}
                takes.append({
                    **extra,
                    "index": position, "variant": number, "kind": "video",
                    "file": files[0].name, "poster": files[1].name, "thumb": thumb,
                    "width": video.get("width"), "height": video.get("height"), "seed": video.get("seed"),
                    "fps": video.get("fps"), "durationSeconds": video.get("durationSeconds"),
                    "frames": video.get("frames"), "bytes": video.get("bytes"), "sha256": video.get("sha256"),
                    "model": video.get("model"), "workflowVersion": video.get("workflowVersion"),
                    "mode": video.get("mode"), "favorite": False, "hidden": False,
                    **({"swap": video["swap"]} if video.get("swap") else {}),
                })
        elif kind == "audio":
            for position, audio in enumerate(metadata.get("audios") or []):
                number = int(audio.get("variant") or position + 1)
                # The waveform image is the take's thumbnail.
                files = [TakeFile(f"{tenant_dir}/audio-{number:02d}.wav", f"audio-{number:02d}.wav"),
                         TakeFile(f"{tenant_dir}/audio-{number:02d}.mp3", f"audio-{number:02d}.mp3"),
                         TakeFile(f"{tenant_dir}/wave-{number:02d}.jpg", f"thumb-{number:02d}.jpg")]
                if not self._copy_all(owner, job_id, files):
                    logger.warning("library: audio take %s of %s is gone; skipped", number, job_id)
                    continue
                asset_files += [f.name for f in files]
                song = {}
                if audio.get("lyrics"):
                    song["lyrics"] = audio["lyrics"]
                    lrc = TakeFile(f"{tenant_dir}/lyrics-{number:02d}.lrc", f"lyrics-{number:02d}.lrc")
                    if audio["lyrics"].get("lines") and self._copy_all(owner, job_id, [lrc]):
                        asset_files.append(lrc.name)
                        song["lrc"] = lrc.name
                if audio.get("naturalEnding") is not None:
                    song["naturalEnding"] = audio["naturalEnding"]
                takes.append({
                    **song,
                    "index": position, "variant": number, "kind": "audio",
                    "file": files[0].name, "mp3": files[1].name, "poster": None, "thumb": files[2].name,
                    "seed": audio.get("seed"), "durationSeconds": audio.get("durationSeconds"),
                    "bytes": audio.get("bytes"), "sha256": audio.get("sha256"), "lufs": audio.get("lufs"),
                    "truePeak": audio.get("truePeak"), "sampleRate": audio.get("sampleRate"),
                    "model": audio.get("model"), "workflowVersion": audio.get("workflowVersion"),
                    "mode": audio.get("mode"), "bpm": audio.get("bpm"), "keyscale": audio.get("keyscale"),
                    "instrumental": audio.get("instrumental"), "loopable": audio.get("loopable"),
                    "title": audio.get("title"), "text": audio.get("text"), "voice": audio.get("voice"),
                    "favorite": False, "hidden": False,
                })
        else:
            for position, image in enumerate(metadata.get("images") or []):
                number = position + 1
                name = f"image-{number:02d}.png"
                source = image.get("key") or f"{tenant_dir}/{name}"
                if not self._copy_all(owner, job_id, [TakeFile(source, name)]):
                    logger.warning("library: image %s of %s is gone; skipped", number, job_id)
                    continue
                asset_files.append(name)
                thumb = self._thumbnail(owner, job_id, name, number)
                takes.append({
                    "index": position, "variant": number, "kind": "image", "file": name, "poster": None,
                    "thumb": thumb, "width": image.get("width"), "height": image.get("height"),
                    "seed": image.get("seed"), "model": image.get("model"),
                    "workflowVersion": image.get("workflowVersion"), "mode": image.get("mode"),
                    "favorite": False, "hidden": False,
                })
        return takes, asset_files

    def _copy_all(self, owner: str, job_id: str, files: list[TakeFile]) -> bool:
        # Server-side copies are cheap and idempotent, so re-recording simply
        # copies again rather than checking what is already there.
        for take_file in files:
            target = self.item_key(owner, job_id, take_file.name)
            if not self.store.copy(take_file.source_key, target, content_type_for(take_file.name)):
                return False
        return True

    def _thumbnail(self, owner: str, job_id: str, source_name: str, number: int) -> str | None:
        name = f"thumb-{number:02d}.jpg"
        body = self.store.get(self.item_key(owner, job_id, source_name))
        if body is None:
            return None
        try:
            with Image.open(io.BytesIO(body)) as image:
                image = image.convert("RGB")
                image.thumbnail(THUMB_SIZE)
                output = io.BytesIO()
                image.save(output, format="JPEG", quality=82, optimize=True)
        except Exception as exc:  # a broken thumbnail never blocks persistence
            logger.warning("library: thumbnail for %s failed: %s", job_id, type(exc).__name__)
            return None
        self.store.put(self.item_key(owner, job_id, name), output.getvalue(), "image/jpeg")
        return name

    def _copy_inputs(self, owner: str, job_id: str, request: dict, input_keys: dict[str, str]) -> dict[str, str]:
        inputs: dict[str, str] = {}
        roles = [(request.get(field), role) for field, role in INPUT_ROLES.items()]
        # People swap: one photo per person (input-person-1.png ...).
        roles += [(subject.get("referenceId"), f"person-{number}")
                  for number, subject in enumerate(request.get("subjects") or [], start=1)
                  if isinstance(subject, dict)][:4]
        for reference_id, role in roles:
            source = input_keys.get(reference_id) if reference_id else None
            if not source:
                continue
            name = f"input-{role}{posixpath.splitext(source)[1] or '.png'}"
            if self.store.copy(source, self.item_key(owner, job_id, name), content_type_for(name)):
                inputs[role] = name
        for field, stem in LIST_INPUT_ROLES.items():
            for position, reference_id in enumerate(request.get(field) or []):
                source = input_keys.get(reference_id) if isinstance(reference_id, str) else None
                if not source:
                    continue
                role = f"{stem}{position + 2}"
                name = f"input-{role}{posixpath.splitext(source)[1] or '.png'}"
                if self.store.copy(source, self.item_key(owner, job_id, name), content_type_for(name)):
                    inputs[role] = name
        return inputs

    def _copy_named_inputs(self, owner: str, job_id: str, files: dict[str, str]) -> dict[str, str]:
        """Inputs a job lists itself (``inputFiles``: History name -> working key), e.g. a
        finish job's narration takes, music and logo, kept so the mix can be redone."""
        inputs: dict[str, str] = {}
        for name, source in files.items():
            if not FILE_NAME.match(name) or not name.startswith("input-") or not source:
                continue
            if self.store.copy(source, self.item_key(owner, job_id, name), content_type_for(name)):
                inputs[posixpath.splitext(name[len("input-"):])[0]] = name
        return inputs

    def backfill(self, owner: str | None = None) -> list[str]:
        """Record every job under v1/tenant/ (optionally one owner's) not yet in the library.

        Returns the tenant job directories that could not be recorded, which
        the reaper must leave alone this pass.
        """
        prefix = TENANT_PREFIX + (f"{safe_owner(owner)}/" if owner else "")
        metadata_keys: list[tuple[str, datetime | None]] = []
        reference_keys: dict[str, str] = {}
        for key, modified in self.store.list(prefix):
            if key.endswith("/metadata.json"):
                metadata_keys.append((key, modified))
            elif "/references/" in key:
                stem = posixpath.splitext(posixpath.basename(key))[0]
                reference_keys[stem] = key
        recorded = 0
        failed: list[str] = []
        for key, modified in metadata_keys:
            try:
                raw = self.store.get(key)
                if raw is None:
                    continue
                metadata = json.loads(raw)
                job_id, job_owner = metadata.get("jobId"), metadata.get("owner") or "unknown"
                if not job_id or self.has(job_owner, job_id):
                    continue
                self.record(metadata, tenant_dir=posixpath.dirname(key), input_keys=reference_keys,
                            completed_at=modified.isoformat() if modified else None)
                recorded += 1
            except Exception:
                logger.exception("library: backfill of %s failed", key)
                failed.append(posixpath.dirname(key))
        if recorded:
            logger.info("library: backfilled %d job(s)", recorded)
        return failed


def starred(item: dict) -> bool:
    return bool(item.get("favorite")) or any(output.get("favorite") for output in item.get("outputs") or [])


def sort_key(item: dict) -> tuple[str, str]:
    return (item.get("createdAt") or "", item["id"])


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def clean_name(name: str) -> str:
    cleaned = " ".join((name or "").split())
    if not cleaned:
        raise LibraryError(400, "project name is required")
    if len(cleaned) > MAX_PROJECT_NAME:
        raise LibraryError(400, f"project names are at most {MAX_PROJECT_NAME} characters")
    return cleaned


def public_item(item: dict) -> dict:
    value = {key: content for key, content in item.items() if key not in {"owner", "assetFiles"}}
    # Older seeds reach 2^62; browsers parse JSON numbers as doubles.
    value["outputs"] = [{**output, "seedText": None if output.get("seed") is None else str(output["seed"])}
                        for output in item.get("outputs") or []]
    seed = (item.get("request") or {}).get("seed")
    value["seedText"] = None if seed is None else str(seed)
    started, completed = item.get("startedAt"), item.get("completedAt")
    if started and completed:
        try:
            value["elapsedSeconds"] = round(
                (datetime.fromisoformat(completed) - datetime.fromisoformat(started)).total_seconds(), 1)
        except ValueError:
            pass
    return value


def job_metadata(job: Any) -> dict:
    """metadata.json-shaped record for a live Job (also used for failed/cancelled jobs)."""
    value: dict[str, Any] = {
        "jobId": job.id, "owner": job.owner, "createdAt": job.createdAt, "kind": job.kind,
        "request": job.request, "error": job.error,
    }
    if job.kind in ("video", "finish"):
        value["videos"] = job.videos
    elif job.kind == "audio":
        value["audios"] = job.audios
    else:
        value["images"] = job.images
    if getattr(job, "inputFiles", None):
        value["inputFiles"] = job.inputFiles
    return value
