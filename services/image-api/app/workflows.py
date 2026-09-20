from __future__ import annotations

import os
from typing import Any


def validate_dimension(value: int) -> int:
    if value < 256 or value > 1536 or value % 64:
        raise ValueError("must be 256-1536 and divisible by 64")
    return value


def flux_workflow(
    prompt: str,
    width: int,
    height: int,
    steps: int,
    seed: int,
    *,
    reference_name: str | None = None,
    mask_name: str | None = None,
    strength: float = 0.72,
) -> dict[str, Any]:
    """Build a text-to-image, img2img, or masked-edit FLUX workflow.

    References are uploaded to ComfyUI's private input directory by the API.
    Scaling inside the workflow keeps the browser upload small while making the
    requested canvas size authoritative. ``strength`` maps to KSampler denoise:
    lower values preserve more of the supplied image.
    """
    workflow: dict[str, Any] = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {
            "ckpt_name": os.getenv("FLUX_CHECKPOINT", "flux1-schnell-fp8.safetensors"),
        }},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["1", 1]}},
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

    if reference_name is None:
        workflow["4"] = {"class_type": "EmptySD3LatentImage", "inputs": {
            "width": width, "height": height, "batch_size": 1,
        }}
        return workflow

    workflow["4"] = {"class_type": "LoadImage", "inputs": {"image": reference_name}}
    workflow["8"] = {"class_type": "ImageScale", "inputs": {
        "image": ["4", 0], "upscale_method": "lanczos", "width": width,
        "height": height, "crop": "disabled",
    }}
    latent_node = "9"
    workflow[latent_node] = {"class_type": "VAEEncode", "inputs": {
        "pixels": ["8", 0], "vae": ["1", 2],
    }}

    if mask_name is not None:
        workflow["10"] = {"class_type": "LoadImage", "inputs": {"image": mask_name}}
        workflow["11"] = {"class_type": "ImageScale", "inputs": {
            "image": ["10", 0], "upscale_method": "nearest-exact", "width": width,
            "height": height, "crop": "disabled",
        }}
        workflow["12"] = {"class_type": "ImageToMask", "inputs": {
            "image": ["11", 0], "channel": "red",
        }}
        latent_node = "13"
        workflow[latent_node] = {"class_type": "VAEEncodeForInpaint", "inputs": {
            "pixels": ["8", 0], "vae": ["1", 2], "mask": ["12", 0],
            "grow_mask_by": 6,
        }}

    workflow["5"]["inputs"]["latent_image"] = [latent_node, 0]
    workflow["5"]["inputs"]["denoise"] = strength
    return workflow
