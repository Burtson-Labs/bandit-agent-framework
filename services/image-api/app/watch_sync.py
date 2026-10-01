"""Every Studio take lands in watch (watch.burtson.ai), Mark's R2-backed library.

History takes (videos and images) and Productions takes are imported through
watch's server-to-server endpoint, ``POST /api/internal/studio/imports``, on the
cluster-internal service with the shared ``X-Watch-Service-Key``. Each take has
a stable tag, so imports are idempotent and safe to retry:

- History video take: ``studio:{jobId}:take{variant}``
- History image:      ``studio:{jobId}:image{variant}``
- Production take:    ``studio:{takeId}:take{takeIndex + 1}``

History takes go to watch's "Burtson Video Studio" collection; production takes
to one collection per production (key ``studio:production:{productionId}``),
titled ``E01 S02 Shot 03 · {shot} · take 1`` so they sort in story order.

The sync is pull-based. One pass (every ``WATCH_SYNC_SECONDS`` and right after
a job is recorded):

1. asks watch about takes not imported yet (``/lookup``), so anything already
   there (a retried import, an adopted hand import) is recorded, not uploaded;
2. imports what is still missing; network errors and 5xx back off
   1/5/15/30/60 min, a refusal (400/403/413) is recorded and not retried;
3. refreshes the state of imported takes: the current title in watch, or
   ``deleted`` when Mark deleted it there (deleted takes are never re-imported);
4. drops the local History MP4 once the watch copy has been confirmed for
   ``WATCH_DROP_LOCAL_MP4_DAYS`` days (0 keeps it). Thumbnails, posters, inputs
   and metadata stay in MinIO (Remix needs them); playback of a dropped take is
   served from watch.

State lives on the take: ``outputs[n].watch`` in the History item.json, and
``watch`` on the Productions take document.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import time
from datetime import UTC, datetime, timedelta
from typing import Any, Callable

import httpx

logger = logging.getLogger("burtson.image_api.watch")

DEFAULT_COLLECTION = None  # watch's default: "Burtson Video Studio" (key studio:default)
BACKOFF_MINUTES = (1, 5, 15, 30, 60)
LOOKUP_BATCH = 500
TAG_PART = re.compile(r"[^A-Za-z0-9._-]")
CONTENT_TYPES = {".mp4": "video/mp4", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp"}
PRESIGN_REUSE_SECONDS = 3 * 3600


class WatchError(Exception):
    pass


class WatchClient:
    """Thin client for watch's /api/internal/studio routes."""

    def __init__(self, base_url: str, service_key: str, *, transport: httpx.BaseTransport | None = None,
                 timeout: float = 300):
        self._client = httpx.Client(base_url=base_url.rstrip("/"), timeout=httpx.Timeout(timeout, connect=10),
                                    headers={"X-Watch-Service-Key": service_key}, transport=transport)

    def lookup(self, owner: str, tags: list[str], *, include_playback: bool = False) -> dict[str, dict]:
        found: dict[str, dict] = {}
        for start in range(0, len(tags), LOOKUP_BATCH):
            batch = tags[start:start + LOOKUP_BATCH]
            response = self._client.post("/api/internal/studio/lookup", json={
                "ownerId": owner, "importedFrom": batch, "includePlayback": include_playback})
            if response.status_code != 200:
                raise WatchError(f"lookup answered {response.status_code}")
            for item in response.json().get("items") or []:
                found[item["importedFrom"]] = item
        return found

    def import_file(self, metadata: dict, file_name: str, body: bytes, content_type: str) -> tuple[int, dict]:
        files = {
            "metadata": (None, json.dumps(metadata), "application/json"),
            "file": (file_name, body, content_type),
        }
        response = self._client.post("/api/internal/studio/imports", files=files)
        try:
            payload = response.json()
        except ValueError:
            payload = {"message": response.text[:300]}
        return response.status_code, payload

    def download(self, url: str) -> bytes:
        response = httpx.get(url, timeout=120)
        response.raise_for_status()
        return response.content


def now_utc() -> datetime:
    return datetime.now(UTC)


def history_tag(job_id: str, output: dict) -> str:
    number = int(output.get("variant") or output.get("index", 0) + 1)
    kind = "image" if output.get("kind") == "image" else "take"
    return f"studio:{TAG_PART.sub('-', job_id)[:120]}:{kind}{number}"


def production_tag(take: dict) -> str:
    return f"studio:{TAG_PART.sub('-', take['_id'])[:120]}:take{int(take.get('takeIndex') or 0) + 1}"


def short(text: str, limit: int) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def history_metadata(item: dict, output: dict, tag: str) -> dict:
    request = item.get("request") or {}
    number = int(output.get("variant") or output["index"] + 1)
    is_image = output.get("kind") == "image"
    many = len(item.get("outputs") or []) > 1
    title = short(item.get("prompt") or "Studio take", 90)
    if output.get("mode") == "people-swap":
        people = len(request.get("subjects") or []) or 1
        kind = "Replace" if request.get("mode") == "replace" else "Animate"
        title = f"Swap people · {kind} · {people} {'person' if people == 1 else 'people'}"
    if many:
        title += f" · {'image' if is_image else 'take'} {number}"
    extra = {k: str(v) for k, v in {
        "camera": request.get("camera"), "workflow": output.get("workflowVersion"),
        "durationSeconds": output.get("durationSeconds"), "upscaler": request.get("upscaler") if not is_image else None,
        "control": request.get("control"), "historyItem": item["id"],
    }.items() if v not in (None, "", "auto")}
    width, height = output.get("width"), output.get("height")
    return {
        "ownerId": item.get("owner"),
        "importedFrom": tag,
        "title": title,
        "studio": {
            "jobId": item["id"], "take": number,
            "mode": output.get("mode") or request.get("mode") or ("text-to-image" if is_image else None),
            "prompt": item.get("prompt") or request.get("prompt"),
            "model": output.get("model") or request.get("model"),
            "resolution": request.get("resolution") or (f"{width}x{height}" if width and height else None),
            "aspectRatio": request.get("aspect"),
            "seed": output.get("seed") if output.get("seed") is not None else request.get("seed"),
            "steps": request.get("steps"), "fps": output.get("fps"),
            "generatedAt": item.get("createdAt"), "extra": extra or None,
        },
    }


def production_title(production: dict | None, episode: dict | None, scene: dict | None, shot: dict | None,
                     take: dict) -> str:
    parts = []
    if episode:
        parts.append(f"E{int(episode.get('order') or 0):02d}")
    if scene:
        parts.append(f"S{int(scene.get('order') or 0):02d}")
    if shot:
        parts.append(f"Shot {int(shot.get('order') or 0):02d}")
    prefix = " ".join(parts)
    name = (shot or {}).get("title") or short(take.get("prompt") or "", 60) or "Shot"
    title = f"{prefix} · {name}" if prefix else name
    return f"{short(title, 170)} · take {int(take.get('takeIndex') or 0) + 1}"


def production_metadata(take: dict, production: dict | None, episode: dict | None, scene: dict | None,
                        shot: dict | None, tag: str) -> dict:
    production_id = take["productionId"]
    return {
        "ownerId": take.get("owner"),
        "importedFrom": tag,
        "title": production_title(production, episode, scene, shot, take),
        "collection": {"key": f"studio:production:{production_id}",
                       "name": short((production or {}).get("title") or "Production", 120),
                       "description": short((production or {}).get("logline") or "", 2000) or None},
        "studio": {
            "jobId": take["_id"], "take": int(take.get("takeIndex") or 0) + 1, "mode": take.get("mode"),
            "prompt": take.get("prompt"), "model": take.get("model"), "resolution": take.get("resolution"),
            "aspectRatio": (production or {}).get("aspect"), "seed": take.get("seed"), "fps": take.get("fps"),
            "productionId": production_id, "productionTitle": (production or {}).get("title"),
            "episodeId": take.get("episodeId"), "episodeTitle": (episode or {}).get("title"),
            "sceneId": take.get("sceneId"), "shotId": take.get("shotId"), "generatedAt": take.get("createdAt"),
            "extra": {k: str(v) for k, v in {
                "scene": (scene or {}).get("title"), "shot": (shot or {}).get("title"),
                "workflow": take.get("workflowVersion"), "shotRevision": take.get("shotRevision"),
                "durationSeconds": take.get("durationSeconds"),
            }.items() if v not in (None, "")} or None,
        },
    }


def watch_state(found: dict, *, now: datetime) -> dict:
    """The part of a lookup/import answer kept on the take."""
    state = {"state": found.get("state"), "tag": found.get("importedFrom"), "checkedAt": now.isoformat(),
             "error": None, "nextAttemptAt": None}
    for key in ("videoId", "url", "title", "kind", "collectionName", "deletedAt"):
        if found.get(key) is not None:
            state[key] = found[key]
    return state


class WatchSync:
    def __init__(self, library, client: WatchClient, *, productions_db: Callable[[], Any] | None = None,
                 read_production_object: Callable[[str], bytes | None] | None = None,
                 drop_after_days: float = 7, interval_seconds: float = 60, clock: Callable[[], datetime] = now_utc):
        self.library = library
        self.client = client
        self.productions_db = productions_db or (lambda: None)
        self.read_production_object = read_production_object
        self.drop_after = timedelta(days=drop_after_days) if drop_after_days > 0 else None
        self.interval = interval_seconds
        self.clock = clock
        self._event: asyncio.Event | None = None
        self._task: asyncio.Task | None = None
        self._run_lock = threading.Lock()
        self._playback: dict[str, tuple[float, str]] = {}
        self.last_pass: dict = {}
        library.remote_file = self.remote_file

    # --- running ----------------------------------------------------------------
    def start(self) -> None:
        self._event = asyncio.Event()
        self._task = asyncio.create_task(self._run())

    def stop(self) -> None:
        if self._task:
            self._task.cancel()

    def kick(self) -> None:
        if self._event is not None:
            self._event.set()

    async def _run(self) -> None:
        await asyncio.sleep(5)
        while True:
            try:
                await asyncio.to_thread(self.run_once)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("watch sync pass failed")
            try:
                assert self._event is not None
                await asyncio.wait_for(self._event.wait(), timeout=self.interval)
            except asyncio.TimeoutError:
                pass
            if self._event is not None:
                self._event.clear()

    def run_once(self) -> dict:
        """One full pass over History and Productions; returns counters."""
        if not self._run_lock.acquire(blocking=False):
            return {"skipped": "already running"}
        try:
            stats = {"imported": 0, "alreadyThere": 0, "deleted": 0, "failed": 0, "refused": 0, "dropped": 0,
                     "importedBytes": 0}
            for owner_key in self.library.owner_keys():
                self._sync_history(owner_key, stats)
            db = self.productions_db()
            if db is not None:
                self._sync_productions(db, stats)
            stats["at"] = self.clock().isoformat()
            self.last_pass = stats
            if any(stats[k] for k in ("imported", "deleted", "failed", "refused", "dropped")):
                logger.info("watch sync: %s", stats)
            return stats
        finally:
            self._run_lock.release()

    # --- History -----------------------------------------------------------------
    def _sync_history(self, owner_key: str, stats: dict) -> None:
        now = self.clock()
        pending: list[tuple[dict, dict, str]] = []
        imported: list[tuple[dict, dict, str]] = []
        owner = None
        for item in self.library.items_of(owner_key):
            if item.get("status") != "completed" or not item.get("owner"):
                continue
            owner = owner or item["owner"]
            for output in item.get("outputs") or []:
                tag = history_tag(item["id"], output)
                watch = output.get("watch") or {}
                if watch.get("state") == "present":
                    imported.append((item, output, tag))
                elif watch.get("state") in ("deleted", "refused"):
                    continue
                elif item.get("hidden") or output.get("hidden"):
                    continue  # discarded in History; imported if it is ever un-hidden
                elif not self._due(watch, now):
                    continue
                else:
                    pending.append((item, output, tag))
        if not owner:
            return

        def save(item: dict, output: dict, **changes: Any) -> None:
            self.library.set_output_state(owner_key, item["id"], output["index"], **changes)

        self._import_pending(owner, pending, stats, now, save=save,
                             load=lambda item, output: self._history_file(owner_key, item, output),
                             metadata=lambda item, output, tag: history_metadata(item, output, tag))
        self._refresh(owner, imported, stats, now, save=save)
        if self.drop_after is not None:
            for item, output, _tag in imported:
                self._maybe_drop(owner_key, item, output, now, stats)

    def _history_file(self, owner_key: str, item: dict, output: dict) -> tuple[str, bytes, str] | None:
        name = output.get("file")
        if not name:
            return None
        body = self.library.read_raw(owner_key, item["id"], name)
        if body is None:
            return None
        return name, body, CONTENT_TYPES.get(name[name.rfind("."):], "application/octet-stream")

    def _maybe_drop(self, owner_key: str, item: dict, output: dict, now: datetime, stats: dict) -> None:
        if output.get("kind") != "video" or output.get("localDropped") or not output.get("file"):
            return
        watch = output.get("watch") or {}
        imported_at = parse_time(watch.get("importedAt"))
        if watch.get("state") != "present" or imported_at is None or now - imported_at < self.drop_after:
            return
        self.library.drop_raw(owner_key, item["id"], output["file"])
        self.library.set_output_state(owner_key, item["id"], output["index"], localDropped=True)
        stats["dropped"] += 1

    # --- Productions ------------------------------------------------------------
    def _sync_productions(self, db, stats: dict) -> None:
        now = self.clock()
        takes = list(db.takes.find({"status": {"$ne": "rejected"}, "prefix": {"$exists": True}}))
        by_owner: dict[str, dict[str, list]] = {}
        for take in takes:
            watch = take.get("watch") or {}
            bucket = by_owner.setdefault(take.get("owner") or "", {"pending": [], "imported": []})
            tag = production_tag(take)
            if watch.get("state") == "present":
                bucket["imported"].append((take, take, tag))
            elif watch.get("state") in ("deleted", "refused") or not self._due(watch, now):
                continue
            else:
                bucket["pending"].append((take, take, tag))
        cache: dict[tuple[str, str], dict | None] = {}

        def doc(collection: str, doc_id: str | None) -> dict | None:
            if not doc_id:
                return None
            if (collection, doc_id) not in cache:
                cache[(collection, doc_id)] = db[collection].find_one({"_id": doc_id})
            return cache[(collection, doc_id)]

        def save(take: dict, _output: dict, **changes: Any) -> None:
            watch = {**(take.get("watch") or {}), **(changes.get("watch") or {})}
            take["watch"] = watch
            db.takes.update_one({"_id": take["_id"]}, {"$set": {"watch": watch}})

        def load(take: dict, _output: dict) -> tuple[str, bytes, str] | None:
            name = (take.get("files") or {}).get("video")
            if not name or self.read_production_object is None:
                return None
            body = self.read_production_object(f"{take['prefix']}/{name}")
            return (name, body, "video/mp4") if body is not None else None

        def metadata(take: dict, _output: dict, tag: str) -> dict:
            return production_metadata(take, doc("productions", take.get("productionId")),
                                       doc("episodes", take.get("episodeId")), doc("scenes", take.get("sceneId")),
                                       doc("shots", take.get("shotId")), tag)

        for owner, bucket in by_owner.items():
            if not owner:
                continue
            self._import_pending(owner, bucket["pending"], stats, now, save=save, load=load, metadata=metadata)
            self._refresh(owner, bucket["imported"], stats, now, save=save)

    # --- shared -------------------------------------------------------------------
    @staticmethod
    def _due(watch: dict, now: datetime) -> bool:
        next_at = parse_time(watch.get("nextAttemptAt"))
        return next_at is None or next_at <= now

    def _import_pending(self, owner: str, pending: list, stats: dict, now: datetime, *, save, load, metadata) -> None:
        if not pending:
            return
        try:
            known = self.client.lookup(owner, [tag for _, _, tag in pending])
        except Exception as exc:
            logger.warning("watch sync: lookup failed (%s); will retry", exc)
            return
        for item, output, tag in pending:
            found = known.get(tag) or {}
            if found.get("state") == "present":
                save(item, output, watch={**watch_state(found, now=now), "importedAt": now.isoformat()})
                stats["alreadyThere"] += 1
                continue
            if found.get("state") == "deleted":
                save(item, output, watch=watch_state(found, now=now))
                stats["deleted"] += 1
                continue
            file = load(item, output)
            if file is None:
                save(item, output, watch={"state": "refused", "tag": tag, "error": "the file is gone",
                                          "checkedAt": now.isoformat()})
                stats["refused"] += 1
                continue
            name, body, content_type = file
            attempts = int((output.get("watch") or {}).get("attempts") or 0) + 1
            try:
                status, payload = self.client.import_file(metadata(item, output, tag), name, body, content_type)
            except Exception as exc:
                status, payload = 0, {"message": f"{type(exc).__name__}: {exc}"[:300]}
            if status in (200, 201):
                save(item, output, watch={**watch_state(payload, now=now), "importedAt": now.isoformat(),
                                          "attempts": attempts})
                stats["imported" if status == 201 else "alreadyThere"] += 1
                if status == 201:
                    stats["importedBytes"] += len(body)
            elif status == 410:
                save(item, output, watch={**watch_state(payload, now=now), "attempts": attempts})
                stats["deleted"] += 1
            elif status in (400, 403, 413):
                save(item, output, watch={"state": "refused", "tag": tag, "attempts": attempts,
                                          "error": str(payload.get("message") or status)[:300],
                                          "checkedAt": now.isoformat()})
                stats["refused"] += 1
                logger.warning("watch sync: %s refused (%s): %s", tag, status, payload.get("message"))
            else:
                delay = BACKOFF_MINUTES[min(attempts, len(BACKOFF_MINUTES)) - 1]
                save(item, output, watch={"state": "pending", "tag": tag, "attempts": attempts,
                                          "error": str(payload.get("message") or status)[:300],
                                          "nextAttemptAt": (now + timedelta(minutes=delay)).isoformat(),
                                          "checkedAt": now.isoformat()})
                stats["failed"] += 1

    def _refresh(self, owner: str, imported: list, stats: dict, now: datetime, *, save) -> None:
        if not imported:
            return
        try:
            known = self.client.lookup(owner, [tag for _, _, tag in imported])
        except Exception as exc:
            logger.warning("watch sync: refresh failed (%s)", exc)
            return
        for item, output, tag in imported:
            found = known.get(tag)
            if not found or found.get("state") == "missing":
                continue  # never trust a gap: watch may be mid-deploy
            current = output.get("watch") or {}
            fresh = watch_state(found, now=now)
            if found.get("state") == "deleted":
                save(item, output, watch=fresh)
                stats["deleted"] += 1
            elif any(current.get(k) != fresh.get(k) for k in ("title", "collectionName", "url", "videoId")):
                save(item, output, watch=fresh)

    def remote_file(self, owner: str, output: dict) -> bytes | None:
        """A dropped History MP4, fetched from watch (presigned R2 URL, reused for 3 h)."""
        tag = (output.get("watch") or {}).get("tag")
        if not tag:
            return None
        cached = self._playback.get(tag)
        url = cached[1] if cached and cached[0] > time.time() else None
        if url is None:
            try:
                found = self.client.lookup(owner, [tag], include_playback=True).get(tag) or {}
            except Exception:
                return None
            url = found.get("mp4Url") or found.get("imageUrl")
            if not url:
                return None
            self._playback[tag] = (time.time() + PRESIGN_REUSE_SECONDS, url)
        try:
            return self.client.download(url)
        except Exception:
            self._playback.pop(tag, None)
            return None


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
