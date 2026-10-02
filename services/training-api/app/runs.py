"""Training runs: records, the queue, the GPU handshake with Anton, Job launch and worker callbacks.

Lifecycle: queued → waiting_for_gpu → preparing → training → evaluating → exporting → completed
(or failed / cancelled). One run holds the GPU at a time.

GPU handshake (same shape as image-api Productions): Anton polls ``GET /internal/gpu-intent``
every minute, passing what it holds (``held``, ``phase``). We answer ``wantGpu`` while a run is
due or active. Anton claims the card for owner ``training`` (parks Ollama, stops image/voice,
never evicts a running training Job) and reports ``held=true&phase=ready``; only then is the
worker Job created. When nothing is due or running we answer ``wantGpu=false`` and Anton gives
the card back to Ollama. A running run is never preempted: the night window closing, a new
image claim or the idle rule don't touch it; only an explicit cancel does.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from typing import Any, Callable, Protocol
from zoneinfo import ZoneInfo

from . import catalog

ACTIVE = ("preparing", "training", "evaluating", "exporting")
WAITING = ("queued", "waiting_for_gpu")
TERMINAL = ("completed", "failed", "cancelled")
WORKER_STATUSES = ("preparing", "training", "evaluating", "exporting")
MAX_POINTS = 4000
LOG_TAIL = 200
ANTON_FRESH = timedelta(minutes=3)


class RunError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class Launcher(Protocol):
    def launch(self, run: dict, token: str) -> str: ...
    def delete(self, job_name: str) -> None: ...
    def state(self, job_name: str) -> str: ...          # active | succeeded | failed | missing
    def logs(self, job_name: str, lines: int) -> list[str]: ...


@dataclass
class Window:
    start: str = "22:00"
    end: str = "07:00"
    timezone: str = "America/Chicago"

    def is_open(self, at: datetime) -> bool:
        local = at.astimezone(ZoneInfo(self.timezone)).time()
        start, end = _hhmm(self.start), _hhmm(self.end)
        return start <= local < end if start < end else (local >= start or local < end)


def _hhmm(value: str) -> time:
    hours, minutes = value.split(":")
    return time(int(hours), int(minutes))


def utcnow() -> datetime:
    return datetime.now(UTC)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_run_id() -> str:
    return "run_" + utcnow().strftime("%Y%m%d%H%M%S") + "_" + secrets.token_hex(3)


def iso(value: Any) -> Any:
    return value.astimezone(UTC).isoformat() if isinstance(value, datetime) else value


def public(run: dict, *, logs: list[str] | None = None) -> dict:
    out = {k: iso(v) for k, v in run.items() if k not in ("_id", "tokenHash", "points")}
    out["id"] = run["_id"]
    out["lossCurve"] = run.get("points", [])
    if logs is not None:
        out["logs"] = logs
    return out


class Runs:
    def __init__(self, db, launcher: Launcher, *, vram_gb: float, window: Window | None = None,
                 clock: Callable[[], datetime] = utcnow):
        self.db, self.launcher, self.vram_gb = db, launcher, vram_gb
        self.window = window or Window()
        self.clock = clock

    # --- API ----------------------------------------------------------------------------
    def create(self, *, owner: str, body: dict) -> dict:
        trainset = self.db.trainsets.find_one({"_id": body.get("trainsetId")})
        if not trainset:
            raise RunError(404, "unknown trainsetId")
        base = body.get("baseModel") or catalog.DEFAULT_BASE
        if base not in catalog.BASE_MODELS:
            raise RunError(400, f"baseModel must be one of {', '.join(catalog.BASE_MODELS)}")
        method = body.get("method") or catalog.BASE_MODELS[base]["defaultMethod"]
        if method not in ("lora", "qlora"):
            raise RunError(400, "method must be lora or qlora")
        try:
            catalog.check_fits(base, method, self.vram_gb)
            hyper = catalog.resolve_hyper(base, body.get("hyper"))
        except ValueError as exc:
            raise RunError(400, str(exc)) from exc
        schedule = body.get("schedule") or "night"
        if schedule not in ("now", "night"):
            raise RunError(400, "schedule must be now or night")
        exports = body.get("exports") or ["gguf-q4_k_m", "gguf-q8_0"]
        bad = [e for e in exports if e not in catalog.EXPORTS]
        if bad:
            raise RunError(400, f"unknown export(s): {', '.join(bad)}")
        run_id = new_run_id()
        run = {
            "_id": run_id, "owner": owner, "createdAt": self.clock(), "updatedAt": self.clock(),
            "status": "queued", "trainsetId": trainset["_id"], "trainsetName": trainset.get("name"),
            "trainKeys": trainset["keys"], "counts": trainset["counts"],
            "baseModel": base, "hf": catalog.BASE_MODELS[base]["hf"], "family": catalog.BASE_MODELS[base]["family"],
            "method": method, "hyper": hyper, "schedule": schedule, "exports": list(dict.fromkeys(exports)),
            "evalBanditBench": bool(body.get("evalBanditBench", True)), "smoke": bool(body.get("smoke")),
            "name": str(body.get("name") or "")[:120] or None,
            "progress": {}, "points": [], "logTail": [], "artifacts": {}, "eval": None, "error": None,
            "jobName": None, "tokenHash": None, "attempt": 0, "resume": False,
            "ollama": {"status": "not-registered"},
        }
        self.db.runs.insert_one(run)
        return run

    def get(self, run_id: str) -> dict:
        run = self.db.runs.find_one({"_id": run_id})
        if not run:
            raise RunError(404, "unknown run")
        return run

    def logs(self, run: dict) -> list[str]:
        if run["status"] in ACTIVE and run.get("jobName"):
            try:
                return self.launcher.logs(run["jobName"], LOG_TAIL)
            except Exception:
                pass
        return run.get("logTail") or []

    def cancel(self, run_id: str) -> dict:
        run = self.get(run_id)
        if run["status"] in TERMINAL:
            raise RunError(409, f"run is already {run['status']}")
        if run.get("jobName"):
            self.launcher.delete(run["jobName"])
        return self._set(run_id, status="cancelled", finishedAt=self.clock(), error=None)

    def resume(self, run_id: str) -> dict:
        """Re-queue a cancelled/failed run; the worker resumes from its last checkpoint."""
        run = self.get(run_id)
        if run["status"] not in ("cancelled", "failed"):
            raise RunError(409, "only cancelled or failed runs can be resumed")
        return self._set(run_id, status="queued", resume=True, error=None, jobName=None, tokenHash=None)

    # --- GPU handshake + dispatch --------------------------------------------------------
    def intent(self, *, held: bool, phase: str | None) -> dict:
        self.db.state.update_one({"_id": "anton"}, {"$set": {"held": held, "phase": phase, "at": self.clock()}},
                                 upsert=True)
        self.tick()
        active = self.db.runs.find_one({"status": {"$in": list(ACTIVE)}})
        waiting = self.db.runs.find_one({"status": "waiting_for_gpu"})
        if active:
            return {"wantGpu": True, "running": True, "runId": active["_id"], "reason": f"run {active['_id']} is {active['status']}"}
        if waiting:
            return {"wantGpu": True, "running": False, "runId": waiting["_id"], "reason": f"run {waiting['_id']} is due"}
        return {"wantGpu": False, "running": False, "runId": None, "reason": "nothing due"}

    def gpu_ready(self) -> bool:
        state = self.db.state.find_one({"_id": "anton"}) or {}
        at = state.get("at")
        if isinstance(at, datetime) and at.tzinfo is None:
            at = at.replace(tzinfo=UTC)
        fresh = isinstance(at, datetime) and self.clock() - at <= ANTON_FRESH
        return bool(fresh and state.get("held") and state.get("phase") == "ready")

    def due(self, run: dict) -> bool:
        return run["schedule"] == "now" or self.window.is_open(self.clock())

    def tick(self) -> None:
        """Reconcile active Jobs, promote the next due run, launch when Anton holds the card."""
        for run in self.db.runs.find({"status": {"$in": list(ACTIVE)}}):
            state = self.launcher.state(run["jobName"]) if run.get("jobName") else "missing"
            if state in ("failed", "missing"):
                tail = []
                try:
                    tail = self.launcher.logs(run["jobName"], LOG_TAIL) if run.get("jobName") else []
                except Exception:
                    pass
                self._set(run["_id"], status="failed", finishedAt=self.clock(), logTail=tail or run.get("logTail"),
                          error=run.get("error") or f"worker job {state}")
            elif state == "succeeded" and run["status"] in ACTIVE:
                # The worker exits 0 only after POST /complete; a stale record means it died afterwards.
                self._set(run["_id"], status="failed", finishedAt=self.clock(),
                          error="worker exited without reporting completion")
        if self.db.runs.find_one({"status": {"$in": list(ACTIVE)}}):
            return
        waiting = self.db.runs.find_one({"status": "waiting_for_gpu"})
        if waiting and not self.due(waiting):
            # A night run whose window closed before it started waits for the next night.
            self._set(waiting["_id"], status="queued")
            waiting = None
        if not waiting:
            for run in self.db.runs.find({"status": "queued"}).sort("createdAt", 1):
                if self.due(run):
                    waiting = self._set(run["_id"], status="waiting_for_gpu")
                    break
        if waiting and self.gpu_ready():
            token = secrets.token_urlsafe(32)
            attempt = int(waiting.get("attempt") or 0) + 1
            self._set(waiting["_id"], tokenHash=hash_token(token), attempt=attempt)
            try:
                job = self.launcher.launch(self.get(waiting["_id"]), token)
            except Exception as exc:  # a bad manifest or RBAC must not wedge the queue
                self._set(waiting["_id"], status="failed", finishedAt=self.clock(), error=f"could not start the worker: {exc}"[:2000])
                return
            self._set(waiting["_id"], status="preparing", jobName=job, startedAt=self.clock())

    # --- worker callbacks ---------------------------------------------------------------
    def check_token(self, run_id: str, token: str | None) -> dict:
        run = self.get(run_id)
        if not token or not run.get("tokenHash") or not hmac.compare_digest(run["tokenHash"], hash_token(token)):
            raise RunError(401, "bad run token")
        return run

    def spec(self, run: dict, minio_bucket: str) -> dict:
        return {k: run.get(k) for k in ("baseModel", "hf", "family", "method", "hyper", "exports", "evalBanditBench",
                                        "smoke", "trainKeys", "resume", "attempt")} | {"runId": run["_id"], "bucket": minio_bucket}

    def progress(self, run: dict, body: dict) -> dict:
        if run["status"] in TERMINAL:
            raise RunError(409, f"run is {run['status']}")
        update: dict[str, Any] = {}
        status = body.get("status")
        if status in WORKER_STATUSES:
            update["status"] = status
        fields = ("step", "totalSteps", "epoch", "loss", "evalLoss", "tokensPerSec", "etaSeconds", "stage", "message")
        progress = {**(run.get("progress") or {}), **{k: body[k] for k in fields if k in body}}
        update["progress"] = progress
        ops: dict[str, Any] = {"$set": {**update, "updatedAt": self.clock()}}
        point = {k: body[k] for k in ("step", "loss", "evalLoss") if body.get(k) is not None}
        if "step" in point and ("loss" in point or "evalLoss" in point):
            ops["$push"] = {"points": {"$each": [point], "$slice": -MAX_POINTS}}
        if body.get("log"):
            lines = [str(line)[:2000] for line in body["log"]][-LOG_TAIL:]
            ops.setdefault("$push", {})["logTail"] = {"$each": lines, "$slice": -LOG_TAIL}
        self.db.runs.update_one({"_id": run["_id"]}, ops)
        return self.get(run["_id"])

    def complete(self, run: dict, body: dict) -> dict:
        return self._set(run["_id"], status="completed", finishedAt=self.clock(),
                         artifacts=body.get("artifacts") or {}, eval=body.get("eval"),
                         ollama={"status": "pending"}, error=None)

    def fail(self, run: dict, body: dict) -> dict:
        return self._set(run["_id"], status="failed", finishedAt=self.clock(),
                         error=str(body.get("error") or "worker failed")[:2000])

    def _set(self, run_id: str, **fields) -> dict:
        fields["updatedAt"] = self.clock()
        self.db.runs.update_one({"_id": run_id}, {"$set": fields})
        return self.get(run_id)
