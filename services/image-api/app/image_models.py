"""Selectable image models and their server-owned, versioned ComfyUI workflows.

Callers pick a model id and say what they want (prompt, canvas, steps, seed,
reference images, mask, strength). Everything else — files, samplers, CFG,
shifts, reference handling — is fixed here and recorded against a workflow
version in every job's provenance. Callers never submit graphs or file names.

All weights are Apache-2.0 and live on the read-only ``image-models`` volume;
``/mnt/ai-models/comfyui/manifests/MODELS-image.md`` records the source
repository, revision and SHA-256 of every file. The pinned ComfyUI commit has
native nodes for all of them (no custom nodes).

    flux-schnell     FLUX.1 Schnell, fp8 all-in-one checkpoint. Generate, img2img, masked edit.
    z-image-turbo    Z-Image-Turbo (6B), 8 steps. Generate and img2img. "Fast".
    flux2-klein-4b   FLUX.2 Klein 4B (distilled), 4 steps. Generate and multi-reference edit. "Balanced".
    qwen-image       Qwen-Image-2512 (20B, fp8). Generate; best detail and lettering. "Quality".
    qwen-image-edit  Qwen-Image-Edit-2511 (20B, fp8 mixed). Edit with 1-3 reference images.

``qwen-image`` with a reference image runs the ``qwen-image-edit`` workflow:
the edit model is Quality's edit path. FLUX.2 Klein **9B** is non-commercial
and deliberately not offered.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Literal

# Every image workflow writes its PNG from this node.
OUTPUT_NODE = "99"


@dataclass(frozen=True)
class ImageModel:
    id: str
    label: str
    tier: str  # one word for the picker: Fast / Balanced / Quality / Classic
    description: str
    license: str
    revision: str  # upstream repo @ revision of the weights in use
    workflow_version: str
    generate: bool
    edit: bool
    max_references: int  # 0 = no reference images
    mask: bool
    strength: bool  # img2img denoise applies (references are re-noised)
    default_steps: int
    max_steps: int
    max_side: int
    max_megapixels: float
    files: dict[str, str] = field(default_factory=dict)  # file -> sha256
    speed: str = ""
    quality: str = ""

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id, "label": self.label, "tier": self.tier, "description": self.description,
            "license": self.license, "revision": self.revision, "workflowVersion": self.workflow_version,
            "capabilities": {
                "generate": self.generate, "edit": self.edit, "multiReference": self.max_references > 1,
                "maxReferences": self.max_references, "mask": self.mask, "strength": self.strength,
            },
            "defaultSteps": self.default_steps, "maxSteps": self.max_steps,
            "maxSide": self.max_side, "maxMegapixels": self.max_megapixels,
            "speed": self.speed, "quality": self.quality,
        }


FLUX_SCHNELL_FILE = "flux1-schnell-fp8.safetensors"
QWEN_TEXT_ENCODER = "qwen_2.5_vl_7b_fp8_scaled.safetensors"
QWEN_VAE = "qwen_image_vae.safetensors"
QWEN3_4B = "qwen_3_4b.safetensors"

# Qwen-Image's published negative prompt (ComfyUI template for 2512).
QWEN_NEGATIVE = (
    "低分辨率，低画质，肢体畸形，手指畸形，画面过饱和，蜡像感，人脸无细节，过度光滑，画面具有AI感。"
    "构图混乱。文字模糊，扭曲"
)

MODELS: dict[str, ImageModel] = {
    model.id: model for model in (
        ImageModel(
            id="flux2-klein-4b", label="FLUX.2 Klein 4B", tier="Balanced",
            description="Fast and sharp; edits with up to 4 reference images.",
            license="Apache-2.0", revision="black-forest-labs/FLUX.2-klein-4B@e7b7dc27f91deacad38e78976d1f2b499d76a294",
            workflow_version="flux2-klein-4b-v1", generate=True, edit=True, max_references=4,
            mask=False, strength=False, default_steps=4, max_steps=8, max_side=2048, max_megapixels=4.2,
            files={
                "flux-2-klein-4b.safetensors": "ec3d4e733a771f61c052fb4856c48b336c55eaf2c65487c2a1faeb9bbda7a343",
                QWEN3_4B: "6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a",
                "flux2-vae.safetensors": "868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3",
            },
            speed="fast", quality="good",
        ),
        ImageModel(
            id="qwen-image", label="Qwen-Image 2512", tier="Quality",
            description="Best detail and lettering; slower. With a reference image it uses Qwen-Image-Edit.",
            license="Apache-2.0", revision="Qwen/Qwen-Image-2512@25468b98e3276ca6700de15c6628e51b7de54a26",
            workflow_version="qwen-image-2512-v1", generate=True, edit=True, max_references=3,
            mask=False, strength=False, default_steps=30, max_steps=50, max_side=2048, max_megapixels=4.2,
            files={
                "qwen_image_2512_fp8_e4m3fn.safetensors": "5dc80554d5d83390046a2f4a94ece06afb7700bf7b0aaf8bde9769793875876b",
                QWEN_TEXT_ENCODER: "cb5636d852a0ea6a9075ab1bef496c0db7aef13c02350571e388aea959c5c0b4",
                QWEN_VAE: "a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f",
            },
            speed="slow", quality="best",
        ),
        ImageModel(
            id="qwen-image-edit", label="Qwen-Image-Edit 2511", tier="Quality edit",
            description="Edits from 1-3 reference images: combine people, objects and styles; keeps faces and text.",
            license="Apache-2.0", revision="Qwen/Qwen-Image-Edit-2511@6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9",
            workflow_version="qwen-image-edit-2511-v1", generate=False, edit=True, max_references=3,
            mask=False, strength=False, default_steps=20, max_steps=40, max_side=2048, max_megapixels=4.2,
            files={
                "qwen_image_edit_2511_fp8mixed.safetensors": "c9fdc158e46d3b61ef75f21ae866ca2fe808bf4a53643120d1c1e87c19280a4e",
                QWEN_TEXT_ENCODER: "cb5636d852a0ea6a9075ab1bef496c0db7aef13c02350571e388aea959c5c0b4",
                QWEN_VAE: "a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f",
            },
            speed="slow", quality="best",
        ),
        ImageModel(
            id="z-image-turbo", label="Z-Image-Turbo", tier="Fast",
            description="Quickest photoreal results in a few steps; simple image-to-image.",
            license="Apache-2.0", revision="Tongyi-MAI/Z-Image-Turbo@f332072aa78be7aecdf3ee76d5c247082da564a6",
            workflow_version="z-image-turbo-v1", generate=True, edit=True, max_references=1,
            mask=False, strength=True, default_steps=8, max_steps=16, max_side=2048, max_megapixels=4.2,
            files={
                "z_image_turbo_bf16.safetensors": "2407613050b809ffdff18a4ac99af83ea6b95443ecebdf80e064a79c825574a6",
                QWEN3_4B: "6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a",
                "ae.safetensors": "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38",
            },
            speed="fastest", quality="good",
        ),
        ImageModel(
            id="flux-schnell", label="FLUX.1 Schnell", tier="Classic",
            description="The original studio model; img2img and masked edits.",
            license="Apache-2.0", revision="black-forest-labs/FLUX.1-schnell@741f7c3ce8b383c54771c7003378a50191e9efe9",
            workflow_version="flux-schnell-v1", generate=True, edit=True, max_references=1,
            mask=True, strength=True, default_steps=4, max_steps=12, max_side=1536, max_megapixels=2.4,
            files={FLUX_SCHNELL_FILE: os.getenv("FLUX_MODEL_SHA256", "unverified")},
            speed="fast", quality="fair",
        ),
    )
}

ModelId = Literal["flux-schnell", "z-image-turbo", "flux2-klein-4b", "qwen-image", "qwen-image-edit"]
MODEL_IDS = tuple(MODELS)
DEFAULT_MODEL = "flux-schnell"  # API default stays put for existing callers.
MAX_REFERENCES = max(model.max_references for model in MODELS.values())


@dataclass(frozen=True)
class ImagePlan:
    """The resolved, validated recipe for one image."""
    requested: str
    model: ImageModel
    mode: str  # "generate" | "edit"
    width: int
    height: int
    steps: int
    references: int
    mask: bool
    strength: float | None

    @property
    def megapixels(self) -> float:
        return self.width * self.height / 1_048_576

    def describe(self) -> dict[str, Any]:
        return {
            "model": self.model.id, "requestedModel": self.requested, "mode": self.mode,
            "workflowVersion": self.model.workflow_version, "width": self.width, "height": self.height,
            "steps": self.steps, "references": self.references, "mask": self.mask, "strength": self.strength,
        }


def resolve_model(requested: str, references: int) -> ImageModel:
    if requested not in MODELS:
        raise ValueError(f"unknown model {requested!r}; choose one of {', '.join(MODEL_IDS)}")
    if requested == "qwen-image" and references:
        return MODELS["qwen-image-edit"]
    return MODELS[requested]


def plan_image(requested: str, *, width: int, height: int, steps: int | None, references: int = 0,
               mask: bool = False, strength: float | None = None) -> ImagePlan:
    """Validate a request against the chosen model; raises ValueError with a user-facing reason."""
    model = resolve_model(requested, references)
    if references and not model.edit:
        raise ValueError(f"{model.label} does not edit images")
    if not references and not model.generate:
        raise ValueError(f"{model.label} edits images: attach a reference image, or pick another model")
    if references > model.max_references:
        raise ValueError(
            f"{model.label} takes at most {model.max_references} reference image"
            f"{'' if model.max_references == 1 else 's'}")
    if mask and not model.mask:
        raise ValueError(f"masked edits need FLUX.1 Schnell; {model.label} does not use a mask")
    if mask and not references:
        raise ValueError("a mask needs a reference image")
    if max(width, height) > model.max_side:
        raise ValueError(f"{model.label} renders at most {model.max_side} px per side")
    if width * height > model.max_megapixels * 1_048_576:
        raise ValueError(f"{model.label} renders at most {model.max_megapixels:g} MP")
    resolved_steps = model.default_steps if steps is None else steps
    if not 1 <= resolved_steps <= model.max_steps:
        raise ValueError(f"{model.label} takes 1-{model.max_steps} steps")
    return ImagePlan(
        requested=requested, model=model, mode="edit" if references else "generate",
        width=width, height=height, steps=resolved_steps, references=references, mask=mask,
        strength=strength if (references and model.strength) else None,
    )


def build_workflow(plan: ImagePlan, prompt: str, seed: int, *, reference_names: list[str] | None = None,
                   mask_name: str | None = None, filename_prefix: str = "burtson") -> dict[str, Any]:
    """The ComfyUI API graph for a plan. ``OUTPUT_NODE`` is its SaveImage."""
    names = list(reference_names or [])
    if len(names) != plan.references:
        raise ValueError("reference names do not match the plan")
    builder = BUILDERS[plan.model.id]
    workflow = builder(plan, prompt, seed, names, mask_name)
    workflow[OUTPUT_NODE] = {"class_type": "SaveImage", "inputs": {
        "filename_prefix": filename_prefix, "images": [workflow.pop("_decoded"), 0],
    }}
    return workflow


def _scaled_reference(workflow: dict, node: str, name: str, width: int, height: int) -> str:
    """LoadImage + exact-canvas lanczos scale; returns the scaled node id."""
    workflow[f"{node}0"] = {"class_type": "LoadImage", "inputs": {"image": name}}
    workflow[f"{node}1"] = {"class_type": "ImageScale", "inputs": {
        "image": [f"{node}0", 0], "upscale_method": "lanczos", "width": width, "height": height,
        "crop": "disabled",
    }}
    return f"{node}1"


def _flux_schnell(plan: ImagePlan, prompt: str, seed: int, names: list[str], mask_name: str | None) -> dict:
    from .workflows import flux_workflow  # the original v1 graph, unchanged

    workflow = flux_workflow(
        prompt, plan.width, plan.height, plan.steps, seed,
        reference_name=names[0] if names else None, mask_name=mask_name,
        strength=plan.strength if plan.strength is not None else 0.72,
    )
    workflow.pop("7")
    workflow["_decoded"] = "6"
    return workflow


def _z_image_turbo(plan: ImagePlan, prompt: str, seed: int, names: list[str], _mask: str | None) -> dict:
    workflow: dict[str, Any] = {
        "1": {"class_type": "UNETLoader", "inputs": {
            "unet_name": "z_image_turbo_bf16.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": QWEN3_4B, "type": "lumina2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
        "4": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": 3.0}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "6": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["5", 0]}},
        "8": {"class_type": "KSampler", "inputs": {
            "model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["7", 0],
            "seed": seed, "steps": plan.steps, "cfg": 1.0, "sampler_name": "res_multistep",
            "scheduler": "simple", "denoise": 1.0,
        }},
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}},
        "_decoded": "9",
    }
    if names:
        scaled = _scaled_reference(workflow, "2", names[0], plan.width, plan.height)
        workflow["7"] = {"class_type": "VAEEncode", "inputs": {"pixels": [scaled, 0], "vae": ["3", 0]}}
        workflow["8"]["inputs"]["denoise"] = plan.strength if plan.strength is not None else 0.72
    else:
        workflow["7"] = {"class_type": "EmptySD3LatentImage", "inputs": {
            "width": plan.width, "height": plan.height, "batch_size": 1}}
    return workflow


def _flux2_klein(plan: ImagePlan, prompt: str, seed: int, names: list[str], _mask: str | None) -> dict:
    workflow: dict[str, Any] = {
        "1": {"class_type": "UNETLoader", "inputs": {
            "unet_name": "flux-2-klein-4b.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": QWEN3_4B, "type": "flux2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "flux2-vae.safetensors"}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["2", 0]}},
        "6": {"class_type": "EmptyFlux2LatentImage", "inputs": {
            "width": plan.width, "height": plan.height, "batch_size": 1}},
        "7": {"class_type": "Flux2Scheduler", "inputs": {
            "steps": plan.steps, "width": plan.width, "height": plan.height}},
        "9": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "10": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}},
        "_decoded": "12",
    }
    positive, negative = ["4", 0], ["5", 0]
    # Each reference: ~1 MP, VAE-encoded, chained onto both conditionings.
    for index, name in enumerate(names):
        node = f"3{index}"
        workflow[f"{node}0"] = {"class_type": "LoadImage", "inputs": {"image": name}}
        workflow[f"{node}1"] = {"class_type": "ImageScaleToTotalPixels", "inputs": {
            "image": [f"{node}0", 0], "upscale_method": "lanczos", "megapixels": 1.0, "resolution_steps": 16}}
        workflow[f"{node}2"] = {"class_type": "VAEEncode", "inputs": {"pixels": [f"{node}1", 0], "vae": ["3", 0]}}
        workflow[f"{node}3"] = {"class_type": "ReferenceLatent", "inputs": {
            "conditioning": positive, "latent": [f"{node}2", 0]}}
        workflow[f"{node}4"] = {"class_type": "ReferenceLatent", "inputs": {
            "conditioning": negative, "latent": [f"{node}2", 0]}}
        positive, negative = [f"{node}3", 0], [f"{node}4", 0]
    # Distilled Klein: CFG 1 (the negative branch is not evaluated).
    workflow["8"] = {"class_type": "CFGGuider", "inputs": {
        "model": ["1", 0], "positive": positive, "negative": negative, "cfg": 1.0}}
    workflow["11"] = {"class_type": "SamplerCustomAdvanced", "inputs": {
        "noise": ["10", 0], "guider": ["8", 0], "sampler": ["9", 0], "sigmas": ["7", 0],
        "latent_image": ["6", 0]}}
    return workflow


def _qwen_image(plan: ImagePlan, prompt: str, seed: int, names: list[str], mask: str | None) -> dict:
    if names:
        return _qwen_image_edit(plan, prompt, seed, names, mask)
    return {
        "1": {"class_type": "UNETLoader", "inputs": {
            "unet_name": "qwen_image_2512_fp8_e4m3fn.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": QWEN_TEXT_ENCODER, "type": "qwen_image", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": QWEN_VAE}},
        "4": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": 3.1}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": QWEN_NEGATIVE, "clip": ["2", 0]}},
        "7": {"class_type": "EmptySD3LatentImage", "inputs": {
            "width": plan.width, "height": plan.height, "batch_size": 1}},
        "8": {"class_type": "KSampler", "inputs": {
            "model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["7", 0],
            "seed": seed, "steps": plan.steps, "cfg": 4.0, "sampler_name": "euler",
            "scheduler": "simple", "denoise": 1.0,
        }},
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}},
        "_decoded": "9",
    }


def _qwen_image_edit(plan: ImagePlan, prompt: str, seed: int, names: list[str], _mask: str | None) -> dict:
    workflow: dict[str, Any] = {
        "1": {"class_type": "UNETLoader", "inputs": {
            "unet_name": "qwen_image_edit_2511_fp8mixed.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": QWEN_TEXT_ENCODER, "type": "qwen_image", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": QWEN_VAE}},
        "4": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": 3.1}},
        "5": {"class_type": "CFGNorm", "inputs": {"model": ["4", 0], "strength": 1.0}},
        "11": {"class_type": "KSampler", "inputs": {
            "model": ["5", 0], "positive": ["8", 0], "negative": ["9", 0], "latent_image": ["10", 0],
            "seed": seed, "steps": plan.steps, "cfg": 4.0, "sampler_name": "euler",
            "scheduler": "simple", "denoise": 1.0,
        }},
        "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}},
        "_decoded": "12",
    }
    # Picture 1 sets the canvas (scaled to the requested size, which follows its
    # aspect ratio by default); pictures 2-3 are only references.
    images: dict[str, list] = {}
    for index, name in enumerate(names):
        if index == 0:
            images["image1"] = [_scaled_reference(workflow, "2", name, plan.width, plan.height), 0]
        else:
            workflow[f"3{index}"] = {"class_type": "LoadImage", "inputs": {"image": name}}
            images[f"image{index + 1}"] = [f"3{index}", 0]
    for node, text in (("6", prompt), ("7", "")):
        workflow[node] = {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {
            "clip": ["2", 0], "prompt": text, "vae": ["3", 0], **images}}
    # 2511 expects the "index_timestep_zero" reference method (ComfyUI template).
    workflow["8"] = {"class_type": "FluxKontextMultiReferenceLatentMethod", "inputs": {
        "conditioning": ["6", 0], "reference_latents_method": "index_timestep_zero"}}
    workflow["9"] = {"class_type": "FluxKontextMultiReferenceLatentMethod", "inputs": {
        "conditioning": ["7", 0], "reference_latents_method": "index_timestep_zero"}}
    workflow["10"] = {"class_type": "VAEEncode", "inputs": {"pixels": images["image1"], "vae": ["3", 0]}}
    return workflow


BUILDERS = {
    "flux-schnell": _flux_schnell,
    "z-image-turbo": _z_image_turbo,
    "flux2-klein-4b": _flux2_klein,
    "qwen-image": _qwen_image,
    "qwen-image-edit": _qwen_image_edit,
}


# The sampler node of each workflow (step progress and timing).
SAMPLER_NODES = {
    "flux-schnell": "5", "z-image-turbo": "8", "flux2-klein-4b": "11", "qwen-image": "8", "qwen-image-edit": "11",
}


def sampler_node(plan: ImagePlan) -> str:
    return SAMPLER_NODES[plan.model.id]


def model_files(plan: ImagePlan) -> dict[str, str]:
    """file -> sha256 of every weight file the plan loads (provenance)."""
    return dict(plan.model.files)
