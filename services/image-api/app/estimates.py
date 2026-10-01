"""Self-calibrating time estimates for video jobs.

A take's GPU time is modelled as ``rate x generated seconds`` where the rate
(seconds of wall-clock per second of generated footage, including decode,
upscale, interpolation, encode and upload) is looked up by
``pipeline|model|resolution|schedule``. A job adds one model-load overhead,
and a client that has not claimed the GPU adds the claim time.

Seeds are the measured smoke-test numbers on the RTX 5090 (2026-09-30). Every
completed take records its actual rate; the estimate uses the median of the
recent samples for its key (seeded toward the table until three samples
exist). Samples persist in MinIO so they survive restarts of this in-process
service.
"""
from __future__ import annotations

import json
import logging
import os
import statistics
import threading
from datetime import UTC, datetime
from typing import Any, Callable

from . import video_workflows as vw

logger = logging.getLogger("burtson.image_api.estimates")

STATS_KEY = "v1/stats/video-timings.json"  # outside the tenant TTL prefix
MAX_SAMPLES = 15
MIN_SAMPLES = 3

CLAIM_SECONDS = float(os.getenv("VIDEO_CLAIM_SECONDS", "45"))
MODEL_LOAD_SECONDS = float(os.getenv("VIDEO_MODEL_LOAD_SECONDS", "40"))
FALLBACK_RATE = 40.0

# Seconds per generated second per take. Measured on the 5090 where noted;
# others scaled from the nearest measurement.
SEED_RATES: dict[str, float] = {
    # A14B text-to-video, Lightning: 720p 5 s measured 148 s.
    "t2v|video-quality|480p|lightning": 16, "t2v|video-quality|720p|lightning": 30,
    "t2v|video-quality|1080p|lightning": 41,
    # A14B image-to-video, Lightning: 1080p 5 s takes measured 194-205 s.
    "i2v|video-quality|480p|lightning": 15, "i2v|video-quality|720p|lightning": 28,
    "i2v|video-quality|1080p|lightning": 40,
    "flf|video-quality|480p|lightning": 15, "flf|video-quality|720p|lightning": 28,
    "flf|video-quality|1080p|lightning": 40,
    # Full 20-step schedule: about 3.5x the Lightning sampling cost.
    "t2v|video-quality|480p|full": 55, "t2v|video-quality|720p|full": 100,
    "t2v|video-quality|1080p|full": 115,
    "i2v|video-quality|480p|full": 52, "i2v|video-quality|720p|full": 95,
    "i2v|video-quality|1080p|full": 110,
    "flf|video-quality|480p|full": 52, "flf|video-quality|720p|full": 95,
    "flf|video-quality|1080p|full": 110,
    # VACE: Lightning 720p 5 s measured 204-209 s; full 480p 5 s 363-403 s.
    "vace|video-quality|480p|lightning": 20, "vace|video-quality|720p|lightning": 42,
    "vace|video-quality|1080p|lightning": 55,
    "vace|video-quality|480p|full": 77, "vace|video-quality|720p|full": 170,
    "vace|video-quality|1080p|full": 185,
    # 5B, 20 steps: 30-step runs measured 56 s (480p) and 225-246 s (720p).
    "t2v|video-fast|480p|steps20": 8, "t2v|video-fast|720p|steps20": 32,
    "i2v|video-fast|480p|steps20": 8, "i2v|video-fast|720p|steps20": 32,
}


def schedule_of(plan: vw.VideoPlan) -> str:
    if plan.model.alias == "video-fast":
        return f"steps{plan.steps}"
    return "lightning" if plan.accelerated else "full"


def key_of(plan: vw.VideoPlan) -> str:
    return f"{plan.kind}|{plan.model.alias}|{plan.resolution}|{schedule_of(plan)}"


def generated_seconds(plan: vw.VideoPlan) -> float:
    """Seconds of footage the model actually generates for one take."""
    frames = sum(plan.segments) - (len(plan.segments) - 1)
    return max(frames - 1, 1) / plan.model.native_fps


class Calibration:
    """Recent per-key rate samples plus the model-load overhead."""

    def __init__(self, seeds: dict[str, float] | None = None) -> None:
        self.seeds = dict(SEED_RATES if seeds is None else seeds)
        self.samples: dict[str, list[float]] = {}
        self.load_samples: list[float] = []
        self._lock = threading.Lock()

    def rate(self, key: str) -> tuple[float, str, int]:
        with self._lock:
            measured = list(self.samples.get(key, []))[-MAX_SAMPLES:]
        seed = self.seeds.get(key)
        if seed is None:
            seed = self._nearest_seed(key)
        if not measured:
            return seed, "seeded", 0
        padded = measured + [seed] * max(0, MIN_SAMPLES - len(measured))
        return float(statistics.median(padded)), "measured", len(measured)

    def _nearest_seed(self, key: str) -> float:
        pipeline, model, resolution, schedule = (key.split("|") + ["", "", "", ""])[:4]
        for candidate in (f"{pipeline}|{model}|720p|{schedule}", f"i2v|{model}|{resolution}|{schedule}"):
            if candidate in self.seeds:
                return self.seeds[candidate]
        return FALLBACK_RATE

    def load_seconds(self) -> float:
        with self._lock:
            recent = self.load_samples[-MAX_SAMPLES:]
        if len(recent) < MIN_SAMPLES:
            recent = recent + [MODEL_LOAD_SECONDS] * (MIN_SAMPLES - len(recent))
        return float(statistics.median(recent))

    def record(self, key: str, rate: float, load_seconds: float | None = None) -> None:
        if rate <= 0 or rate > 10_000:
            return
        with self._lock:
            bucket = self.samples.setdefault(key, [])
            bucket.append(round(rate, 2))
            del bucket[:-MAX_SAMPLES]
            if load_seconds is not None and 0 <= load_seconds < 1800:
                self.load_samples.append(round(load_seconds, 1))
                del self.load_samples[:-MAX_SAMPLES]

    def to_json(self) -> bytes:
        with self._lock:
            return json.dumps({
                "version": 1, "updatedAt": datetime.now(UTC).isoformat(),
                "rates": self.samples, "load": self.load_samples,
            }, indent=2).encode()

    def load_json(self, body: bytes) -> None:
        data = json.loads(body or b"{}")
        with self._lock:
            self.samples = {str(k): [float(x) for x in v][-MAX_SAMPLES:]
                            for k, v in (data.get("rates") or {}).items()}
            self.load_samples = [float(x) for x in (data.get("load") or [])][-MAX_SAMPLES:]


def estimate_plan(calibration: Calibration, plan: vw.VideoPlan, variants: int) -> dict[str, Any]:
    key = key_of(plan)
    rate, basis, samples = calibration.rate(key)
    per_take = rate * generated_seconds(plan)
    load = calibration.load_seconds()
    total = load + per_take * max(1, variants)
    return {
        "key": key, "basis": basis, "samples": samples,
        "ratePerSecond": round(rate, 2),
        "perTakeSeconds": round(per_take),
        "loadSeconds": round(load),
        "claimSeconds": round(CLAIM_SECONDS),
        "variants": max(1, variants),
        # Excludes the GPU claim; add claimSeconds when the GPU is not ready.
        "seconds": round(total),
    }


def load_from(fetch: Callable[[], bytes | None], calibration: Calibration) -> None:
    try:
        body = fetch()
        if body:
            calibration.load_json(body)
    except Exception as exc:  # stats are an optimisation, never fatal
        logger.warning("could not load video timing stats: %s", type(exc).__name__)
