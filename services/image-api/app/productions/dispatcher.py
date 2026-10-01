"""The overnight dispatcher: feeds image-api's in-memory queue one take at a time from Mongo.

Every ``TICK_SECONDS`` it either watches the take in flight or, when the night
window (or a manual session) is open, nothing interactive is queued or running,
the queue is not paused and the GPU is healthy, leases the next take that fits
before the window ends (plus grace) and within the night's GPU budget.

Anton asks :meth:`Dispatcher.intent` once a minute whether productions want the
GPU. It never claims for an empty queue; it releases (gracefully) once nothing
is in flight and nothing more fits.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Callable, Protocol

from . import schedule
from .store import IN_FLIGHT, Store, classify_error, iso

logger = logging.getLogger("burtson.image_api.productions")

TICK_SECONDS = 10
# A take running this long past its estimate is treated as stalled (design §6).
STALL_FACTOR = 3.0
STALL_MIN_SECONDS = 900


class SubmitError(Exception):
    def __init__(self, error_class: str, message: str):
        super().__init__(message)
        self.error_class = error_class


class Executor(Protocol):
    """The in-process image-api queue, as the dispatcher sees it.

    Synchronous: the dispatcher's tick runs in a worker thread (pymongo is
    blocking), and the real executor hops onto the event loop where needed.
    """

    def interactive_busy(self) -> bool: ...
    def worker_ready(self) -> bool: ...
    def submit(self, job: dict) -> str: ...
    def status(self, image_job_id: str) -> dict | None: ...
    def cancel(self, image_job_id: str) -> None: ...
    def take_fields(self, job: dict, image_job: dict) -> dict: ...


@dataclass
class Pick:
    job: dict | None
    estimate: float
    reason: str


class Dispatcher:
    def __init__(self, store: Store, executor: Executor, *, holder: str,
                 clock: Callable[[], datetime] = lambda: datetime.now(UTC),
                 load_seconds: Callable[[], float] = lambda: 40.0):
        self.store = store
        self.executor = executor
        self.holder = holder
        self.clock = clock
        self.load_seconds = load_seconds
        self.last_pipeline_key: str | None = None
        self.last_action = "starting"
        self._task: asyncio.Task | None = None

    # --- planning ---------------------------------------------------------------
    def _take_seconds(self, job: dict, per_take: Callable[[dict], int], last_key: str | None) -> float:
        load = self.load_seconds() if job.get("pipelineKey") != last_key else 0.0
        return float(per_take(job)) + load

    def next_fitting(self, now: datetime, settings: dict, window: schedule.Window) -> Pick:
        """First queued take (dispatch order) that fits the window and the budget."""
        candidates = self.store.candidates(now)
        if not candidates:
            return Pick(None, 0, "Nothing is queued")
        per_take = self.store._estimates()
        remaining = window.remaining(now) + (int(settings.get("graceMinutes", 10)) * 60
                                             if window.kind == "night" else 0)
        budget_left = self._budget_left(settings, window)
        if budget_left <= 0:
            return Pick(None, 0, "Tonight's GPU budget is used up")
        for job in candidates:
            seconds = self._take_seconds(job, per_take, self.last_pipeline_key)
            if seconds <= remaining and seconds <= budget_left:
                return Pick(job, seconds, f"{len(candidates)} take(s) queued")
        if all(self._take_seconds(j, per_take, self.last_pipeline_key) > budget_left for j in candidates):
            return Pick(None, 0, "The next take does not fit in tonight's remaining GPU budget")
        return Pick(None, 0, "The next take would not finish before the window ends")

    def _budget_left(self, settings: dict, window: schedule.Window) -> float:
        used = self.store.night(window)["gpuSeconds"]
        return float(settings.get("budgetMinutes", 480)) * 60 - float(used)

    def intent(self, now: datetime | None = None) -> dict:
        """What Anton should do with the GPU for productions right now."""
        now = now or self.clock()
        settings = self.store.settings()
        health = self.store.health()
        window = schedule.active_window(now, settings)
        until = iso(window.end) if window else None
        base = {"healthy": bool(health.get("healthy", True)), "until": until}
        if self.store.in_flight():
            # Never cut a take off, whatever the window, pause or health says.
            return {**base, "wantGpu": True, "releaseWhenDone": False, "reason": "A take is rendering"}
        if settings.get("paused"):
            return {**base, "wantGpu": False, "releaseWhenDone": True,
                    "reason": settings.get("pausedReason") or "Paused"}
        if not health.get("healthy", True):
            return {**base, "wantGpu": False, "releaseWhenDone": True,
                    "reason": f"GPU unhealthy: {health.get('reason') or 'unknown'}"}
        if window is None:
            return {**base, "wantGpu": False, "releaseWhenDone": True, "reason": "Outside the night window"}
        pick = self.next_fitting(now, settings, window)
        if pick.job is None:
            return {**base, "wantGpu": False, "releaseWhenDone": True, "reason": pick.reason}
        return {**base, "wantGpu": True, "releaseWhenDone": False, "reason": pick.reason}

    def tonight(self, now: datetime | None = None) -> dict:
        """Queued work against the current (or next) window: what fits, and when the GPU is claimed."""
        now = now or self.clock()
        settings = self.store.settings()
        window = schedule.active_window(now, settings) or schedule.window_at(now, settings)
        pending = self.store.pending_eligible(now)
        per_take = self.store._estimates()
        remaining = (window.remaining(now) if window.open else window.length()) - (
            0 if window.open else schedule.CLAIM_OVERHEAD_SECONDS)
        if window.kind == "night":
            remaining += int(settings.get("graceMinutes", 10)) * 60
        budget_left = self._budget_left(settings, window) if window.open else float(settings["budgetMinutes"]) * 60
        total = 0.0
        fit_seconds = 0.0
        fit = 0
        last_key = self.last_pipeline_key if window.open else None
        for job in pending:
            seconds = self._take_seconds(job, per_take, last_key)
            total += seconds
            if fit_seconds + seconds <= min(remaining, budget_left):
                fit_seconds += seconds
                fit += 1
                last_key = job.get("pipelineKey")
        night = self.store.night(window)
        claims_at = None
        if pending and not settings.get("paused"):
            claims_at = iso(now) if window.open else iso(window.start)
        return {
            "queuedTakes": len(pending), "estimatedSeconds": round(total), "fitTakes": fit,
            "fitSeconds": round(fit_seconds), "budgetMinutes": int(settings["budgetMinutes"]),
            "usedMinutes": round(float(night["gpuSeconds"]) / 60, 1) if window.open else 0.0,
            "claimsAt": claims_at,
        }

    def status(self, now: datetime | None = None) -> dict:
        now = now or self.clock()
        settings = self.store.settings()
        session = schedule.session_window(now, settings.get("session"))
        window = schedule.window_at(now, settings)
        in_flight = self.store.in_flight()
        flight = None
        if in_flight:
            job = in_flight[0]
            image_job = self.executor.status(job["imageApiJobId"]) if job.get("imageApiJobId") else None
            flight = {"jobId": job["_id"], "takeId": job["_id"], "shotId": job["shotId"],
                      "productionId": job["productionId"], "startedAt": job.get("startedAt"),
                      "estimateSeconds": job.get("estimateSeconds"),
                      "stage": ((image_job or {}).get("progress") or {}).get("stage")}
        public_settings = {k: settings.get(k) for k in schedule.DEFAULT_SETTINGS}
        return {
            "settings": public_settings, "now": iso(now),
            "window": {"open": window.open, "start": iso(window.start), "end": iso(window.end)},
            "session": {"until": session.end.isoformat(), "startedAt": settings["session"].get("startedAt")}
            if session else None,
            "intent": self.intent(now), "health": self.store.health(), "tonight": self.tonight(now),
            "inFlight": flight, "lastNight": self.store.last_night(), "dispatcher": self.last_action,
        }

    # --- the loop ---------------------------------------------------------------
    def tick(self) -> str:
        now = self.clock()
        settings = self.store.settings()
        window = schedule.active_window(now, settings)
        in_flight = self.store.in_flight()
        if in_flight:
            actions = [self._watch(job, now) for job in in_flight]
            return self._done(actions[0])
        if settings.get("paused"):
            return self._done("paused")
        if not self.store.health().get("healthy", True):
            return self._done("gpu-unhealthy")
        if window is None:
            return self._done("outside-window")
        if self.executor.interactive_busy():
            return self._done("interactive-first")
        pick = self.next_fitting(now, settings, window)
        if pick.job is None:
            return self._done("nothing-fits" if "Nothing" not in pick.reason else "queue-empty")
        if not self.executor.worker_ready():
            return self._done("waiting-for-gpu")
        night = {"id": window.night_id, "start": iso(window.start), "end": iso(window.end), "kind": window.kind}
        leased = self.store.lease(pick.job["_id"], self.holder, 2 * pick.estimate + 300, night=night)
        if not leased:
            return self._done("lease-lost")
        try:
            image_job_id = self.executor.submit(leased)
        except SubmitError as exc:
            status = self.store.fail(leased, exc.error_class, str(exc))
            logger.warning("productions: take %s could not be submitted (%s): %s -> %s",
                           leased["_id"], exc.error_class, exc, status)
            return self._done("submit-failed")
        except Exception as exc:  # noqa: BLE001 - a bug here must not wedge the queue
            status = self.store.fail(leased, "transient", f"{type(exc).__name__}: {exc}")
            logger.exception("productions: submit of %s crashed -> %s", leased["_id"], status)
            return self._done("submit-failed")
        self.store.mark_submitted(leased["_id"], image_job_id, pick.estimate)
        self.last_pipeline_key = leased.get("pipelineKey")
        logger.info("productions: dispatched take %s (shot %s, ~%ds) as image job %s",
                    leased["_id"], leased["shotId"], pick.estimate, image_job_id)
        return self._done("dispatched")

    def _done(self, action: str) -> str:
        self.last_action = action
        return action

    def _watch(self, job: dict, now: datetime) -> str:
        image_job_id = job.get("imageApiJobId")
        lease = job.get("lease") or {}
        if not image_job_id:
            expired = lease.get("expiresAt") and datetime.fromisoformat(lease["expiresAt"]) <= now
            if lease.get("holder") != self.holder or expired:
                self.store.fail(job, "lost", "the dispatcher restarted before submitting this take")
                return "recovered-lost"
            return "leased"
        image_job = self.executor.status(image_job_id)
        if image_job is None:
            # image-api restarted (or the in-memory job expired): the take is gone.
            status = self.store.fail(job, "lost", "image-api restarted while this take was rendering")
            logger.warning("productions: take %s lost in a restart -> %s", job["_id"], status)
            return "recovered-lost"
        state = image_job.get("status")
        if state in ("queued", "running"):
            if state == "running" and job["status"] != "running":
                self.store.mark_running(job["_id"], image_job.get("startedAt"))
            started = image_job.get("startedAt")
            if started:
                elapsed = (now - datetime.fromisoformat(started)).total_seconds()
                estimate = float(job.get("estimateSeconds") or 300)
                if elapsed > max(STALL_FACTOR * estimate, estimate + STALL_MIN_SECONDS):
                    self.executor.cancel(image_job_id)
                    status = self.store.fail(job, "timeout", f"stalled: {round(elapsed)} s against an "
                                                             f"estimate of {round(estimate)} s", gpu_seconds=elapsed)
                    logger.warning("productions: take %s stalled -> %s", job["_id"], status)
                    return "stalled"
            return "watching"
        gpu_seconds = elapsed_seconds(image_job)
        if state == "completed" and image_job.get("videos"):
            take = self.executor.take_fields(job, image_job)
            self.store.complete(job, take, gpu_seconds=gpu_seconds)
            logger.info("productions: take %s done in %ds (estimate %ss)", job["_id"], gpu_seconds,
                        job.get("estimateSeconds"))
            return "completed"
        if state == "cancelled":
            # A forced release ("Stop now") cancels it; the take goes back in the queue.
            self.store.fail(job, "released", "cancelled by a forced GPU release")
            return "requeued-cancelled"
        message = image_job.get("error") or "the take finished without a video"
        status = self.store.fail(job, classify_error(message), message, gpu_seconds=gpu_seconds)
        logger.warning("productions: take %s failed (%s) -> %s", job["_id"], message[:200], status)
        return "failed"

    async def run(self) -> None:
        indexed = False
        while True:
            try:
                if not indexed:
                    await asyncio.to_thread(self.store.ensure_indexes)
                    indexed = True
                await asyncio.to_thread(self.tick)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("productions: dispatcher tick failed")
            await asyncio.sleep(TICK_SECONDS)

    def start(self) -> None:
        self._task = asyncio.create_task(self.run())

    def stop(self) -> None:
        if self._task:
            self._task.cancel()


def elapsed_seconds(image_job: dict) -> float:
    started, finished = image_job.get("startedAt"), image_job.get("updatedAt")
    if not started or not finished:
        return 0.0
    try:
        return max(0.0, (datetime.fromisoformat(finished) - datetime.fromisoformat(started)).total_seconds())
    except ValueError:
        return 0.0


__all__ = ["Dispatcher", "Executor", "SubmitError", "IN_FLIGHT", "TICK_SECONDS"]
