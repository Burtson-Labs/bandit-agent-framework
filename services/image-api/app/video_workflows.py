"""Server-owned, versioned Wan 2.2 video workflows for ComfyUI.

Callers choose from a small vocabulary (model alias, aspect ratio, resolution
preset, duration, frame rate, camera motion). Everything else — checkpoints,
sampler settings, step splits, upscaler, interpolation model — is fixed here and
recorded against a workflow version in every job's provenance. Callers never
submit graphs, node types, or file names.

Graph shape (per variant, one ComfyUI prompt):

    loaders -> text encode -> segment 1 (start image / text) -> decode
            -> [segment 2 continues from segment 1's last frame] -> concat
            -> [Real-ESRGAN x2 for 1080p] -> exact-size lanczos scale
            -> [RIFE interpolation towards the output frame rate]
            -> CreateVideo -> SaveVideo (H.264, near-lossless intermediate)

The API then does the final H.264/yuv420p/faststart encode (and any exact
frame-rate resample) with ffmpeg.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Literal

Aspect = Literal["16:9", "9:16", "1:1"]
Resolution = Literal["480p", "720p", "1080p"]
CameraMotion = Literal[
    "auto", "static", "push-in", "pull-out", "orbit-left", "orbit-right",
    "pan-left", "pan-right", "tilt-up", "crane-up",
]

MIN_DURATION_SECONDS = 2.0
MAX_DURATION_SECONDS = 10.0
OUTPUT_FPS = (24, 30)
MIN_SEGMENT_FRAMES = 17

TEXT_ENCODER = "umt5_xxl_fp8_e4m3fn_scaled.safetensors"
UPSCALE_MODEL = "RealESRGAN_x2plus.pth"
INTERPOLATION_MODEL = "rife_v4.26.safetensors"

# Wan's published default negative prompt (it was trained with Chinese
# negatives), plus explicit terms for the failure mode that matters most for
# client b-roll: warped signage, logos, and painted lettering.
NEGATIVE_PROMPT = (
    "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，"
    "低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，"
    "毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走, "
    "garbled text, distorted lettering, misspelled words, warped logo, melting signage, "
    "morphing letters, flicker"
)

CAMERA_PROMPTS: dict[str, str] = {
    "auto": "",
    "static": "Locked-off static camera on a tripod, no camera movement; only natural subtle motion in the scene.",
    "push-in": "Slow, smooth cinematic dolly push-in toward the subject.",
    "pull-out": "Slow, smooth cinematic dolly pull-out away from the subject, revealing more of the scene.",
    "orbit-left": "Slow, smooth camera orbit to the left around the subject, keeping it centred.",
    "orbit-right": "Slow, smooth camera orbit to the right around the subject, keeping it centred.",
    "pan-left": "Slow, smooth horizontal camera pan to the left.",
    "pan-right": "Slow, smooth horizontal camera pan to the right.",
    "tilt-up": "Slow, smooth camera tilt upward.",
    "crane-up": "Slow, smooth crane shot rising upward over the subject.",
}

FIDELITY_PROMPT = (
    "Preserve the subject exactly as in the source image: every logo, sign, and "
    "painted lettering stays sharp, legible, and unchanged."
)


@dataclass(frozen=True)
class VideoModel:
    alias: str
    workflow_version: str
    native_fps: int
    segment_frames: int
    grid: int
    requires_image: bool
    license: str = "Apache-2.0"
    checkpoints: tuple[str, ...] = ()
    # generation dimensions per resolution tier -> aspect -> (w, h)
    dimensions: dict[str, dict[str, tuple[int, int]]] = field(default_factory=dict)


VIDEO_MODELS: dict[str, VideoModel] = {
    # Wan2.2-TI2V-5B: text-to-video or image-to-video, 24 fps native, 32-px grid.
    "video-fast": VideoModel(
        alias="video-fast",
        workflow_version="wan22-ti2v-5b-v1",
        native_fps=24,
        segment_frames=121,
        grid=32,
        requires_image=False,
        checkpoints=("wan2.2_ti2v_5B_fp16.safetensors", "wan2.2_vae.safetensors", TEXT_ENCODER),
        dimensions={
            "480p": {"16:9": (832, 480), "9:16": (480, 832), "1:1": (640, 640)},
            "720p": {"16:9": (1280, 704), "9:16": (704, 1280), "1:1": (960, 960)},
        },
    ),
    # Wan2.2-I2V-A14B: high-noise + low-noise experts, 16 fps native, 16-px grid.
    "video-quality": VideoModel(
        alias="video-quality",
        workflow_version="wan22-i2v-a14b-v1",
        native_fps=16,
        segment_frames=81,
        grid=16,
        requires_image=True,
        checkpoints=(
            "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
            "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
            "wan_2.1_vae.safetensors",
            TEXT_ENCODER,
            "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
            "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors",
        ),
        dimensions={
            "480p": {"16:9": (832, 480), "9:16": (480, 832), "1:1": (640, 640)},
            "720p": {"16:9": (1280, 720), "9:16": (720, 1280), "1:1": (960, 960)},
        },
    ),
}

OUTPUT_DIMENSIONS: dict[str, dict[str, tuple[int, int]]] = {
    "720p": {"16:9": (1280, 720), "9:16": (720, 1280), "1:1": (960, 960)},
    "1080p": {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080)},
}


@dataclass(frozen=True)
class VideoPlan:
    model: VideoModel
    prompt: str
    seed: int
    aspect: str
    resolution: str
    gen_width: int
    gen_height: int
    out_width: int
    out_height: int
    segments: tuple[int, ...]
    output_fps: int
    interpolation: int
    upscale: bool
    accelerated: bool
    start_image: str | None = None
    end_image: str | None = None

    @property
    def native_frames(self) -> int:
        return sum(self.segments) - (len(self.segments) - 1)

    @property
    def duration_seconds(self) -> float:
        return round((self.native_frames - 1) / self.model.native_fps, 2)

    @property
    def workflow_fps(self) -> int:
        return self.model.native_fps * self.interpolation

    @property
    def steps(self) -> int:
        if self.model.alias == "video-fast":
            return 30
        return 4 if self.accelerated else 20

    def describe(self) -> dict[str, Any]:
        return {
            "workflowVersion": self.model.workflow_version,
            "model": self.model.alias,
            "aspect": self.aspect,
            "resolution": self.resolution,
            "generationSize": [self.gen_width, self.gen_height],
            "outputSize": [self.out_width, self.out_height],
            "segments": list(self.segments),
            "nativeFps": self.model.native_fps,
            "nativeFrames": self.native_frames,
            "interpolation": self.interpolation,
            "outputFps": self.output_fps,
            "durationSeconds": self.duration_seconds,
            "upscaler": "Real-ESRGAN x2 + lanczos" if self.upscale else "lanczos",
            "steps": self.steps,
            "accelerated": self.accelerated if self.model.alias == "video-quality" else None,
            "seed": self.seed,
            "firstLastFrame": self.end_image is not None,
        }


def segment_frames(model: VideoModel, duration_seconds: float) -> tuple[int, ...]:
    """Split a requested duration into model-native segments of 4k+1 frames.

    Wan generates about five seconds per pass. Longer clips chain a second pass
    that starts from the first pass's last frame; the duplicated join frame is
    dropped, so total frames = sum(segments) - (segments - 1).
    """
    duration = min(max(duration_seconds, MIN_DURATION_SECONDS), MAX_DURATION_SECONDS)
    wanted = round(duration * model.native_fps) + 1

    def legal(frames: int) -> int:
        frames = 4 * round((frames - 1) / 4) + 1
        return min(model.segment_frames, max(MIN_SEGMENT_FRAMES, frames))

    if wanted <= model.segment_frames:
        return (legal(wanted),)
    first = model.segment_frames
    return (first, legal(wanted - first + 1))


def interpolation_multiplier(native_fps: int, output_fps: int) -> int:
    """RIFE multiplier that reaches the output rate with the least judder.

    Prefer an exact integer relationship (16 -> 48 -> 24); otherwise the smallest
    multiplier at or above the target, which ffmpeg then resamples.
    """
    if output_fps <= native_fps:
        return 1
    for multiplier in range(2, 5):
        if (native_fps * multiplier) % output_fps == 0:
            return multiplier
    return math.ceil(output_fps / native_fps)


def compose_prompt(prompt: str, camera: str, preserve_text: bool) -> str:
    parts = [prompt.strip()]
    if CAMERA_PROMPTS.get(camera):
        parts.append(CAMERA_PROMPTS[camera])
    if preserve_text:
        parts.append(FIDELITY_PROMPT)
    return " ".join(parts)


def plan_video(
    *,
    model: str,
    prompt: str,
    seed: int,
    aspect: str,
    resolution: str,
    duration_seconds: float,
    output_fps: int,
    camera: str = "auto",
    preserve_text: bool = False,
    accelerated: bool = True,
    upscaler: Literal["esrgan", "lanczos"] = "esrgan",
    start_image: str | None = None,
    end_image: str | None = None,
) -> VideoPlan:
    spec = VIDEO_MODELS.get(model)
    if spec is None:
        raise ValueError(f"unknown video model {model!r}")
    if spec.requires_image and not start_image:
        raise ValueError(f"{model} is image-to-video and needs a start image")
    if end_image and not start_image:
        raise ValueError("an end frame needs a start image")
    if end_image and model != "video-quality":
        raise ValueError("first/last-frame video needs the video-quality model")
    if aspect not in ("16:9", "9:16", "1:1"):
        raise ValueError("aspect must be 16:9, 9:16, or 1:1")
    if resolution not in ("480p", "720p", "1080p"):
        raise ValueError("resolution must be 480p, 720p, or 1080p")
    if output_fps not in OUTPUT_FPS:
        raise ValueError("fps must be 24 or 30")
    if camera not in CAMERA_PROMPTS:
        raise ValueError("unknown camera motion")

    tier = "480p" if resolution == "480p" else "720p"
    gen_width, gen_height = spec.dimensions[tier][aspect]
    if resolution == "480p":
        out_width, out_height = gen_width, gen_height
    else:
        out_width, out_height = OUTPUT_DIMENSIONS[resolution][aspect]
    segments = segment_frames(spec, duration_seconds)
    if end_image and len(segments) > 1:
        # A first/last-frame pass is a single ~5 s generation by construction.
        segments = (spec.segment_frames,)
    return VideoPlan(
        model=spec,
        prompt=compose_prompt(prompt, camera, preserve_text),
        seed=seed,
        aspect=aspect,
        resolution=resolution,
        gen_width=gen_width,
        gen_height=gen_height,
        out_width=out_width,
        out_height=out_height,
        segments=segments,
        output_fps=output_fps,
        interpolation=interpolation_multiplier(spec.native_fps, output_fps),
        upscale=resolution == "1080p" and upscaler == "esrgan",
        accelerated=accelerated,
        start_image=start_image,
        end_image=end_image,
    )


class _Graph:
    def __init__(self) -> None:
        self.nodes: dict[str, dict[str, Any]] = {}

    def add(self, node_id: str, class_type: str, **inputs: Any) -> list:
        self.nodes[node_id] = {"class_type": class_type, "inputs": inputs}
        return [node_id, 0]


def wan_video_workflow(plan: VideoPlan, filename_prefix: str = "burtson-video/clip") -> dict[str, Any]:
    """Compile a plan into a ComfyUI API-format prompt."""
    g = _Graph()
    spec = plan.model
    fast = spec.alias == "video-fast"

    clip = g.add("clip", "CLIPLoader", clip_name=TEXT_ENCODER, type="wan", device="default")
    positive = g.add("positive", "CLIPTextEncode", text=plan.prompt, clip=clip)
    negative = g.add("negative", "CLIPTextEncode", text=NEGATIVE_PROMPT, clip=clip)
    start = g.add("start_image", "LoadImage", image=plan.start_image) if plan.start_image else None
    end = g.add("end_image", "LoadImage", image=plan.end_image) if plan.end_image else None

    if fast:
        vae = g.add("vae", "VAELoader", vae_name="wan2.2_vae.safetensors")
        unet = g.add("unet", "UNETLoader", unet_name="wan2.2_ti2v_5B_fp16.safetensors", weight_dtype="default")
        model = g.add("model", "ModelSamplingSD3", model=unet, shift=8.0)
    else:
        vae = g.add("vae", "VAELoader", vae_name="wan_2.1_vae.safetensors")
        high = g.add("unet_high", "UNETLoader",
                     unet_name="wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", weight_dtype="default")
        low = g.add("unet_low", "UNETLoader",
                    unet_name="wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors", weight_dtype="default")
        if plan.accelerated:
            high = g.add("lora_high", "LoraLoaderModelOnly", model=high, strength_model=1.0,
                         lora_name="wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors")
            low = g.add("lora_low", "LoraLoaderModelOnly", model=low, strength_model=1.0,
                        lora_name="wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors")
        shift = 5.0 if plan.accelerated else 8.0
        model_high = g.add("model_high", "ModelSamplingSD3", model=high, shift=shift)
        model_low = g.add("model_low", "ModelSamplingSD3", model=low, shift=shift)

    frames = None
    for index, length in enumerate(plan.segments, start=1):
        seg_start = start if index == 1 else g.add(
            f"seg{index}_start", "ImageFromBatch", image=frames, batch_index=-1, length=1,
        )
        seed = plan.seed + (index - 1)
        if fast:
            latent_inputs: dict[str, Any] = {
                "vae": vae, "width": plan.gen_width, "height": plan.gen_height,
                "length": length, "batch_size": 1,
            }
            if seg_start is not None:
                latent_inputs["start_image"] = seg_start
            latent = g.add(f"seg{index}_latent", "Wan22ImageToVideoLatent", **latent_inputs)
            sampled = g.add(f"seg{index}_sampler", "KSampler",
                            model=model, positive=positive, negative=negative, latent_image=latent,
                            seed=seed, steps=plan.steps, cfg=5.0, sampler_name="uni_pc",
                            scheduler="simple", denoise=1.0)
        else:
            cond_inputs: dict[str, Any] = {
                "positive": positive, "negative": negative, "vae": vae,
                "width": plan.gen_width, "height": plan.gen_height,
                "length": length, "batch_size": 1, "start_image": seg_start,
            }
            if end is not None:
                cond_inputs["end_image"] = end
                cond_node = "WanFirstLastFrameToVideo"
            else:
                cond_node = "WanImageToVideo"
            cond_id = f"seg{index}_cond"
            g.add(cond_id, cond_node, **cond_inputs)
            steps = plan.steps
            split = steps // 2
            cfg = 1.0 if plan.accelerated else 3.5
            high_pass = g.add(f"seg{index}_high", "KSamplerAdvanced",
                              model=model_high, add_noise="enable", noise_seed=seed, steps=steps, cfg=cfg,
                              sampler_name="euler", scheduler="simple",
                              positive=[cond_id, 0], negative=[cond_id, 1], latent_image=[cond_id, 2],
                              start_at_step=0, end_at_step=split, return_with_leftover_noise="enable")
            sampled = g.add(f"seg{index}_low", "KSamplerAdvanced",
                            model=model_low, add_noise="disable", noise_seed=seed, steps=steps, cfg=cfg,
                            sampler_name="euler", scheduler="simple",
                            positive=[cond_id, 0], negative=[cond_id, 1], latent_image=high_pass,
                            start_at_step=split, end_at_step=10000, return_with_leftover_noise="disable")
        decoded = g.add(f"seg{index}_decode", "VAEDecode", samples=sampled, vae=vae)
        if frames is None:
            frames = decoded
        else:
            tail = g.add(f"seg{index}_tail", "ImageFromBatch", image=decoded, batch_index=1, length=4096)
            frames = g.add(f"seg{index}_concat", "ImageBatch", image1=frames, image2=tail)

    if plan.upscale:
        upscaler = g.add("upscale_model", "UpscaleModelLoader", model_name=UPSCALE_MODEL)
        frames = g.add("upscale", "ImageUpscaleWithModel", upscale_model=upscaler, image=frames)
    if (plan.out_width, plan.out_height) != (plan.gen_width, plan.gen_height) or plan.upscale:
        frames = g.add("resize", "ImageScale", image=frames, upscale_method="lanczos",
                       width=plan.out_width, height=plan.out_height, crop="center")
    if plan.interpolation > 1:
        interp_model = g.add("interp_model", "FrameInterpolationModelLoader", model_name=INTERPOLATION_MODEL)
        frames = g.add("interpolate", "FrameInterpolate", interp_model=interp_model, images=frames,
                       multiplier=plan.interpolation)

    video = g.add("video", "CreateVideo", images=frames, fps=float(plan.workflow_fps))
    g.add("save", "SaveVideo", video=video, filename_prefix=filename_prefix, **{
        "format": "mp4",
        "format.codec": "h264",
        "format.codec.encoding": "re-encode",
        "format.codec.encoding.crf": 12.0,
    })
    return g.nodes


def sampler_nodes(plan: VideoPlan) -> list[tuple[str, int]]:
    """Sampler node ids in execution order with their step counts (for progress)."""
    nodes: list[tuple[str, int]] = []
    for index in range(1, len(plan.segments) + 1):
        if plan.model.alias == "video-fast":
            nodes.append((f"seg{index}_sampler", plan.steps))
        else:
            split = plan.steps // 2
            nodes.append((f"seg{index}_high", split))
            nodes.append((f"seg{index}_low", plan.steps - split))
    return nodes


# Pinned digests recorded in every job's provenance (see the model manifest
# at /mnt/ai-models/comfyui/manifests/MODELS-wan22.md on son-of-anton).
CHECKPOINT_SHA256: dict[str, str] = {
    "wan2.2_ti2v_5B_fp16.safetensors": "456f901338bd9eadbded3828b819109a9b68e8a525ca5cf8d0049a69fcfeca1e",
    "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors": "6122e79d55e0f235698d11d657f3b196c5273c830da00b2b013c5a048d5e6a42",
    "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors": "5471a457b6ac404202a5fbe6c11595a3d5641fc766b00f38763f72303fffc21e",
    "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors": "d176c808d6fc461999b68e321efcb7501b20b8c3797523ed0df14f7d1deff11e",
    "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors": "024f21de095bc8fad9809ded3e9e49a2e170dcf27075da8145ba7d60d8aab7f9",
    TEXT_ENCODER: "c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68",
    "wan2.2_vae.safetensors": "e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156",
    "wan_2.1_vae.safetensors": "2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b",
    UPSCALE_MODEL: "49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb",
    INTERPOLATION_MODEL: "151874592c877740e5db11522f4514df569eeafb0a0fcb2696f16e9e8d317c94",
}


def plan_checkpoints(plan: VideoPlan) -> list[str]:
    """Every model file a compiled plan actually loads."""
    names = [name for name in plan.model.checkpoints
             if "lightx2v" not in name or plan.accelerated]
    if plan.upscale:
        names.append(UPSCALE_MODEL)
    if plan.interpolation > 1:
        names.append(INTERPOLATION_MODEL)
    return names
