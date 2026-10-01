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

from . import image_models as im
from . import video_workflows as vw
from .swap_workflows import SEED_RATES as SWAP_SEED_RATES

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
    # People swap (Wan2.2-Animate): see app/swap_workflows.py.
    **SWAP_SEED_RATES,
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

    def __init__(self, seeds: dict[str, float] | None = None, *, default_load: float | None = None,
                 fallback_rate: float = FALLBACK_RATE) -> None:
        self.seeds = dict(SEED_RATES if seeds is None else seeds)
        self.default_load = MODEL_LOAD_SECONDS if default_load is None else default_load
        self.fallback_rate = fallback_rate
        self.samples: dict[str, list[float]] = {}
        self.load_samples: list[float] = []
        # Per-image-model load overhead (image models differ by 3x in size).
        self.model_loads: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def rate(self, key: str, default: float | None = None) -> tuple[float, str, int]:
        with self._lock:
            measured = list(self.samples.get(key, []))[-MAX_SAMPLES:]
        seed = self.seeds.get(key)
        if seed is None:
            seed = default if default is not None else self._nearest_seed(key)
        if not measured:
            return seed, "seeded", 0
        padded = measured + [seed] * max(0, MIN_SAMPLES - len(measured))
        return float(statistics.median(padded)), "measured", len(measured)

    def _nearest_seed(self, key: str) -> float:
        pipeline, model, resolution, schedule = (key.split("|") + ["", "", "", ""])[:4]
        for candidate in (f"{pipeline}|{model}|720p|{schedule}", f"i2v|{model}|{resolution}|{schedule}"):
            if candidate in self.seeds:
                return self.seeds[candidate]
        return self.fallback_rate

    def load_seconds(self, model: str | None = None) -> float:
        with self._lock:
            recent = (self.model_loads.get(model, []) if model else self.load_samples)[-MAX_SAMPLES:]
        default = IMAGE_LOAD_SEEDS.get(model, self.default_load) if model else self.default_load
        if len(recent) < MIN_SAMPLES:
            recent = recent + [default] * (MIN_SAMPLES - len(recent))
        return float(statistics.median(recent))

    def record(self, key: str, rate: float, load_seconds: float | None = None, *,
               load_model: str | None = None) -> None:
        if rate <= 0 or rate > 10_000:
            return
        with self._lock:
            bucket = self.samples.setdefault(key, [])
            bucket.append(round(rate, 2))
            del bucket[:-MAX_SAMPLES]
            if load_seconds is not None and 0 <= load_seconds < 1800:
                loads = self.model_loads.setdefault(load_model, []) if load_model else self.load_samples
                loads.append(round(load_seconds, 1))
                del loads[:-MAX_SAMPLES]

    def to_json(self) -> bytes:
        with self._lock:
            return json.dumps({
                "version": 1, "updatedAt": datetime.now(UTC).isoformat(),
                "rates": self.samples, "load": self.load_samples, "modelLoads": self.model_loads,
            }, indent=2).encode()

    def load_json(self, body: bytes) -> None:
        data = json.loads(body or b"{}")
        with self._lock:
            self.samples = {str(k): [float(x) for x in v][-MAX_SAMPLES:]
                            for k, v in (data.get("rates") or {}).items()}
            self.load_samples = [float(x) for x in (data.get("load") or [])][-MAX_SAMPLES:]
            self.model_loads = {str(k): [float(x) for x in v][-MAX_SAMPLES:]
                                for k, v in (data.get("modelLoads") or {}).items()}


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


# --- Images -------------------------------------------------------------------
# An image's GPU time is ``rate x megapixels`` keyed by
# ``image|model|mode|s{steps}``; the seed rate is per-step x steps (plus a
# fixed per-image cost for text encoding and VAE decode, folded into the
# per-step figure at the default step count). Seeds are first estimates for
# the RTX 5090 and are replaced by measurements after three images per key.
IMAGE_STEP_SECONDS: dict[str, float] = {
    # seconds per sampling step per megapixel (warm model)
    "flux-schnell": 0.6, "z-image-turbo": 0.45, "flux2-klein-4b": 0.5,
    "qwen-image": 1.3, "qwen-image-edit": 1.6,
}
IMAGE_FIXED_SECONDS: dict[str, float] = {
    # text encoding + VAE decode + PNG, per image
    "flux-schnell": 2, "z-image-turbo": 2, "flux2-klein-4b": 2, "qwen-image": 4, "qwen-image-edit": 6,
}
IMAGE_LOAD_SEEDS: dict[str, float] = {
    # cold load from the model disk into VRAM, seconds
    "flux-schnell": 25, "z-image-turbo": 25, "flux2-klein-4b": 20, "qwen-image": 45, "qwen-image-edit": 45,
}


def image_key(plan: im.ImagePlan) -> str:
    return f"image|{plan.model.id}|{plan.mode}|s{plan.steps}"


def image_units(plan: im.ImagePlan) -> float:
    """Megapixels generated (the rate's denominator); references add encode work."""
    return max(plan.megapixels, 0.25)


def image_seed_rate(plan: im.ImagePlan) -> float:
    model = plan.model.id
    per_image = IMAGE_STEP_SECONDS.get(model, 1.0) * plan.steps * max(plan.megapixels, 0.25)
    per_image += IMAGE_FIXED_SECONDS.get(model, 3) + 1.5 * plan.references
    return per_image / image_units(plan)


def estimate_image(calibration: Calibration, plan: im.ImagePlan, *, warm_model: str | None = None,
                   images: int = 1) -> dict[str, Any]:
    """Seconds for an image job once the GPU is held. The model load is added
    unless ``warm_model`` says the worker last ran this same model."""
    key = image_key(plan)
    rate, basis, samples = calibration.rate(key, default=image_seed_rate(plan))
    per_image = rate * image_units(plan)
    load = 0.0 if warm_model == plan.model.id else calibration.load_seconds(plan.model.id)
    return {
        "key": key, "basis": basis, "samples": samples,
        "model": plan.model.id, "requestedModel": plan.requested, "mode": plan.mode, "steps": plan.steps,
        "perImageSeconds": round(per_image, 1),
        "loadSeconds": round(load),
        "modelWarm": warm_model == plan.model.id,
        "claimSeconds": round(CLAIM_SECONDS),
        # Excludes the GPU claim; add claimSeconds when the GPU is not ready.
        "seconds": max(1, round(load + per_image * max(1, images))),
    }


def load_from(fetch: Callable[[], bytes | None], calibration: Calibration) -> None:
    try:
        body = fetch()
        if body:
            calibration.load_json(body)
    except Exception as exc:  # stats are an optimisation, never fatal
        logger.warning("could not load video timing stats: %s", type(exc).__name__)


# --- audio (music on the GPU, finishing on the CPU) ---------------------------------

AUDIO_STATS_KEY = "v1/stats/audio-timings.json"
MUSIC_KEY = "music|music-ace15|turbo"
MUSIC_XL_KEY = "music|music-ace15-xl|sft"
# ACE-Step 1.5 turbo: the 1.7B LM writes 5 Hz audio codes, then 8 DiT steps and the
# VAE decode. Seeded from the model card (a full song in under 10 s on a 3090) with
# room for the LM pass, mastering (two-pass loudnorm, MP3, waveform) and upload;
# self-calibrates from the first takes. XL SFT (4B LM, 50 steps with CFG) measured
# about 7 s of ComfyUI time per 30 s on the 5090 with the models warm; seeded high.
MUSIC_LOAD_SECONDS = float(os.getenv("MUSIC_MODEL_LOAD_SECONDS", "30"))
AUDIO_SEED_RATES: dict[str, float] = {
    MUSIC_KEY: 0.5,
    MUSIC_XL_KEY: 0.8,
    # Finishing, seconds of wall clock per second of output on image-api's 2 CPUs:
    # stream copy (music/narration only) vs a libx264 re-encode (captions, logo, hold, fades).
    "finish|copy": 0.25,
    "finish|encode|480p": 0.6, "finish|encode|720p": 1.0, "finish|encode|1080p": 2.0,
}
FINISH_FIXED_SECONDS = 6.0   # measuring the inputs, poster, probe, upload


def audio_calibration() -> Calibration:
    return Calibration(AUDIO_SEED_RATES, default_load=MUSIC_LOAD_SECONDS, fallback_rate=1.0)


def music_render_seconds(duration: float, loopable: bool) -> float:
    return duration + (4.0 if loopable else 0.0)


def music_key(model: str | None) -> str:
    return MUSIC_KEY if model == "music-ace15" else MUSIC_XL_KEY


def estimate_music(calibration: Calibration, duration: float, variants: int = 1, *, loopable: bool = False,
                   model: str | None = None) -> dict[str, Any]:
    key = music_key(model)
    rate, basis, samples = calibration.rate(key)
    per_take = rate * music_render_seconds(duration, loopable) + 4.0  # + mastering and upload
    load = calibration.load_seconds()
    total = load + per_take * max(1, variants)
    return {
        "key": key, "basis": basis, "samples": samples, "ratePerSecond": round(rate, 2),
        "perTakeSeconds": round(per_take), "loadSeconds": round(load), "claimSeconds": round(CLAIM_SECONDS),
        "variants": max(1, variants), "seconds": round(total),
    }


def finish_key(encode: bool, resolution: str) -> str:
    return f"finish|encode|{resolution}" if encode else "finish|copy"


def resolution_of(width: int | None, height: int | None) -> str:
    short = min(width or 720, height or 720)
    return "480p" if short <= 540 else "720p" if short <= 800 else "1080p"


def estimate_finish(calibration: Calibration, *, output_seconds: float, encode: bool, resolution: str,
                    music_seconds: float | None = None) -> dict[str, Any]:
    key = finish_key(encode, resolution)
    rate, basis, samples = calibration.rate(key)
    mix_seconds = FINISH_FIXED_SECONDS + rate * max(1.0, output_seconds)
    music = estimate_music(calibration, music_seconds, 1) if music_seconds else None
    total = mix_seconds + (music["seconds"] if music else 0)
    return {
        "key": key, "basis": basis, "samples": samples, "ratePerSecond": round(rate, 2),
        "mixSeconds": round(mix_seconds), "musicSeconds": music["seconds"] if music else 0,
        # The GPU claim only matters when a bed is generated for this finish.
        "claimSeconds": round(CLAIM_SECONDS) if music else 0,
        "seconds": round(total),
    }
