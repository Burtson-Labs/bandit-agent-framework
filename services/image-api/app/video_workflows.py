"""Server-owned, versioned Wan 2.2 video workflows for ComfyUI.

Callers choose from a small vocabulary (model alias, inputs present, aspect
ratio, resolution preset, duration, frame rate, camera motion, video mode and
control). Everything else — checkpoints, sampler settings, step splits,
preprocessors, upscaler, interpolation model — is fixed here and recorded
against a workflow version in every job's provenance. Callers never submit
graphs, node types, or file names.

Pipelines (chosen by which inputs are present):

    text only            video-fast  -> TI2V-5B text-to-video
                         video-quality -> T2V-A14B (high/low-noise experts)
    text + image         video-fast  -> TI2V-5B image-to-video
                         video-quality -> I2V-A14B (optional end frame: first/last)
    text [+ image] + video  (video-quality only) -> Wan2.2-VACE-Fun-A14B:
        restyle  keep the source's motion via an edges/depth/pose control video,
                 take the look from the prompt and optional reference image
        motion   animate the reference image with the source's pose/motion
        extend   continue the source from its last frames

Shared tail: [segment 2 from segment 1's last frame] -> concat
    -> [Real-ESRGAN x2 for 1080p] -> exact-size lanczos scale
    -> [RIFE interpolation towards the output frame rate]
    -> CreateVideo -> SaveVideo (H.264, near-lossless intermediate)

The API then does the final H.264/yuv420p/faststart encode with ffmpeg.
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
VideoMode = Literal["restyle", "motion", "extend"]
Control = Literal["edges", "depth", "pose"]

MIN_DURATION_SECONDS = 2.0
MAX_DURATION_SECONDS = 10.0
OUTPUT_FPS = (24, 30)
MIN_SEGMENT_FRAMES = 17
# Source videos are normalised to this rate at upload (VACE's native rate).
SOURCE_FPS = 16
MAX_SOURCE_SECONDS = 10.0
# Known frames handed to VACE when extending (5 latent frames exactly).
EXTEND_CONTEXT_FRAMES = 17

TEXT_ENCODER = "umt5_xxl_fp8_e4m3fn_scaled.safetensors"
WAN21_VAE = "wan_2.1_vae.safetensors"
UPSCALE_MODEL = "RealESRGAN_x2plus.pth"
INTERPOLATION_MODEL = "rife_v4.26.safetensors"
DEPTH_MODEL = "depth_anything_3_mono_large.safetensors"
POSE_MODEL = "sdpose_wholebody_fp16.safetensors"

EXPERTS = {
    "i2v": ("wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
            "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors"),
    "t2v": ("wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors",
            "wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors"),
    "vace": ("wan2.2_fun_vace_high_noise_14B_fp8_scaled.safetensors",
             "wan2.2_fun_vace_low_noise_14B_fp8_scaled.safetensors"),
}
# Lightning 4-step LoRAs. VACE-Fun A14B is built on T2V-A14B, so it takes the
# T2V pair.
LIGHTNING = {
    "i2v": ("wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
            "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors"),
    "t2v": ("wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors",
            "wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors"),
    "vace": ("wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors",
             "wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors"),
}

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
    "painted lettering stays sharp, legible, and unchanged. Flat signs and "
    "painted surfaces stay matte and unlit, do not glow, and no text is added."
)
# Extra negatives when preserving lettering. Found on a real sign: prompts that
# mention light moving turned a flat sign into a glowing one and invented extra
# text lines under the logo; these terms plus the guard above stopped it.
FIDELITY_NEGATIVE = (
    ", glowing sign, backlit sign, neon text, added text, extra lettering, "
    "new words, sparkles, lens flare on text"
)

DEFAULT_CONTROL: dict[str, str | None] = {"restyle": "edges", "motion": "pose", "extend": None}


@dataclass(frozen=True)
class VideoModel:
    alias: str
    native_fps: int
    segment_frames: int
    grid: int
    license: str = "Apache-2.0"
    dimensions: dict[str, dict[str, tuple[int, int]]] = field(default_factory=dict)


VIDEO_MODELS: dict[str, VideoModel] = {
    # Wan2.2-TI2V-5B: text-to-video or image-to-video, 24 fps native, 32-px grid.
    "video-fast": VideoModel(
        alias="video-fast", native_fps=24, segment_frames=121, grid=32,
        dimensions={
            "480p": {"16:9": (832, 480), "9:16": (480, 832), "1:1": (640, 640)},
            "720p": {"16:9": (1280, 704), "9:16": (704, 1280), "1:1": (960, 960)},
        },
    ),
    # Wan2.2 A14B family (T2V / I2V / VACE-Fun): 16 fps native, 16-px grid.
    "video-quality": VideoModel(
        alias="video-quality", native_fps=16, segment_frames=81, grid=16,
        dimensions={
            "480p": {"16:9": (832, 480), "9:16": (480, 832), "1:1": (640, 640)},
            "720p": {"16:9": (1280, 720), "9:16": (720, 1280), "1:1": (960, 960)},
        },
    ),
}

WORKFLOW_VERSIONS = {
    ("video-fast", "t2v"): "wan22-ti2v-5b-v1",
    ("video-fast", "i2v"): "wan22-ti2v-5b-v1",
    ("video-quality", "t2v"): "wan22-t2v-a14b-v1",
    ("video-quality", "i2v"): "wan22-i2v-a14b-v1",
    ("video-quality", "flf"): "wan22-i2v-a14b-v1",
    ("video-quality", "vace"): "wan22-vace-fun-a14b-v1",
}

OUTPUT_DIMENSIONS: dict[str, dict[str, tuple[int, int]]] = {
    "720p": {"16:9": (1280, 720), "9:16": (720, 1280), "1:1": (960, 960)},
    "1080p": {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080)},
}


@dataclass(frozen=True)
class VideoPlan:
    model: VideoModel
    kind: str  # t2v | i2v | flf | vace
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
    mode: str | None = None
    control: str | None = None
    control_strength: float = 1.0
    source_video: str | None = None
    source_start: int = 0
    source_frames: int = 0
    preserve_text: bool = False

    @property
    def workflow_version(self) -> str:
        return WORKFLOW_VERSIONS[(self.model.alias, self.kind)]

    @property
    def native_frames(self) -> int:
        if self.mode == "extend":
            return self.source_frames + self.segments[0] - EXTEND_CONTEXT_FRAMES
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
            # 30 steps (the template default) measured 246 s for 5 s at 720p on
            # the 5090 — slower than A14B + Lightning. 20 keeps it a draft tier.
            return 20
        return 4 if self.accelerated else 20

    def describe(self) -> dict[str, Any]:
        return {
            "workflowVersion": self.workflow_version,
            "model": self.model.alias,
            "pipeline": self.kind,
            "mode": self.mode,
            "control": self.control,
            "controlStrength": self.control_strength if self.kind == "vace" else None,
            "sourceWindow": ([self.source_start, self.segments[0]]
                             if self.mode in ("restyle", "motion") else None),
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
            "preserveText": self.preserve_text,
        }


def _legal(frames: int, model: VideoModel) -> int:
    frames = 4 * round((frames - 1) / 4) + 1
    return min(model.segment_frames, max(MIN_SEGMENT_FRAMES, frames))


def segment_frames(model: VideoModel, duration_seconds: float) -> tuple[int, ...]:
    """Split a requested duration into model-native segments of 4k+1 frames.

    Wan generates about five seconds per pass. Longer clips chain a second pass
    that starts from the first pass's last frame; the duplicated join frame is
    dropped, so total frames = sum(segments) - (segments - 1).
    """
    duration = min(max(duration_seconds, MIN_DURATION_SECONDS), MAX_DURATION_SECONDS)
    wanted = round(duration * model.native_fps) + 1
    if wanted <= model.segment_frames:
        return (_legal(wanted, model),)
    first = model.segment_frames
    return (first, _legal(wanted - first + 1, model))


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
    source_video: str | None = None,
    source_frames: int = 0,
    source_start_seconds: float = 0.0,
    mode: str | None = None,
    control: str | None = None,
    control_strength: float = 1.0,
) -> VideoPlan:
    """Validate an input combination and compile it into a plan.

    Raises ValueError with a caller-facing message for combinations that make
    no sense (the API maps these to 400).
    """
    spec = VIDEO_MODELS.get(model)
    if spec is None:
        raise ValueError(f"unknown video model {model!r}")
    if aspect not in ("16:9", "9:16", "1:1"):
        raise ValueError("aspect must be 16:9, 9:16, or 1:1")
    if resolution not in ("480p", "720p", "1080p"):
        raise ValueError("resolution must be 480p, 720p, or 1080p")
    if output_fps not in OUTPUT_FPS:
        raise ValueError("fps must be 24 or 30")
    if camera not in CAMERA_PROMPTS:
        raise ValueError("unknown camera motion")
    if end_image and not start_image:
        raise ValueError("an end frame needs a start image")
    if model == "video-fast" and resolution == "1080p":
        raise ValueError("Draft (Wan 2.2 5B) renders up to 720p; use Quality for 1080p")

    if source_video:
        if model != "video-quality":
            raise ValueError("Draft (Wan 2.2 5B) cannot use a source video; video input runs on Quality (Wan 2.2 VACE 14B)")
        if mode not in ("restyle", "motion", "extend"):
            raise ValueError("a source video needs mode: restyle, motion, or extend")
        if end_image:
            raise ValueError("an end frame cannot be combined with a source video")
        if mode == "motion" and not start_image:
            raise ValueError("motion mode animates a reference image: attach one (referenceId)")
        if mode == "extend":
            control = None
        else:
            control = control or DEFAULT_CONTROL[mode]
            if control not in ("edges", "depth", "pose"):
                raise ValueError("control must be edges, depth, or pose")
        if not 0.1 <= control_strength <= 2.0:
            raise ValueError("controlStrength must be between 0.1 and 2.0")
        kind = "vace"
    else:
        if mode or control:
            raise ValueError("mode and control need a source video (sourceVideoId)")
        kind = "flf" if end_image else ("i2v" if start_image else "t2v")
        if end_image and model != "video-quality":
            raise ValueError("first/last-frame video needs the video-quality model")

    tier = "480p" if resolution == "480p" else "720p"
    gen_width, gen_height = spec.dimensions[tier][aspect]
    if resolution == "480p":
        out_width, out_height = gen_width, gen_height
    else:
        out_width, out_height = OUTPUT_DIMENSIONS[resolution][aspect]

    source_start = 0
    if kind == "vace":
        available = min(source_frames, round(MAX_SOURCE_SECONDS * SOURCE_FPS) + 1)
        if available < MIN_SEGMENT_FRAMES:
            raise ValueError("the source video must be at least about one second long")
        if mode == "extend":
            new = round(min(max(duration_seconds, 1.0), MAX_DURATION_SECONDS) * SOURCE_FPS)
            segments = (_legal(EXTEND_CONTEXT_FRAMES + new, spec),)
            source_frames = available
        else:
            source_start = max(0, min(round(source_start_seconds * SOURCE_FPS), available - MIN_SEGMENT_FRAMES))
            remaining = available - source_start
            wanted = min(round(min(max(duration_seconds, MIN_DURATION_SECONDS), MAX_DURATION_SECONDS)
                               * SOURCE_FPS) + 1, remaining)
            frames = min(spec.segment_frames, 4 * ((wanted - 1) // 4) + 1)
            segments = (max(MIN_SEGMENT_FRAMES, frames),)
            source_frames = available
    else:
        segments = segment_frames(spec, duration_seconds)
        if end_image and len(segments) > 1:
            # A first/last-frame pass is a single ~5 s generation by construction.
            segments = (spec.segment_frames,)
        source_frames = 0

    return VideoPlan(
        model=spec,
        kind=kind,
        prompt=compose_prompt(prompt, camera if mode not in ("restyle", "motion") else "auto", preserve_text),
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
        mode=mode if kind == "vace" else None,
        control=control if kind == "vace" else None,
        control_strength=control_strength,
        source_video=source_video if kind == "vace" else None,
        source_start=source_start,
        source_frames=source_frames,
        preserve_text=preserve_text,
    )


class _Graph:
    def __init__(self) -> None:
        self.nodes: dict[str, dict[str, Any]] = {}

    def add(self, node_id: str, class_type: str, **inputs: Any) -> list:
        self.nodes[node_id] = {"class_type": class_type, "inputs": inputs}
        return [node_id, 0]


def _experts(g: _Graph, family: str, plan: VideoPlan) -> tuple[list, list]:
    """High/low-noise expert pair for an A14B family, with optional Lightning."""
    suffix = "" if family == "i2v" else f"_{family}"
    high_name, low_name = EXPERTS[family]
    high = g.add(f"unet_high{suffix}", "UNETLoader", unet_name=high_name, weight_dtype="default")
    low = g.add(f"unet_low{suffix}", "UNETLoader", unet_name=low_name, weight_dtype="default")
    if plan.accelerated:
        lora_high, lora_low = LIGHTNING[family]
        high = g.add(f"lora_high{suffix}", "LoraLoaderModelOnly", model=high, strength_model=1.0, lora_name=lora_high)
        low = g.add(f"lora_low{suffix}", "LoraLoaderModelOnly", model=low, strength_model=1.0, lora_name=lora_low)
    shift = 5.0 if plan.accelerated else 8.0
    return (g.add(f"model_high{suffix}", "ModelSamplingSD3", model=high, shift=shift),
            g.add(f"model_low{suffix}", "ModelSamplingSD3", model=low, shift=shift))


def _two_expert_pass(g: _Graph, plan: VideoPlan, index: int, experts: tuple[list, list],
                     positive: list, negative: list, latent: list, seed: int) -> list:
    steps = plan.steps
    split = steps // 2
    cfg = 1.0 if plan.accelerated else 3.5
    model_high, model_low = experts
    high_pass = g.add(f"seg{index}_high", "KSamplerAdvanced",
                      model=model_high, add_noise="enable", noise_seed=seed, steps=steps, cfg=cfg,
                      sampler_name="euler", scheduler="simple",
                      positive=positive, negative=negative, latent_image=latent,
                      start_at_step=0, end_at_step=split, return_with_leftover_noise="enable")
    return g.add(f"seg{index}_low", "KSamplerAdvanced",
                 model=model_low, add_noise="disable", noise_seed=seed, steps=steps, cfg=cfg,
                 sampler_name="euler", scheduler="simple",
                 positive=positive, negative=negative, latent_image=high_pass,
                 start_at_step=split, end_at_step=10000, return_with_leftover_noise="disable")


def _control_video(g: _Graph, plan: VideoPlan, frames: list) -> list:
    if plan.control == "edges":
        return g.add("control", "Canny", image=frames, low_threshold=0.4, high_threshold=0.8)
    if plan.control == "depth":
        depth_model = g.add("depth_model", "LoadDA3Model", model_name=DEPTH_MODEL, weight_dtype="default")
        geometry = g.add("depth", "DA3Inference", da3_model=depth_model, image=frames, resolution=504,
                         resize_method="upper_bound_resize", mode="mono")
        return g.add("control", "DA3Render", da3_geometry=geometry, **{
            "output": "depth", "output.normalization": "v2_style", "output.apply_sky_clip": False,
        })
    pose_model = g.add("pose_model", "CheckpointLoaderSimple", ckpt_name=POSE_MODEL)
    keypoints = g.add("pose", "SDPoseKeypointExtractor", model=pose_model, vae=["pose_model", 2],
                      image=frames, batch_size=16)
    return g.add("control", "SDPoseDrawKeypoints", keypoints=keypoints, draw_body=True, draw_hands=True,
                 draw_face=True, draw_feet=False, stick_width=4, face_point_size=3,
                 score_threshold=0.3, draw_head=True)


def _vace_frames(g: _Graph, plan: VideoPlan, positive: list, negative: list, vae: list,
                 start: list | None) -> list:
    experts = _experts(g, "vace", plan)
    video = g.add("source", "LoadVideo", file=plan.source_video)
    components = g.add("source_frames", "GetVideoComponents", video=video)
    scaled = g.add("source_scaled", "ImageScale", image=components, upscale_method="lanczos",
                   width=plan.gen_width, height=plan.gen_height, crop="center")
    length = plan.segments[0]
    cond_inputs: dict[str, Any] = {
        "positive": positive, "negative": negative, "vae": vae,
        "width": plan.gen_width, "height": plan.gen_height, "length": length, "batch_size": 1,
        "strength": plan.control_strength,
    }
    if plan.mode == "extend":
        context = g.add("source_tail", "ImageFromBatch", image=scaled,
                        batch_index=-EXTEND_CONTEXT_FRAMES, length=EXTEND_CONTEXT_FRAMES)
        # Black = keep (VACE "inactive"); the node pads the rest with generate.
        keep = g.add("keep_frames", "EmptyImage", width=plan.gen_width, height=plan.gen_height,
                     batch_size=EXTEND_CONTEXT_FRAMES, color=0)
        cond_inputs["control_video"] = context
        cond_inputs["control_masks"] = g.add("keep_mask", "ImageToMask", image=keep, channel="red")
    else:
        window = g.add("source_window", "ImageFromBatch", image=scaled,
                       batch_index=plan.source_start, length=length)
        cond_inputs["control_video"] = _control_video(g, plan, window)
    if start is not None:
        cond_inputs["reference_image"] = start
    g.add("seg1_cond", "WanVaceToVideo", **cond_inputs)
    sampled = _two_expert_pass(g, plan, 1, experts, ["seg1_cond", 0], ["seg1_cond", 1],
                               ["seg1_cond", 2], plan.seed)
    trimmed = g.add("seg1_trim", "TrimVideoLatent", samples=sampled, trim_amount=["seg1_cond", 3])
    decoded = g.add("seg1_decode", "VAEDecode", samples=trimmed, vae=vae)
    if plan.mode != "extend":
        return decoded
    new = g.add("extension", "ImageFromBatch", image=decoded,
                batch_index=EXTEND_CONTEXT_FRAMES, length=4096)
    return g.add("extended", "ImageBatch", image1=scaled, image2=new)


def wan_video_workflow(plan: VideoPlan, filename_prefix: str = "burtson-video/clip") -> dict[str, Any]:
    """Compile a plan into a ComfyUI API-format prompt."""
    g = _Graph()
    fast = plan.model.alias == "video-fast"

    clip = g.add("clip", "CLIPLoader", clip_name=TEXT_ENCODER, type="wan", device="default")
    positive = g.add("positive", "CLIPTextEncode", text=plan.prompt, clip=clip)
    negative = g.add("negative", "CLIPTextEncode",
                     text=NEGATIVE_PROMPT + (FIDELITY_NEGATIVE if plan.preserve_text else ""), clip=clip)
    start = g.add("start_image", "LoadImage", image=plan.start_image) if plan.start_image else None
    end = g.add("end_image", "LoadImage", image=plan.end_image) if plan.end_image else None

    if fast:
        vae = g.add("vae", "VAELoader", vae_name="wan2.2_vae.safetensors")
        unet = g.add("unet", "UNETLoader", unet_name="wan2.2_ti2v_5B_fp16.safetensors", weight_dtype="default")
        model = g.add("model", "ModelSamplingSD3", model=unet, shift=8.0)
    else:
        vae = g.add("vae", "VAELoader", vae_name=WAN21_VAE)

    if plan.kind == "vace":
        frames = _vace_frames(g, plan, positive, negative, vae, start)
    else:
        i2v_experts = None
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
            elif seg_start is None:
                # Quality text-to-video: T2V-A14B experts on an empty latent.
                latent = g.add(f"seg{index}_latent", "EmptyHunyuanLatentVideo",
                               width=plan.gen_width, height=plan.gen_height, length=length, batch_size=1)
                sampled = _two_expert_pass(g, plan, index, _experts(g, "t2v", plan),
                                           positive, negative, latent, seed)
            else:
                i2v_experts = i2v_experts or _experts(g, "i2v", plan)
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
                sampled = _two_expert_pass(g, plan, index, i2v_experts, [cond_id, 0], [cond_id, 1],
                                           [cond_id, 2], seed)
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
    "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors": "cad711ae211c8b23455ec68cd6a190a33a3d874234a77eb57266d73f8f0e6c9f",
    "wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors": "e71b96d7c82e638694c5e7fb98fac4bfb0e4ddc5fbbb4b1df40da8f0f1278a97",
    "wan2.2_fun_vace_high_noise_14B_fp8_scaled.safetensors": "23130f30207f6c8697a5bead113ddc9904cfbb5e8fa51a550df3cee4d21fb54c",
    "wan2.2_fun_vace_low_noise_14B_fp8_scaled.safetensors": "ca55a5cc543e28576edbd2079f8c1de05f71cd9e85bf96fab635f55663dbcb69",
    "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors": "d176c808d6fc461999b68e321efcb7501b20b8c3797523ed0df14f7d1deff11e",
    "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors": "024f21de095bc8fad9809ded3e9e49a2e170dcf27075da8145ba7d60d8aab7f9",
    "wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors": "698321cb86bd30c4af06c9b84e656a1048c8cb54e06d50694536fb5de37fde41",
    "wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors": "ec95216e614b3c132c11bfb387b11feedf62163150ccc9068bca8a189771e75a",
    TEXT_ENCODER: "c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68",
    "wan2.2_vae.safetensors": "e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156",
    WAN21_VAE: "2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b",
    UPSCALE_MODEL: "49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb",
    INTERPOLATION_MODEL: "151874592c877740e5db11522f4514df569eeafb0a0fcb2696f16e9e8d317c94",
    DEPTH_MODEL: "9b44eda5bedba5b4e125686fdb79d1db309c1b9785277576eb930f885b008f96",
    POSE_MODEL: "63d01f9a7494560693b24767f4469d59c9d3266b31ff0a253e74d1e611442721",
}

_MODEL_INPUTS = ("unet_name", "lora_name", "vae_name", "clip_name", "model_name", "ckpt_name")


def plan_checkpoints(plan: VideoPlan) -> list[str]:
    """Every model file a compiled plan actually loads (read from the graph)."""
    names: list[str] = []
    for node in wan_video_workflow(plan).values():
        for key in _MODEL_INPUTS:
            value = node["inputs"].get(key)
            if isinstance(value, str) and value not in names:
                names.append(value)
    return names
