from __future__ import annotations

import os
from typing import Any


def validate_dimension(value: int) -> int:
    if value < 256 or value > 1536 or value % 64:
        raise ValueError("must be 256-1536 and divisible by 64")
    return value


def flux_workflow(prompt: str, width: int, height: int, steps: int, seed: int) -> dict[str, Any]:
    """ComfyUI API workflow for the official all-in-one FLUX.1 Schnell FP8 checkpoint."""
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {
            "ckpt_name": os.getenv("FLUX_CHECKPOINT", "flux1-schnell-fp8.safetensors"),
        }},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["1", 1]}},
        "4": {"class_type": "EmptySD3LatentImage", "inputs": {
            "width": width, "height": height, "batch_size": 1,
        }},
        "5": {"class_type": "KSampler", "inputs": {
            "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0],
            "latent_image": ["4", 0], "seed": seed, "steps": steps, "cfg": 1.0,
            "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0,
        }},
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage", "inputs": {
            "filename_prefix": "burtson", "images": ["6", 0],
        }},
    }
