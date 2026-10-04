"""Base models (Apache-2.0 only) and per-model training defaults.

``minVramGb`` is what a method needs at the default sequence length, so the API can refuse a
run the installed card can't hold (GPU_VRAM_GB, 32 on the RTX 5090; 96 on an RTX PRO 6000).
"""
from __future__ import annotations

from typing import Any

BASE_MODELS: dict[str, dict[str, Any]] = {
    "qwen3-8b": {
        "hf": "Qwen/Qwen3-8B", "family": "qwen3", "licence": "Apache-2.0", "label": "Qwen3 8B",
        # Measured on the 32 GB RTX 5090 (2026-10-03/04): bf16 LoRA and QLoRA rank 32 at 8192 tokens
        # both ran out of memory; QLoRA rank 16 at 6144 fits (collector v2 windows to <= 5.9k tokens).
        "defaultMethod": "qlora", "minVramGb": {"lora": 40, "qlora": 14},
        "hyper": {"rank": 16, "alpha": 32, "lr": 2e-4, "epochs": 2, "maxSeqLen": 6144, "batch": 1, "gradAccum": 16},
        "default": True,
    },
    "qwen3-14b": {
        "hf": "Qwen/Qwen3-14B", "family": "qwen3", "licence": "Apache-2.0", "label": "Qwen3 14B",
        "defaultMethod": "qlora", "minVramGb": {"lora": 44, "qlora": 22},
        "hyper": {"rank": 32, "alpha": 64, "lr": 1.5e-4, "epochs": 2, "maxSeqLen": 8192, "batch": 1, "gradAccum": 16},
    },
    "qwen3-32b": {
        "hf": "Qwen/Qwen3-32B", "family": "qwen3", "licence": "Apache-2.0", "label": "Qwen3 32B (RTX PRO 6000 class)",
        "defaultMethod": "qlora", "minVramGb": {"lora": 90, "qlora": 40},
        "hyper": {"rank": 32, "alpha": 64, "lr": 1e-4, "epochs": 2, "maxSeqLen": 8192, "batch": 1, "gradAccum": 16},
    },
    "gpt-oss-20b": {
        "hf": "unsloth/gpt-oss-20b", "family": "gpt-oss", "licence": "Apache-2.0", "label": "gpt-oss 20B (experimental)",
        "defaultMethod": "qlora", "minVramGb": {"qlora": 16},
        "hyper": {"rank": 16, "alpha": 32, "lr": 2e-4, "epochs": 1, "maxSeqLen": 8192, "batch": 1, "gradAccum": 16},
    },
    # The pipeline check: minutes end to end, never a model anyone should use.
    "qwen3-0.6b": {
        "hf": "Qwen/Qwen3-0.6B", "family": "qwen3", "licence": "Apache-2.0", "label": "Qwen3 0.6B (smoke test)",
        "defaultMethod": "lora", "minVramGb": {"lora": 4, "qlora": 3},
        "hyper": {"rank": 8, "alpha": 16, "lr": 2e-4, "epochs": 1, "maxSeqLen": 2048, "batch": 1, "gradAccum": 4},
        "smoke": True,
    },
}

DEFAULT_BASE = "qwen3-8b"
EXPORTS = ("gguf-q4_k_m", "gguf-q8_0", "safetensors")
HYPER_BOUNDS: dict[str, tuple[float, float]] = {
    "rank": (4, 256), "alpha": (4, 512), "lr": (1e-6, 1e-3), "epochs": (1, 10),
    "maxSeqLen": (512, 32768), "batch": (1, 16), "gradAccum": (1, 128),
}
INT_HYPER = {"rank", "alpha", "epochs", "maxSeqLen", "batch", "gradAccum"}


def resolve_hyper(base: str, overrides: dict | None) -> dict:
    model = BASE_MODELS[base]
    hyper = dict(model["hyper"])
    for key, value in (overrides or {}).items():
        if key not in HYPER_BOUNDS or value is None:
            continue
        lo, hi = HYPER_BOUNDS[key]
        number = float(value)
        if not lo <= number <= hi:
            raise ValueError(f"hyper.{key} must be between {lo:g} and {hi:g}")
        hyper[key] = int(number) if key in INT_HYPER else number
    return hyper


def check_fits(base: str, method: str, vram_gb: float) -> None:
    need = BASE_MODELS[base]["minVramGb"].get(method)
    if need is None:
        raise ValueError(f"{base} does not support {method}")
    if need > vram_gb:
        raise ValueError(f"{base} {method} needs about {need} GB of VRAM; this GPU has {vram_gb:g} GB")


def public_catalog(vram_gb: float) -> list[dict]:
    out = []
    for key, model in BASE_MODELS.items():
        fits = {m: need <= vram_gb for m, need in model["minVramGb"].items()}
        out.append({"id": key, "label": model["label"], "hf": model["hf"], "licence": model["licence"],
                    "defaultMethod": model["defaultMethod"], "fits": fits, "hyper": model["hyper"],
                    "default": bool(model.get("default")), "smoke": bool(model.get("smoke"))})
    return out
