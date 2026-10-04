"""Productions state in Mongo: series -> episode -> scene -> shot -> take, plus the durable job queue.

Everything here is synchronous pymongo (callers use asyncio.to_thread) so the
unit tests run against mongomock. Writes use the database's write concern; the
production client is created with ``w="majority"``.

Job ids are deterministic (``tk_`` + sha256(shot|revision|take)[:24]) so queueing
the same shot revision twice is a no-op, and the take a job produces carries the
same id. Editing anything that changes the render bumps the shot's revision,
which cancels its queued jobs from older revisions and gives new takes new ids.
"""
from __future__ import annotations

import hashlib
import random
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any, Callable, Iterable

from pymongo import ASCENDING, DESCENDING, ReturnDocument
from pymongo.errors import DuplicateKeyError

from . import schedule

JS_SAFE_SEED = 2**53 - 100_000
PENDING = ("queued", "leased", "submitted", "running")
IN_FLIGHT = ("leased", "submitted", "running")
MAX_ATTEMPTS = 5
FREE_LOST_ATTEMPTS = 2
# Back off 1 -> 5 -> 15 -> 30 min between transient failures (design §4.5).
BACKOFF_SECONDS = (60, 300, 900, 1800)
PRIORITY_DEFAULT = 50
PRIORITY_REDO = 60

CAMERAS = ("auto", "static", "push-in", "pull-out", "orbit-left", "orbit-right",
           "pan-left", "pan-right", "tilt-up", "crane-up")
MODELS = ("video-quality", "video-fast")
RESOLUTIONS = ("480p", "720p", "1080p")
ASPECTS = ("16:9", "9:16", "1:1")
# Fields whose change alters what gets rendered (and so bumps the revision).
RENDER_FIELDS = ("prompt", "camera", "durationSeconds", "model", "resolution", "accelerated", "preserveText",
                 "keyframe", "endFrame")
DEFAULTS = {"model": "video-quality", "resolution": "720p", "durationSeconds": 5.0, "takes": 2,
            "camera": "auto", "accelerated": None}

Estimator = Callable[[dict], dict]


class ProductionsError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def utcnow() -> datetime:
    return datetime.now(UTC)


def iso(value: datetime | None) -> str | None:
    return value.astimezone(UTC).isoformat() if value else None


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


def job_id_for(shot_id: str, revision: int, take_index: int) -> str:
    digest = hashlib.sha256(f"{shot_id}|{revision}|{take_index}".encode()).hexdigest()
    return "tk_" + digest[:24]


def clean_text(value: Any, limit: int, *, required: bool = False, field: str = "value") -> str:
    text = str(value or "").strip()
    if required and not text:
        raise ProductionsError(400, f"{field} is required")
    if len(text) > limit:
        raise ProductionsError(400, f"{field} is longer than {limit} characters")
    return text


def clean_defaults(value: dict | None, base: dict | None = None) -> dict:
    merged = {**DEFAULTS, **(base or {}), **{k: v for k, v in (value or {}).items() if k in DEFAULTS}}
    if merged["model"] not in MODELS:
        raise ProductionsError(400, f"model must be one of {', '.join(MODELS)}")
    if merged["resolution"] not in RESOLUTIONS:
        raise ProductionsError(400, f"resolution must be one of {', '.join(RESOLUTIONS)}")
    if merged["camera"] not in CAMERAS:
        raise ProductionsError(400, "unknown camera move")
    merged["durationSeconds"] = clamp_duration(merged["durationSeconds"])
    merged["takes"] = clamp_takes(merged["takes"])
    if merged["accelerated"] is not None:
        merged["accelerated"] = bool(merged["accelerated"])
    return merged


OPT_IN_1080P = ("1080p is an explicit opt-in: it takes about 20-40% longer per take than 720p. "
                "Confirm it (confirm1080p: true) to use it.")


def require_1080p_opt_in(new: str | None, old: str | None, body: dict) -> None:
    """1080p is never a default and never chosen silently (product rule)."""
    if new == "1080p" and old != "1080p" and not body.get("confirm1080p"):
        raise ProductionsError(400, OPT_IN_1080P)


def clamp_duration(value: Any) -> float:
    try:
        seconds = float(value)
    except (TypeError, ValueError) as exc:
        raise ProductionsError(400, "durationSeconds must be a number") from exc
    # A shot is one native Wan pass: no chaining inside a shot (design §1).
    if not 2 <= seconds <= 5:
        raise ProductionsError(400, "a shot is 2 to 5 seconds")
    return round(seconds, 2)


def clamp_takes(value: Any) -> int:
    try:
        takes = int(value)
    except (TypeError, ValueError) as exc:
        raise ProductionsError(400, "takes must be a whole number") from exc
    if not 1 <= takes <= 4:
        raise ProductionsError(400, "takes must be between 1 and 4")
    return takes


def classify_error(message: str | None) -> str:
    """Map an image-api failure to the retry policy's error class (design §4.5)."""
    text = (message or "").lower()
    if "out of memory" in text or "outofmemory" in text or "cuda error: out" in text:
        return "oom"
    if "exceeded" in text and "variant" in text or "timed out" in text or "stalled" in text:
        return "timeout"
    if "rejected the video workflow" in text or "invalid" in text:
        return "invalid"
    return "transient"


class Store:
    def __init__(self, db, *, estimator: Estimator, clock: Callable[[], datetime] = utcnow,
                 rng: random.Random | None = None):
        self.db = db
        self.estimator = estimator
        self.clock = clock
        self.rng = rng or random.SystemRandom()

    # --- setup -----------------------------------------------------------------
    def ensure_indexes(self) -> None:
        self.db.jobs.create_index([("status", ASCENDING), ("priority", DESCENDING), ("episodeOrder", ASCENDING),
                                  ("pipelineKey", ASCENDING), ("createdAt", ASCENDING)])
        self.db.jobs.create_index([("lease.expiresAt", ASCENDING)])
        self.db.jobs.create_index([("shotId", ASCENDING), ("status", ASCENDING)])
        self.db.jobs.create_index([("productionId", ASCENDING), ("status", ASCENDING)])
        self.db.shots.create_index([("productionId", ASCENDING), ("episodeId", ASCENDING),
                                   ("sceneId", ASCENDING), ("order", ASCENDING)])
        self.db.takes.create_index([("shotId", ASCENDING), ("status", ASCENDING)])
        self.db.takes.create_index([("productionId", ASCENDING)])
        self.db.episodes.create_index([("productionId", ASCENDING), ("order", ASCENDING)])
        self.db.scenes.create_index([("productionId", ASCENDING), ("episodeId", ASCENDING), ("order", ASCENDING)])
        self.db.productions.create_index([("owner", ASCENDING), ("createdAt", DESCENDING)])

    # --- settings, sessions, health ---------------------------------------------
    def settings(self) -> dict:
        doc = self.db.settings.find_one({"_id": "global"}) or {}
        doc.pop("_id", None)
        return {**schedule.DEFAULT_SETTINGS, **doc}

    def update_settings(self, changes: dict) -> dict:
        allowed = set(schedule.DEFAULT_SETTINGS)
        current = self.settings()
        candidate = {k: current.get(k) for k in allowed}
        candidate.update({k: v for k, v in changes.items() if k in allowed})
        if "paused" in changes and not changes["paused"]:
            candidate["pausedReason"] = None
        try:
            clean = schedule.validate(candidate)
        except ValueError as exc:
            raise ProductionsError(400, str(exc)) from exc
        self.db.settings.update_one({"_id": "global"}, {"$set": clean}, upsert=True)
        return self.settings()

    def pause(self, reason: str | None = None) -> dict:
        self.db.settings.update_one({"_id": "global"}, {"$set": {
            "paused": True, "pausedReason": clean_text(reason or "Paused by you", 300)}}, upsert=True)
        return self.settings()

    def resume(self) -> dict:
        self.db.settings.update_one({"_id": "global"}, {"$set": {"paused": False, "pausedReason": None}},
                                    upsert=True)
        return self.settings()

    def start_session(self, minutes: int) -> dict:
        if not 1 <= int(minutes) <= 600:
            raise ProductionsError(400, "minutes must be between 1 and 600")
        now = self.clock()
        session = {"startedAt": iso(now), "until": iso(now + timedelta(minutes=int(minutes)))}
        self.db.settings.update_one({"_id": "global"}, {"$set": {"session": session}}, upsert=True)
        return session

    def end_session(self) -> None:
        self.db.settings.update_one({"_id": "global"}, {"$set": {"session": None}}, upsert=True)

    def record_health(self, *, healthy: bool, fault: str | None = None, reason: str | None = None,
                      temperature_c: float | None = None, power_w: float | None = None) -> dict:
        """Anton reports GPU health on every gpu-intent call.

        A fault (Xid, fell off the bus, nvidia-smi gone) pauses the whole queue
        until you resume it: alert only, nothing reboots. Unhealthy without a
        fault (too hot) only holds dispatch while it lasts.
        """
        now = self.clock()
        health = {"healthy": bool(healthy), "reason": clean_text(fault or reason, 300) or None, "at": iso(now),
                  "temperatureC": temperature_c, "powerW": power_w}
        self.db.settings.update_one({"_id": "global"}, {"$set": {"health": health}}, upsert=True)
        if fault:
            settings = self.settings()
            message = f"GPU fault: {clean_text(fault, 250)}"
            if not settings.get("paused") or settings.get("pausedReason") != message:
                self.db.settings.update_one({"_id": "global"}, {"$set": {"paused": True, "pausedReason": message}})
                self.db.gpu_events.insert_one({"at": iso(now), "kind": "fault", "detail": fault,
                                               "temperatureC": temperature_c})
        if temperature_c is not None:
            window = schedule.active_window(now, self.settings())
            if window:
                self.db.nights.update_one({"_id": window.night_id}, {"$max": {"maxTemperatureC": temperature_c}},
                                          upsert=True)
        return health

    def health(self) -> dict:
        return self.settings().get("health") or {"healthy": True, "reason": None, "at": None,
                                                  "temperatureC": None, "powerW": None}

    # --- nights ---------------------------------------------------------------
    def night(self, window: schedule.Window) -> dict:
        doc = self.db.nights.find_one({"_id": window.night_id}) or {}
        return {"id": window.night_id, "windowStart": iso(window.start), "windowEnd": iso(window.end),
                "gpuSeconds": doc.get("gpuSeconds", 0.0), "takesCompleted": doc.get("takesCompleted", 0),
                "takesFailed": doc.get("takesFailed", 0), "firstTakeAt": doc.get("firstTakeAt"),
                "lastTakeAt": doc.get("lastTakeAt"), "maxTemperatureC": doc.get("maxTemperatureC")}

    def last_night(self, before: str | None = None) -> dict | None:
        query = {"_id": {"$lt": before}} if before else {}
        doc = next(iter(self.db.nights.find(query).sort("_id", DESCENDING).limit(1)), None)
        if not doc:
            return None
        doc["id"] = doc.pop("_id")
        return doc

    def _charge_night(self, night: dict | None, *, gpu_seconds: float, completed: bool) -> None:
        """Charge a finished (or failed) take to the night it was dispatched in."""
        if not night or not night.get("id"):
            return
        now = iso(self.clock())
        self.db.nights.update_one(
            {"_id": night["id"]},
            {"$inc": {"gpuSeconds": round(gpu_seconds, 1), "takesCompleted" if completed else "takesFailed": 1},
             "$setOnInsert": {"windowStart": night.get("start"), "windowEnd": night.get("end"), "firstTakeAt": now},
             "$set": {"lastTakeAt": now}},
            upsert=True)

    # --- productions -----------------------------------------------------------
    def _owned(self, collection: str, owner: str, doc_id: str, production_id: str | None = None) -> dict:
        query: dict[str, Any] = {"_id": doc_id, "owner": owner}
        if production_id:
            query["productionId"] = production_id
        doc = self.db[collection].find_one(query)
        if not doc:
            raise ProductionsError(404, f"{collection[:-1]} not found")
        return doc

    def list_productions(self, owner: str) -> list[dict]:
        docs = list(self.db.productions.find({"owner": owner}).sort("createdAt", DESCENDING))
        return [self.public_production(doc, self.summary({"productionId": doc["_id"]})) for doc in docs]

    def create_production(self, owner: str, body: dict) -> dict:
        now = iso(self.clock())
        aspect = body.get("aspect") or "16:9"
        if aspect not in ASPECTS:
            raise ProductionsError(400, f"aspect must be one of {', '.join(ASPECTS)}")
        doc = {"_id": new_id("pr"), "owner": owner,
               "title": clean_text(body.get("title"), 200, required=True, field="title"),
               "logline": clean_text(body.get("logline"), 2000), "aspect": aspect,
               "defaults": self._defaults_with_opt_in(body, None),
               "paused": False, "createdAt": now, "updatedAt": now}
        self.db.productions.insert_one(doc)
        return self.public_production(doc, self.summary({"productionId": doc["_id"]}))

    def _defaults_with_opt_in(self, body: dict, current: dict | None) -> dict:
        base = current or {"takes": self.settings().get("defaultTakes", 2)}
        defaults = clean_defaults(body.get("defaults"), base)
        require_1080p_opt_in(defaults["resolution"], (current or {}).get("resolution"), body)
        return defaults

    def get_production(self, owner: str, production_id: str) -> dict:
        return self._owned("productions", owner, production_id)

    def update_production(self, owner: str, production_id: str, changes: dict) -> dict:
        doc = self.get_production(owner, production_id)
        update: dict[str, Any] = {}
        if "title" in changes:
            update["title"] = clean_text(changes["title"], 200, required=True, field="title")
        if "logline" in changes:
            update["logline"] = clean_text(changes["logline"], 2000)
        if "aspect" in changes:
            if changes["aspect"] not in ASPECTS:
                raise ProductionsError(400, f"aspect must be one of {', '.join(ASPECTS)}")
            update["aspect"] = changes["aspect"]
        if "defaults" in changes:
            update["defaults"] = self._defaults_with_opt_in(changes, doc.get("defaults"))
        if "paused" in changes:
            update["paused"] = bool(changes["paused"])
        update["updatedAt"] = iso(self.clock())
        self.db.productions.update_one({"_id": production_id}, {"$set": update})
        if "paused" in update:
            self.db.jobs.update_many({"productionId": production_id}, {"$set": {"productionPaused": update["paused"]}})
        doc = self.get_production(owner, production_id)
        return self.public_production(doc, self.summary({"productionId": production_id}))

    def delete_production(self, owner: str, production_id: str) -> dict:
        self.get_production(owner, production_id)
        cancelled = self._cancel_jobs({"productionId": production_id})
        for collection in ("episodes", "scenes", "shots", "takes"):
            self.db[collection].delete_many({"productionId": production_id})
        self.db.productions.delete_one({"_id": production_id})
        return {"deleted": production_id, "cancelledJobs": cancelled}

    # --- episodes and scenes ------------------------------------------------------
    def _next_order(self, collection: str, query: dict) -> int:
        last = next(iter(self.db[collection].find(query).sort("order", DESCENDING).limit(1)), None)
        return int(last["order"]) + 1 if last else 1

    def create_episode(self, owner: str, production_id: str, body: dict) -> dict:
        self.get_production(owner, production_id)
        now = iso(self.clock())
        doc = {"_id": new_id("ep"), "owner": owner, "productionId": production_id,
               "order": int(body.get("order") or self._next_order("episodes", {"productionId": production_id})),
               "title": clean_text(body.get("title"), 200, required=True, field="title"),
               "synopsis": clean_text(body.get("synopsis"), 4000), "paused": False,
               "createdAt": now, "updatedAt": now}
        self.db.episodes.insert_one(doc)
        return self.public_episode(doc, self.summary({"episodeId": doc["_id"]}))

    def update_episode(self, owner: str, production_id: str, episode_id: str, changes: dict) -> dict:
        self._owned("episodes", owner, episode_id, production_id)
        update: dict[str, Any] = {"updatedAt": iso(self.clock())}
        if "title" in changes:
            update["title"] = clean_text(changes["title"], 200, required=True, field="title")
        if "synopsis" in changes:
            update["synopsis"] = clean_text(changes["synopsis"], 4000)
        if "order" in changes:
            update["order"] = int(changes["order"])
            self.db.jobs.update_many({"episodeId": episode_id}, {"$set": {"episodeOrder": update["order"]}})
        if "paused" in changes:
            update["paused"] = bool(changes["paused"])
            self.db.jobs.update_many({"episodeId": episode_id}, {"$set": {"episodePaused": update["paused"]}})
        self.db.episodes.update_one({"_id": episode_id}, {"$set": update})
        doc = self._owned("episodes", owner, episode_id, production_id)
        return self.public_episode(doc, self.summary({"episodeId": episode_id}))

    def delete_episode(self, owner: str, production_id: str, episode_id: str) -> dict:
        self._owned("episodes", owner, episode_id, production_id)
        cancelled = self._cancel_jobs({"episodeId": episode_id})
        for collection in ("scenes", "shots", "takes"):
            self.db[collection].delete_many({"episodeId": episode_id})
        self.db.episodes.delete_one({"_id": episode_id})
        return {"deleted": episode_id, "cancelledJobs": cancelled}

    def create_scene(self, owner: str, production_id: str, body: dict) -> dict:
        episode = self._owned("episodes", owner, str(body.get("episodeId") or ""), production_id)
        now = iso(self.clock())
        doc = {"_id": new_id("sc"), "owner": owner, "productionId": production_id, "episodeId": episode["_id"],
               "order": int(body.get("order") or self._next_order("scenes", {"episodeId": episode["_id"]})),
               "title": clean_text(body.get("title"), 200, required=True, field="title"),
               "synopsis": clean_text(body.get("synopsis"), 4000), "createdAt": now, "updatedAt": now}
        self.db.scenes.insert_one(doc)
        return self.public_scene(doc)

    def update_scene(self, owner: str, production_id: str, scene_id: str, changes: dict) -> dict:
        self._owned("scenes", owner, scene_id, production_id)
        update: dict[str, Any] = {"updatedAt": iso(self.clock())}
        if "title" in changes:
            update["title"] = clean_text(changes["title"], 200, required=True, field="title")
        if "synopsis" in changes:
            update["synopsis"] = clean_text(changes["synopsis"], 4000)
        if "order" in changes:
            update["order"] = int(changes["order"])
            self.db.jobs.update_many({"sceneId": scene_id}, {"$set": {"sceneOrder": update["order"]}})
        self.db.scenes.update_one({"_id": scene_id}, {"$set": update})
        return self.public_scene(self._owned("scenes", owner, scene_id, production_id))

    def delete_scene(self, owner: str, production_id: str, scene_id: str) -> dict:
        self._owned("scenes", owner, scene_id, production_id)
        cancelled = self._cancel_jobs({"sceneId": scene_id})
        self.db.shots.delete_many({"sceneId": scene_id})
        self.db.takes.delete_many({"sceneId": scene_id})
        self.db.scenes.delete_one({"_id": scene_id})
        return {"deleted": scene_id, "cancelledJobs": cancelled}

    # --- shots -----------------------------------------------------------------
    def _shot_fields(self, body: dict, production: dict, base: dict | None = None) -> dict:
        defaults = production.get("defaults") or DEFAULTS
        base = base or {}
        fields: dict[str, Any] = {}

        def pick(name: str, fallback: Any) -> Any:
            if name in body and body[name] is not None:
                return body[name]
            return base.get(name, fallback)

        fields["prompt"] = clean_text(pick("prompt", ""), 4000, required=True, field="prompt")
        if len(fields["prompt"]) < 3:
            raise ProductionsError(400, "prompt must be at least 3 characters")
        fields["title"] = clean_text(pick("title", ""), 200)
        fields["camera"] = pick("camera", defaults.get("camera", "auto"))
        if fields["camera"] not in CAMERAS:
            raise ProductionsError(400, "unknown camera move")
        fields["durationSeconds"] = clamp_duration(pick("durationSeconds", defaults.get("durationSeconds", 5)))
        fields["model"] = pick("model", defaults.get("model", "video-quality"))
        if fields["model"] not in MODELS:
            raise ProductionsError(400, f"model must be one of {', '.join(MODELS)}")
        fields["resolution"] = pick("resolution", defaults.get("resolution", "720p"))
        if fields["resolution"] not in RESOLUTIONS:
            raise ProductionsError(400, f"resolution must be one of {', '.join(RESOLUTIONS)}")
        # A production whose defaults are already 1080p was confirmed then; a
        # shot that asks for 1080p on its own needs its own confirmation.
        inherited = base.get("resolution") if base else defaults.get("resolution")
        require_1080p_opt_in(fields["resolution"], inherited, body)
        accelerated = body["accelerated"] if "accelerated" in body else base.get("accelerated", defaults.get("accelerated"))
        fields["accelerated"] = None if accelerated is None else bool(accelerated)
        preserve = body["preserveText"] if "preserveText" in body else base.get("preserveText")
        fields["preserveText"] = None if preserve is None else bool(preserve)
        fields["takesWanted"] = clamp_takes(body.get("takes", body.get("takesWanted",
                                                                         base.get("takesWanted", defaults.get("takes", 2)))))
        return fields

    def _render_request(self, shot: dict, production: dict) -> dict:
        """What the image-api job will be asked to render (snapshotted on each job)."""
        return {
            "prompt": shot["prompt"], "camera": shot["camera"], "durationSeconds": shot["durationSeconds"],
            "model": shot["model"], "resolution": shot["resolution"], "aspect": production.get("aspect", "16:9"),
            "accelerated": shot.get("accelerated"), "preserveText": shot.get("preserveText"),
            "keyframe": (shot.get("keyframe") or {}).get("name"), "endFrame": (shot.get("endFrame") or {}).get("name"),
        }

    def _estimate(self, request: dict) -> dict:
        try:
            return self.estimator(request)
        except ValueError as exc:
            raise ProductionsError(400, str(exc)) from exc

    def create_shot(self, owner: str, production_id: str, body: dict) -> dict:
        production = self.get_production(owner, production_id)
        scene = self._owned("scenes", owner, str(body.get("sceneId") or ""), production_id)
        fields = self._shot_fields(body, production)
        now = iso(self.clock())
        doc = {"_id": new_id("sh"), "owner": owner, "productionId": production_id, "episodeId": scene["episodeId"],
               "sceneId": scene["_id"], "order": int(body.get("order") or self._next_order("shots", {"sceneId": scene["_id"]})),
               **fields, "revision": 1, "keyframe": None, "endFrame": None, "chosenTakeId": None, "notes": [],
               "promptHistory": [{"revision": 1, "prompt": fields["prompt"], "at": now}],
               "createdAt": now, "updatedAt": now}
        self._estimate(self._render_request(doc, production))  # 400 on impossible combinations
        self.db.shots.insert_one(doc)
        return self.shot_view(owner, production_id, doc["_id"])

    def create_shots(self, owner: str, production_id: str, scene_id: str, shots: list[dict]) -> list[dict]:
        if not shots:
            raise ProductionsError(400, "no shots given")
        if len(shots) > 200:
            raise ProductionsError(400, "at most 200 shots at a time")
        production = self.get_production(owner, production_id)
        self._owned("scenes", owner, scene_id, production_id)
        for body in shots:  # validate everything before writing anything
            self._estimate(self._render_request({**self._shot_fields(body, production)}, production))
        return [self.create_shot(owner, production_id, {**body, "sceneId": scene_id}) for body in shots]

    def update_shot(self, owner: str, production_id: str, shot_id: str, changes: dict) -> dict:
        production = self.get_production(owner, production_id)
        shot = self._owned("shots", owner, shot_id, production_id)
        fields = self._shot_fields(changes, production, base=shot)
        update: dict[str, Any] = {k: v for k, v in fields.items() if shot.get(k) != v}
        if "order" in changes:
            update["order"] = int(changes["order"])
        if "sceneId" in changes and changes["sceneId"] != shot["sceneId"]:
            scene = self._owned("scenes", owner, str(changes["sceneId"]), production_id)
            update.update(sceneId=scene["_id"], episodeId=scene["episodeId"])
        if not update:
            return self.shot_view(owner, production_id, shot_id)
        self._estimate(self._render_request({**shot, **update}, production))
        return self._apply_shot_update(owner, production_id, shot, update)

    def _apply_shot_update(self, owner: str, production_id: str, shot: dict, update: dict,
                           push: dict | None = None) -> dict:
        now = iso(self.clock())
        update = dict(update, updatedAt=now)
        push = dict(push or {})
        render_changed = any(name in update for name in RENDER_FIELDS)
        if render_changed:
            revision = int(shot.get("revision", 1)) + 1
            update["revision"] = revision
            if "prompt" in update:
                push["promptHistory"] = {"revision": revision, "prompt": update["prompt"], "at": now}
            # Queued takes of the old version would render the old prompt.
            self._cancel_jobs({"shotId": shot["_id"], "shotRevision": {"$lt": revision}, "status": "queued"})
        moved = {k: update[k] for k in ("sceneId", "episodeId", "order") if k in update}
        operation: dict[str, Any] = {"$set": update}
        if push:
            operation["$push"] = push
        self.db.shots.update_one({"_id": shot["_id"]}, operation)
        if moved:
            episode_order, scene_order = self._orders(update.get("episodeId", shot["episodeId"]),
                                                      update.get("sceneId", shot["sceneId"]))
            self.db.jobs.update_many({"shotId": shot["_id"]}, {"$set": {
                **{k: v for k, v in moved.items() if k != "order"},
                "episodeOrder": episode_order, "sceneOrder": scene_order,
                "shotOrder": update.get("order", shot["order"])}})
            self.db.takes.update_many({"shotId": shot["_id"]}, {"$set": {
                k: v for k, v in moved.items() if k != "order"}})
        return self.shot_view(owner, production_id, shot["_id"])

    def set_frame(self, owner: str, production_id: str, shot_id: str, role: str, ref: dict | None) -> dict:
        if role not in ("start", "end"):
            raise ProductionsError(400, "role must be start or end")
        shot = self._owned("shots", owner, shot_id, production_id)
        field = "keyframe" if role == "start" else "endFrame"
        if ref is None and shot.get(field) is None:
            return self.shot_view(owner, production_id, shot_id)
        if role == "end" and ref is not None and not shot.get("keyframe"):
            raise ProductionsError(400, "add a start keyframe before an end frame")
        update: dict[str, Any] = {field: ref}
        if role == "start" and ref is None and shot.get("endFrame"):
            update["endFrame"] = None  # first/last-frame needs both
        return self._apply_shot_update(owner, production_id, shot, update)

    def delete_shot(self, owner: str, production_id: str, shot_id: str) -> dict:
        self._owned("shots", owner, shot_id, production_id)
        cancelled = self._cancel_jobs({"shotId": shot_id})
        self.db.takes.delete_many({"shotId": shot_id})
        self.db.shots.delete_one({"_id": shot_id})
        return {"deleted": shot_id, "cancelledJobs": cancelled}

    def _orders(self, episode_id: str, scene_id: str) -> tuple[int, int]:
        episode = self.db.episodes.find_one({"_id": episode_id}) or {}
        scene = self.db.scenes.find_one({"_id": scene_id}) or {}
        return int(episode.get("order", 0)), int(scene.get("order", 0))

    # --- queueing ---------------------------------------------------------------
    def queue_shot(self, owner: str, production_id: str, shot_id: str, *, takes: int | None = None,
                   priority: int | None = None, seed: int | None = None) -> dict:
        """Queue ``takes`` takes of the shot's current revision (idempotent).

        ``takes`` is the total wanted for this revision: queueing 2 twice keeps
        2 jobs; asking for 3 later adds one. A cancelled job comes back.
        """
        production = self.get_production(owner, production_id)
        shot = self._owned("shots", owner, shot_id, production_id)
        count = clamp_takes(takes if takes is not None else shot.get("takesWanted", 2))
        priority = int(priority if priority is not None else PRIORITY_DEFAULT)
        if not 0 <= priority <= 100:
            raise ProductionsError(400, "priority is 0-100")
        request = self._render_request(shot, production)
        estimate = self._estimate(request)
        episode_order, scene_order = self._orders(shot["episodeId"], shot["sceneId"])
        now = iso(self.clock())
        queued = 0
        for index in range(count):
            job_id = job_id_for(shot_id, shot["revision"], index)
            doc = {
                "_id": job_id, "owner": owner, "productionId": production_id, "episodeId": shot["episodeId"],
                "sceneId": shot["sceneId"], "shotId": shot_id, "shotRevision": shot["revision"], "takeIndex": index,
                "priority": priority, "episodeOrder": episode_order, "sceneOrder": scene_order,
                "shotOrder": shot["order"], "pipelineKey": estimate["key"], "status": "queued", "attempts": 0,
                "lostCount": 0, "maxAttempts": MAX_ATTEMPTS, "notBefore": None, "lastError": None, "errorClass": None,
                "lease": None, "imageApiJobId": None, "estimateSeconds": int(estimate["perTakeSeconds"]),
                "gpuSeconds": None, "startedAt": None, "completedAt": None, "createdAt": now,
                "seed": int(seed) if seed is not None else self.rng.randrange(0, JS_SAFE_SEED),
                "request": request, "note": (shot.get("notes") or [{}])[-1].get("text")
                if (shot.get("notes") or [{}])[-1].get("revision") == shot["revision"] else None,
                "productionPaused": bool(production.get("paused")),
                "episodePaused": bool((self.db.episodes.find_one({"_id": shot["episodeId"]}) or {}).get("paused")),
            }
            try:
                self.db.jobs.insert_one(doc)
                queued += 1
            except DuplicateKeyError:
                revived = self.db.jobs.update_one(
                    {"_id": job_id, "status": "cancelled"},
                    {"$set": {"status": "queued", "attempts": 0, "lostCount": 0, "notBefore": None, "lastError": None,
                              "errorClass": None, "lease": None, "imageApiJobId": None, "priority": priority,
                              "createdAt": now}})
                queued += revived.modified_count
        return {"queuedJobs": queued, "estimateSeconds": int(estimate["perTakeSeconds"]) * queued}

    def queue_episode(self, owner: str, production_id: str, episode_id: str, *, takes: int | None = None,
                      priority: int | None = None) -> dict:
        self._owned("episodes", owner, episode_id, production_id)
        shots = list(self.db.shots.find({"episodeId": episode_id, "owner": owner}))
        result = {"queuedJobs": 0, "shots": 0, "estimateSeconds": 0}
        for shot in shots:
            if shot.get("chosenTakeId"):
                continue  # approved shots are done
            outcome = self.queue_shot(owner, production_id, shot["_id"], takes=takes, priority=priority)
            if outcome["queuedJobs"]:
                result["shots"] += 1
            result["queuedJobs"] += outcome["queuedJobs"]
            result["estimateSeconds"] += outcome["estimateSeconds"]
        return result

    def cancel_shot(self, owner: str, production_id: str, shot_id: str) -> dict:
        self._owned("shots", owner, shot_id, production_id)
        return {"cancelled": self._cancel_jobs({"shotId": shot_id, "status": "queued"})}

    def _cancel_jobs(self, query: dict) -> int:
        """Cancel queued jobs. A job already on the GPU finishes; its take is kept."""
        query = {**query}
        if "status" not in query:
            query["status"] = "queued"
        return self.db.jobs.update_many(query, {"$set": {"status": "cancelled", "lease": None,
                                                         "completedAt": iso(self.clock())}}).modified_count

    def regenerate(self, owner: str, production_id: str, shot_id: str, *, note: str, prompt: str | None = None,
                   takes: int | None = None, keep_seed: bool = False) -> dict:
        """Add a note, optionally change the prompt, and queue a new revision at priority 60."""
        shot = self._owned("shots", owner, shot_id, production_id)
        text = clean_text(note, 1000, required=True, field="note")
        seed = None
        if keep_seed:
            take_id = shot.get("chosenTakeId")
            source = (self.db.takes.find_one({"_id": take_id}) if take_id else None) or next(iter(
                self.db.takes.find({"shotId": shot_id}).sort("createdAt", DESCENDING).limit(1)), None)
            if not source:
                raise ProductionsError(400, "there is no take to keep the seed from")
            seed = int(source["seed"])
        revision = int(shot.get("revision", 1)) + 1
        update: dict[str, Any] = {"chosenTakeId": None}
        if prompt is not None and clean_text(prompt, 4000) and clean_text(prompt, 4000) != shot["prompt"]:
            update["prompt"] = clean_text(prompt, 4000)
        else:
            update["revision"] = revision  # a note alone still needs new take ids
            self._cancel_jobs({"shotId": shot_id, "shotRevision": {"$lt": revision}, "status": "queued"})
        self.db.takes.update_many({"shotId": shot_id, "status": {"$in": ["chosen", "alternate"]}},
                                  {"$set": {"status": "ready"}})
        self._apply_shot_update(owner, production_id, shot, update,
                                push={"notes": {"text": text, "revision": revision, "at": iso(self.clock())}})
        count = takes if takes is not None else (1 if keep_seed else None)
        self.queue_shot(owner, production_id, shot_id, takes=count, priority=PRIORITY_REDO, seed=seed)
        return self.shot_view(owner, production_id, shot_id)

    def choose_take(self, owner: str, production_id: str, shot_id: str, take_id: str) -> dict:
        self._owned("shots", owner, shot_id, production_id)
        take = self.db.takes.find_one({"_id": take_id, "shotId": shot_id})
        if not take:
            raise ProductionsError(404, "take not found")
        self.db.takes.update_many({"shotId": shot_id, "status": {"$in": ["ready", "chosen"]}},
                                  {"$set": {"status": "alternate"}})
        self.db.takes.update_one({"_id": take_id}, {"$set": {"status": "chosen"}})
        self.db.shots.update_one({"_id": shot_id}, {"$set": {"chosenTakeId": take_id, "updatedAt": iso(self.clock())}})
        # Nothing more to render for an approved shot.
        self._cancel_jobs({"shotId": shot_id, "status": "queued"})
        return self.shot_view(owner, production_id, shot_id)

    def unchoose(self, owner: str, production_id: str, shot_id: str) -> dict:
        self._owned("shots", owner, shot_id, production_id)
        self.db.takes.update_many({"shotId": shot_id, "status": {"$in": ["chosen", "alternate"]}},
                                  {"$set": {"status": "ready"}})
        self.db.shots.update_one({"_id": shot_id}, {"$set": {"chosenTakeId": None, "updatedAt": iso(self.clock())}})
        return self.shot_view(owner, production_id, shot_id)

    def reject_take(self, owner: str, production_id: str, shot_id: str, take_id: str) -> dict:
        shot = self._owned("shots", owner, shot_id, production_id)
        if not self.db.takes.find_one({"_id": take_id, "shotId": shot_id}):
            raise ProductionsError(404, "take not found")
        self.db.takes.update_one({"_id": take_id}, {"$set": {"status": "rejected"}})
        if shot.get("chosenTakeId") == take_id:
            self.unchoose(owner, production_id, shot_id)
        return self.shot_view(owner, production_id, shot_id)

    def retry_job(self, owner: str, production_id: str, job_id: str) -> dict:
        job = self._owned("jobs", owner, job_id, production_id)
        if job["status"] not in ("dead", "failed", "cancelled"):
            raise ProductionsError(409, f"job is {job['status']}")
        self.db.jobs.update_one({"_id": job_id}, {"$set": {
            "status": "queued", "attempts": 0, "lostCount": 0, "notBefore": None, "lease": None,
            "imageApiJobId": None}})
        return public_job(self.db.jobs.find_one({"_id": job_id}))

    def take(self, owner: str, production_id: str, take_id: str) -> dict:
        take = self.db.takes.find_one({"_id": take_id, "productionId": production_id, "owner": owner})
        if not take:
            raise ProductionsError(404, "take not found")
        return take

    # --- dispatcher side ------------------------------------------------------------
    def in_flight(self) -> list[dict]:
        return list(self.db.jobs.find({"status": {"$in": list(IN_FLIGHT)}}))

    def candidates(self, now: datetime, limit: int = 50) -> list[dict]:
        """Queued jobs that may run now, in dispatch order (design §4.3)."""
        query = {"status": "queued", "productionPaused": {"$ne": True}, "episodePaused": {"$ne": True},
                 "$or": [{"notBefore": None}, {"notBefore": {"$lte": iso(now)}}]}
        cursor = self.db.jobs.find(query).sort([
            ("priority", DESCENDING), ("episodeOrder", ASCENDING), ("pipelineKey", ASCENDING),
            ("sceneOrder", ASCENDING), ("shotOrder", ASCENDING), ("takeIndex", ASCENDING),
            ("createdAt", ASCENDING)])
        return list(cursor.limit(limit))

    def pending_eligible(self, now: datetime) -> list[dict]:
        """Every queued job that is not paused (backed-off ones included), dispatch order."""
        query = {"status": "queued", "productionPaused": {"$ne": True}, "episodePaused": {"$ne": True}}
        return list(self.db.jobs.find(query).sort([
            ("priority", DESCENDING), ("episodeOrder", ASCENDING), ("pipelineKey", ASCENDING),
            ("sceneOrder", ASCENDING), ("shotOrder", ASCENDING), ("takeIndex", ASCENDING)]))

    def lease(self, job_id: str, holder: str, lease_seconds: float, night: dict | None = None) -> dict | None:
        """Atomically take a queued job (only one dispatcher can win it)."""
        now = self.clock()
        return self.db.jobs.find_one_and_update(
            {"_id": job_id, "status": "queued"},
            {"$set": {"status": "leased", "night": night,
                      "lease": {"holder": holder, "expiresAt": iso(now + timedelta(seconds=lease_seconds))}},
             "$inc": {"attempts": 1}},
            return_document=ReturnDocument.AFTER)

    def unlease(self, job_id: str) -> None:
        self.db.jobs.update_one({"_id": job_id, "status": "leased"},
                                {"$set": {"status": "queued", "lease": None}, "$inc": {"attempts": -1}})

    def mark_submitted(self, job_id: str, image_job_id: str, estimate_seconds: float) -> None:
        self.db.jobs.update_one({"_id": job_id}, {"$set": {
            "status": "submitted", "imageApiJobId": image_job_id, "estimateSeconds": int(estimate_seconds)}})

    def mark_running(self, job_id: str, started_at: str | None) -> None:
        self.db.jobs.update_one({"_id": job_id, "status": {"$in": ["submitted", "leased"]}},
                                {"$set": {"status": "running", "startedAt": started_at or iso(self.clock())}})

    def complete(self, job: dict, take: dict, *, gpu_seconds: float) -> dict:
        """Record the take and finish the job (idempotent on the take id)."""
        now = iso(self.clock())
        shot = self.db.shots.find_one({"_id": job["shotId"]})
        doc = {
            "_id": job["_id"], "owner": job["owner"], "productionId": job["productionId"],
            "episodeId": job["episodeId"], "sceneId": job["sceneId"], "shotId": job["shotId"],
            "shotRevision": job["shotRevision"], "takeIndex": job["takeIndex"], "seed": job["seed"],
            "imageApiJobId": job.get("imageApiJobId"), "status": "ready", "gpuSeconds": round(gpu_seconds, 1),
            "estimateSeconds": job.get("estimateSeconds"), "prompt": job["request"]["prompt"],
            "model": job["request"]["model"], "resolution": job["request"]["resolution"],
            "note": job.get("note"), "createdAt": now, **take,
        }
        if shot is None:
            doc["status"] = "rejected"  # the shot was deleted while this take rendered
        self.db.takes.replace_one({"_id": doc["_id"]}, doc, upsert=True)
        self.db.jobs.update_one({"_id": job["_id"]}, {"$set": {
            "status": "completed", "gpuSeconds": round(gpu_seconds, 1), "completedAt": now, "lease": None,
            "lastError": None}})
        self._charge_night(job.get("night"), gpu_seconds=gpu_seconds, completed=True)
        return doc

    def fail(self, job: dict, error_class: str, message: str | None, *, gpu_seconds: float = 0.0) -> str:
        """Apply the retry policy; returns the job's new status (queued or dead)."""
        now = self.clock()
        attempts = int(job.get("attempts", 1))
        lost = int(job.get("lostCount", 0))
        update: dict[str, Any] = {"lastError": clean_text(message, 1000) or None, "errorClass": error_class,
                                  "lease": None, "imageApiJobId": None, "startedAt": None}
        status = "queued"
        not_before = None
        if error_class in ("lost", "gpu_fault", "released"):
            # Not the take's fault: the first two losses (and every GPU fault or
            # forced release) do not count as attempts.
            if error_class != "lost" or lost < FREE_LOST_ATTEMPTS:
                update["attempts"] = max(0, attempts - 1)
            if error_class == "lost":
                update["lostCount"] = lost + 1
            if error_class == "lost" and lost >= FREE_LOST_ATTEMPTS and attempts >= job.get("maxAttempts", MAX_ATTEMPTS):
                status = "dead"
        elif error_class == "invalid":
            status = "dead"
        elif error_class in ("oom", "timeout"):
            status = "dead" if attempts >= 2 else "queued"
        else:  # transient
            if attempts >= job.get("maxAttempts", MAX_ATTEMPTS):
                status = "dead"
            else:
                not_before = now + timedelta(seconds=BACKOFF_SECONDS[min(attempts - 1, len(BACKOFF_SECONDS) - 1)])
        update["status"] = status
        update["notBefore"] = iso(not_before)
        if status == "dead":
            update["completedAt"] = iso(now)
        self.db.jobs.update_one({"_id": job["_id"]}, {"$set": update})
        if error_class not in ("lost", "released"):
            self._charge_night(job.get("night"), gpu_seconds=gpu_seconds, completed=False)
        return status

    # --- views --------------------------------------------------------------------
    def _estimates(self) -> Callable[[dict], int]:
        memo: dict[str, int] = {}

        def per_take(job_or_request: dict) -> int:
            request = job_or_request.get("request", job_or_request)
            key = repr(sorted((k, v) for k, v in request.items() if k != "prompt"))
            if key not in memo:
                try:
                    memo[key] = int(self.estimator(request)["perTakeSeconds"])
                except Exception:
                    memo[key] = int(job_or_request.get("estimateSeconds") or 300)
            return memo[key]
        return per_take

    def summary(self, query: dict) -> dict:
        shots = list(self.db.shots.find(query, {"_id": 1, "chosenTakeId": 1, "revision": 1}))
        jobs = list(self.db.jobs.find({**query, "status": {"$in": list(PENDING) + ["dead"]}},
                                      {"status": 1, "shotId": 1, "shotRevision": 1, "request": 1,
                                       "estimateSeconds": 1}))
        takes = list(self.db.takes.find(query, {"shotId": 1, "status": 1, "shotRevision": 1}))
        per_take = self._estimates()
        statuses = [derive_status(shot, [j for j in jobs if j["shotId"] == shot["_id"]],
                                  [t for t in takes if t["shotId"] == shot["_id"]]) for shot in shots]
        pending = [j for j in jobs if j["status"] in PENDING]
        remaining = sum(per_take(j) for j in pending)
        capacity = schedule.nightly_capacity_seconds(self.clock(), self.settings())
        result = {
            "shots": len(shots), "approved": statuses.count("approved"), "review": statuses.count("review"),
            "needsAttention": statuses.count("needs_attention"),
            "queuedTakes": sum(1 for j in pending if j["status"] == "queued"),
            "runningTakes": sum(1 for j in pending if j["status"] != "queued"),
            "doneTakes": len(takes), "failedTakes": sum(1 for j in jobs if j["status"] == "dead"),
            "remainingSeconds": remaining, "nights": schedule.nights_for(remaining, capacity),
        }
        if "productionId" in query and len(query) == 1:
            result["episodes"] = self.db.episodes.count_documents(query)
            result["scenes"] = self.db.scenes.count_documents(query)
        return result

    def board(self, owner: str, production_id: str) -> dict:
        production = self.get_production(owner, production_id)
        episodes = list(self.db.episodes.find({"productionId": production_id}).sort("order", ASCENDING))
        scenes = list(self.db.scenes.find({"productionId": production_id}).sort([("episodeId", 1), ("order", 1)]))
        shots = list(self.db.shots.find({"productionId": production_id}).sort([("sceneId", 1), ("order", 1)]))
        jobs = list(self.db.jobs.find({"productionId": production_id, "status": {"$nin": ["completed", "cancelled"]}}))
        takes = list(self.db.takes.find({"productionId": production_id}).sort("createdAt", DESCENDING))
        per_take = self._estimates()
        summary = self.summary({"productionId": production_id})
        capacity = schedule.nightly_capacity_seconds(self.clock(), self.settings())
        return {
            "production": self.public_production(production, summary),
            "episodes": [self.public_episode(e, self.summary({"episodeId": e["_id"]})) for e in episodes],
            "scenes": [self.public_scene(s) for s in scenes],
            "shots": [self.public_shot(s, [j for j in jobs if j["shotId"] == s["_id"]],
                                       [t for t in takes if t["shotId"] == s["_id"]], per_take, production)
                      for s in shots],
            "eta": {"remainingSeconds": summary["remainingSeconds"], "nights": summary["nights"],
                    "nightlyCapacitySeconds": int(capacity)},
        }

    def shot_view(self, owner: str, production_id: str, shot_id: str) -> dict:
        production = self.get_production(owner, production_id)
        shot = self._owned("shots", owner, shot_id, production_id)
        jobs = list(self.db.jobs.find({"shotId": shot_id, "status": {"$nin": ["completed", "cancelled"]}}))
        takes = list(self.db.takes.find({"shotId": shot_id}).sort("createdAt", DESCENDING))
        return self.public_shot(shot, jobs, takes, self._estimates(), production)

    @staticmethod
    def public_production(doc: dict, summary: dict) -> dict:
        value = {k: v for k, v in doc.items() if k not in ("_id", "owner")}
        return {"id": doc["_id"], **value, "summary": summary}

    @staticmethod
    def public_episode(doc: dict, summary: dict) -> dict:
        value = {k: v for k, v in doc.items() if k not in ("_id", "owner")}
        return {"id": doc["_id"], **value, "summary": summary}

    @staticmethod
    def public_scene(doc: dict) -> dict:
        value = {k: v for k, v in doc.items() if k not in ("_id", "owner")}
        return {"id": doc["_id"], **value}

    def public_shot(self, doc: dict, jobs: list[dict], takes: list[dict], per_take: Callable[[dict], int],
                    production: dict) -> dict:
        value = {k: v for k, v in doc.items() if k not in ("_id", "owner")}
        value["id"] = doc["_id"]
        value["status"] = derive_status(doc, jobs, takes)
        value["estimateSeconds"] = per_take(self._render_request(doc, production))
        value["takes"] = [public_take(t) for t in takes]
        value["jobs"] = [public_job(j) for j in jobs]
        return value


def derive_status(shot: dict, jobs: Iterable[dict], takes: Iterable[dict]) -> str:
    """draft -> queued -> rendering -> review -> approved (+ needs_attention)."""
    jobs = [j for j in jobs if j.get("status") not in ("completed", "cancelled")]
    takes = list(takes)
    if shot.get("chosenTakeId"):
        return "approved"
    if any(j["status"] in IN_FLIGHT for j in jobs):
        return "rendering"
    if any(j["status"] == "queued" for j in jobs):
        return "queued"
    current = shot.get("revision", 1)
    if any(j["status"] == "dead" and j.get("shotRevision") == current for j in jobs) and not any(
            t.get("shotRevision") == current and t.get("status") != "rejected" for t in takes):
        return "needs_attention"
    if any(t.get("status") in ("ready", "alternate") for t in takes):
        return "review"
    return "draft"


def public_take(doc: dict) -> dict:
    value = {k: v for k, v in doc.items() if k not in ("_id", "owner")}
    value["id"] = doc["_id"]
    if value.get("seed") is not None:
        value["seedText"] = str(value["seed"])
    return value


def public_job(doc: dict) -> dict:
    keep = ("shotId", "shotRevision", "takeIndex", "status", "priority", "attempts", "maxAttempts", "lastError",
            "errorClass", "notBefore", "estimateSeconds", "startedAt", "productionId")
    return {"id": doc["_id"], **{k: doc.get(k) for k in keep}}
