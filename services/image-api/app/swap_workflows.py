"""People swap: server-owned Wan2.2-Animate-14B workflows (``animate`` / ``replace``).

A swap job takes a source video and one photo per person, all of whom must have
given consent (the API requires the caller to confirm it). Per person, in order:

    prepare  (one prompt)  track that person with SAM 2.1 from a tap point on the
                           first frame -> grown, blockified character mask + box
                           per frame -> SDPose keypoints inside the box -> body +
                           hands pose video and steady 512 px face crops
    segments (one prompt each)  Wan2.2-Animate on a ~4.8 s window: the photo
                           performs the pose + face; ``replace`` keeps the scene
                           (background video = source with the person blacked
                           out, relighting LoRA on) and composites the result
                           back over the source through a feathered mask.
                           Windows overlap by 5 frames: each continues from the
                           previous window's last frames, and the API crossfades
                           the overlap when stitching.

Replace processes one person per pass; pass N's stitched output is pass N+1's
source, so the people already swapped stay as they are. After the last pass,
``finish`` prompts upscale (1080p) and interpolate (RIFE) in chunks, and the
API muxes the source's audio back.

Everything runs at 16 fps (the source normalisation rate) at a generation size
that keeps the source's aspect ratio. Callers never submit graphs or files.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from typing import Any, Literal

from . import video_workflows as vw

SwapMode = Literal["animate", "replace"]
SWAP_MODES = ("animate", "replace")
WORKFLOW_VERSION = "wan22-animate-14b-v1"
LICENSE = "Apache-2.0"

FPS = vw.SOURCE_FPS  # 16
MAX_SECONDS = 60.0
MAX_PEOPLE = 4
SEGMENT_FRAMES = 77      # Wan-Animate's native clip (4k+1)
OVERLAP_FRAMES = 5       # frames each window continues from (continue_motion)
MIN_WINDOW_FRAMES = 9
FINISH_CHUNK_FRAMES = 81

ANIMATE_MODEL = "wan2.2_animate_14B_int8_convrot.safetensors"
RELIGHT_LORA = "wan2.2_animate_14B_relight_lora_bf16.safetensors"
DISTILL_LORA = "Wan21_I2V_14B_lightx2v_cfg_step_distill_lora_rank64.safetensors"
CLIP_VISION = "clip_vision_h.safetensors"
SAM2_MODEL = "sam2.1-hiera-large"
SAM2_FILE = "sam2/sam2.1-hiera-large/model.safetensors"

# Pinned digests (manifest: /mnt/ai-models/comfyui/manifests/MODELS-wan22-animate.md).
CHECKPOINT_SHA256: dict[str, str] = {
    ANIMATE_MODEL: "419aa0b3d9079a8a39126f2894c3cb2427c288189d2dc8342c61cf0663731cb3",
    RELIGHT_LORA: "5f4b6b9d3bc745a86e7bfd511f3880d90cf59c3bded9584d92c028f583fa74a3",
    DISTILL_LORA: "8833bd4fd7c8eabebf0bc8ee5cfaf47f4f310ce116928a02c1adf8941dd4b0f1",
    CLIP_VISION: "64a7ef761bfccbadbaa3da77366aac4185a6c58fa5de5f589b42a65bcc21f161",
    SAM2_FILE: "dc407dce21301fd94abb395c5099b4f2c455fdc8a8f261ac3d0ea6d4cd197230",
}

DEFAULT_PROMPT = "The person moves naturally to the music. Realistic, natural skin and lighting."
CONSENT_STATEMENT = "I have permission from everyone shown"

# Generation pixel budget per tier; the shape follows the source.
TIER_AREA = {"480p": 832 * 480, "720p": 1280 * 720}


@dataclass(frozen=True)
class Window:
    """One generation window: source frames [start, start + length), the first
    ``overlap`` of which continue the previous window."""
    index: int
    start: int
    length: int
    overlap: int

    @property
    def new_frames(self) -> int:
        return self.length - self.overlap


@dataclass(frozen=True)
class Subject:
    reference: str
    x: float
    y: float
    # Optional description of this person (look, outfit); the job prompt otherwise.
    prompt: str | None = None


@dataclass(frozen=True)
class SwapPlan:
    mode: str
    prompt: str
    seed: int
    resolution: str
    gen_width: int
    gen_height: int
    out_width: int
    out_height: int
    output_fps: int
    interpolation: int
    upscale: bool
    accelerated: bool
    source_start: int          # first source frame (16 fps)
    frames: int                # frames processed (and delivered at 16 fps)
    windows: tuple[Window, ...]
    subjects: tuple[Subject, ...] = field(default_factory=tuple)
    keep_audio: bool = True

    @property
    def passes(self) -> int:
        return len(self.subjects) if self.mode == "replace" else 1

    @property
    def steps(self) -> int:
        return 6 if self.accelerated else 20

    @property
    def cfg(self) -> float:
        return 1.0

    @property
    def shift(self) -> float:
        return 8.0 if self.accelerated else 5.0

    @property
    def duration_seconds(self) -> float:
        return round(self.frames / FPS, 2)

    @property
    def start_seconds(self) -> float:
        return round(self.source_start / FPS, 3)

    @property
    def generated_frames(self) -> int:
        """Frames sampled per pass (windows include their overlap)."""
        return sum(window.length for window in self.windows)

    @property
    def workflow_fps(self) -> int:
        return FPS * self.interpolation

    @property
    def workflow_version(self) -> str:
        return WORKFLOW_VERSION

    def describe(self) -> dict[str, Any]:
        return {
            "workflowVersion": WORKFLOW_VERSION,
            "model": "video-quality",
            "pipeline": "animate",
            "mode": self.mode,
            "people": len(self.subjects),
            "passes": self.passes,
            "segments": len(self.windows),
            "windows": [[w.start, w.length, w.overlap] for w in self.windows],
            "sourceWindow": [self.source_start, self.frames],
            "startSeconds": self.start_seconds,
            "resolution": self.resolution,
            "generationSize": [self.gen_width, self.gen_height],
            "outputSize": [self.out_width, self.out_height],
            "nativeFps": FPS,
            "nativeFrames": self.frames,
            "interpolation": self.interpolation,
            "outputFps": self.output_fps,
            "durationSeconds": self.duration_seconds,
            "upscaler": "Real-ESRGAN x2 + lanczos" if self.upscale else "lanczos",
            "steps": self.steps,
            "accelerated": self.accelerated,
            "seed": self.seed,
            "relight": self.mode == "replace",
            "audio": "kept" if self.keep_audio else "dropped",
            "tracker": "SAM 2.1 hiera-large",
        }


def generation_size(source_width: int, source_height: int, tier: str) -> tuple[int, int]:
    """Largest 16-px-grid size near the tier's pixel budget with the source's shape."""
    if source_width <= 0 or source_height <= 0:
        raise ValueError("the source video has no frame size")
    area = TIER_AREA[tier]
    aspect = source_width / source_height
    aspect = min(max(aspect, 9 / 21), 21 / 9)
    width = math.sqrt(area * aspect)
    height = width / aspect
    return max(256, int(round(width / 16)) * 16), max(256, int(round(height / 16)) * 16)


def output_size(gen_width: int, gen_height: int, resolution: str) -> tuple[int, int]:
    if resolution != "1080p":
        return gen_width, gen_height
    # 1080p: the short side becomes 1080 (even dimensions for H.264).
    scale = 1080 / min(gen_width, gen_height)
    return int(round(gen_width * scale / 2)) * 2, int(round(gen_height * scale / 2)) * 2


def _snap_up(frames: int) -> int:
    """Smallest 4k+1 frame count that covers ``frames``."""
    return 4 * math.ceil(max(frames - 1, 0) / 4) + 1


def plan_windows(frames: int) -> tuple[Window, ...]:
    """Cover ``frames`` with <= 77-frame windows overlapping by 5.

    A window's length is always 4k+1; a last window shorter than that is
    generated a little long (the inputs hold their last frame) and trimmed.
    """
    if frames < 1:
        raise ValueError("nothing to process")
    windows: list[Window] = []
    start, overlap = 0, 0
    while True:
        remaining = frames - start
        length = min(SEGMENT_FRAMES, max(MIN_WINDOW_FRAMES, _snap_up(remaining)))
        windows.append(Window(index=len(windows), start=start, length=length, overlap=overlap))
        end = start + length
        if end >= frames:
            return tuple(windows)
        start, overlap = end - OVERLAP_FRAMES, OVERLAP_FRAMES


def plan_swap(
    *,
    mode: str,
    prompt: str,
    seed: int,
    resolution: str,
    output_fps: int,
    source_width: int,
    source_height: int,
    source_frames: int,
    start_seconds: float,
    duration_seconds: float | None,
    full_length: bool,
    subjects: list[Subject] | list[dict] | int,
    accelerated: bool = True,
    keep_audio: bool = True,
    upscaler: str = "esrgan",
) -> SwapPlan:
    """Validate a swap request and compile it into a plan (ValueError -> 400)."""
    if mode not in SWAP_MODES:
        raise ValueError("people swap mode must be animate or replace")
    if resolution not in ("480p", "720p", "1080p"):
        raise ValueError("resolution must be 480p, 720p, or 1080p")
    if output_fps not in vw.OUTPUT_FPS:
        raise ValueError("fps must be 24 or 30")
    if isinstance(subjects, int):
        people = tuple(Subject(f"subject-{n}.png", 0.5, 0.5) for n in range(subjects))
    else:
        people = tuple(s if isinstance(s, Subject) else Subject(str(s.get("reference") or s.get("referenceId")),
                                                                float(s["x"]), float(s["y"]), s.get("prompt"))
                       for s in subjects)
    if not people:
        raise ValueError("pick at least one person and give them a photo")
    if mode == "animate" and len(people) != 1:
        raise ValueError("animate takes exactly one person: the photo performs that person's motion")
    if len(people) > MAX_PEOPLE:
        raise ValueError(f"swap up to {MAX_PEOPLE} people per video")
    for subject in people:
        if not (0.0 <= subject.x <= 1.0 and 0.0 <= subject.y <= 1.0):
            raise ValueError("person points are normalised to 0..1 on the first frame")
    if source_frames < MIN_WINDOW_FRAMES:
        raise ValueError("the source video must be at least about half a second long")

    max_start = max(0, source_frames - MIN_WINDOW_FRAMES)
    start = min(max(0, round(start_seconds * FPS)), max_start)
    available = min(source_frames - start, round(MAX_SECONDS * FPS))
    if full_length:
        frames = available
    else:
        if duration_seconds is None or duration_seconds <= 0:
            raise ValueError("give a duration, or choose full length")
        frames = min(available, max(MIN_WINDOW_FRAMES, round(duration_seconds * FPS)))

    tier = "480p" if resolution == "480p" else "720p"
    gen_width, gen_height = generation_size(source_width, source_height, tier)
    out_width, out_height = output_size(gen_width, gen_height, resolution)
    return SwapPlan(
        mode=mode, prompt=(prompt or DEFAULT_PROMPT).strip(), seed=seed, resolution=resolution,
        gen_width=gen_width, gen_height=gen_height, out_width=out_width, out_height=out_height,
        output_fps=output_fps, interpolation=vw.interpolation_multiplier(FPS, output_fps),
        upscale=resolution == "1080p" and upscaler == "esrgan", accelerated=accelerated,
        source_start=start, frames=frames, windows=plan_windows(frames), subjects=people,
        keep_audio=keep_audio,
    )


# --- graphs ---------------------------------------------------------------------

class _Graph(vw._Graph):
    """A graph that refuses to reuse a node id (a reused id silently rewires links)."""

    def add(self, node_id: str, class_type: str, **inputs: Any) -> list:
        if node_id in self.nodes:
            raise ValueError(f"duplicate node id {node_id!r}")
        return super().add(node_id, class_type, **inputs)


def _save(g: _Graph, node_id: str, images: list, prefix: str, crf: float = 10.0, fps: float = FPS) -> None:
    video = g.add(f"{node_id}_video", "CreateVideo", images=images, fps=float(fps))
    g.add(node_id, "SaveVideo", video=video, filename_prefix=prefix, **{
        "format": "mp4", "format.codec": "h264", "format.codec.encoding": "re-encode",
        "format.codec.encoding.crf": crf,
    })


def _frames(g: _Graph, node_id: str, file: str) -> list:
    video = g.add(f"{node_id}_file", "LoadVideo", file=file)
    return g.add(node_id, "GetVideoComponents", video=video)


def mask_grow(plan: SwapPlan) -> int:
    return max(6, round(10 * plan.gen_height / 480))


def mask_block(plan: SwapPlan) -> int:
    return 32 if plan.gen_height >= 640 else 16


def prepare_workflow(plan: SwapPlan, subject_index: int, source_file: str, prefix: str) -> dict[str, Any]:
    """Track one person through the processed range; save mask, pose and face videos.

    ``source_file`` is the processed range already at generation size and 16 fps.
    Outputs (SaveVideo node ids): ``save_mask``, ``save_pose``, ``save_face``.
    """
    subject = plan.subjects[subject_index]
    g = _Graph()
    frames = _frames(g, "source", source_file)
    tracked = g.add("track", "BurtsonSAM2VideoTrack", images=frames,
                    points=json.dumps([{"x": subject.x, "y": subject.y}]), model=SAM2_MODEL, threshold=0.0)
    g.add("shape", "BurtsonSwapMasks", mask=tracked, grow=mask_grow(plan), block=mask_block(plan),
          box_padding=0.1)
    pose_model = g.add("pose_model", "CheckpointLoaderSimple", ckpt_name=vw.POSE_MODEL)
    keypoints = g.add("keypoints", "SDPoseKeypointExtractor", model=pose_model, vae=["pose_model", 2],
                      image=frames, batch_size=16, bboxes=["shape", 1])
    # Wan-Animate's pose video is body + hands on black; the face drives through the face video.
    pose = g.add("pose", "SDPoseDrawKeypoints", keypoints=keypoints, draw_body=True, draw_hands=True,
                 draw_face=False, draw_feet=False, stick_width=4, face_point_size=3,
                 score_threshold=0.3, draw_head=True)
    faces = g.add("faces", "BurtsonFaceCrops", images=frames, keypoints=keypoints, size=512, scale=1.5,
                  smoothing=0.5, threshold=0.3)
    mask_image = g.add("mask_image", "MaskToImage", mask=["shape", 0])
    _save(g, "save_mask", mask_image, f"{prefix}-mask")
    _save(g, "save_pose", pose, f"{prefix}-pose")
    _save(g, "save_face", faces, f"{prefix}-face")
    return g.nodes


def segment_workflow(plan: SwapPlan, *, window: Window, pass_index: int, reference: str, source_file: str,
                     pose_file: str, face_file: str, mask_file: str | None, tail_file: str | None,
                     prefix: str) -> dict[str, Any]:
    """One Wan2.2-Animate window. Every input video holds exactly ``window.length`` frames
    at generation size (the API cuts and pads them). Output node: ``save``."""
    g = _Graph()
    replace = plan.mode == "replace"
    width, height, length = plan.gen_width, plan.gen_height, window.length

    clip = g.add("clip", "CLIPLoader", clip_name=vw.TEXT_ENCODER, type="wan", device="default")
    positive = g.add("positive", "CLIPTextEncode", text=subject_prompt(plan, pass_index), clip=clip)
    negative = g.add("negative", "CLIPTextEncode", text=vw.NEGATIVE_PROMPT, clip=clip)
    vae = g.add("vae", "VAELoader", vae_name=vw.WAN21_VAE)
    reference_image = g.add("reference", "LoadImage", image=reference)
    vision = g.add("clip_vision", "CLIPVisionLoader", clip_name=CLIP_VISION)
    vision_out = g.add("clip_vision_encode", "CLIPVisionEncode", clip_vision=vision, image=reference_image,
                       crop="none")

    model = g.add("unet", "UNETLoader", unet_name=ANIMATE_MODEL, weight_dtype="default")
    if replace:
        model = g.add("lora_relight", "LoraLoaderModelOnly", model=model, lora_name=RELIGHT_LORA,
                      strength_model=1.0)
    if plan.accelerated:
        model = g.add("lora_distill", "LoraLoaderModelOnly", model=model, lora_name=DISTILL_LORA,
                      strength_model=1.0)
    model = g.add("model", "ModelSamplingSD3", model=model, shift=plan.shift)

    source = g.add("source_scaled", "ImageScale", image=_frames(g, "source", source_file),
                   upscale_method="lanczos", width=width, height=height, crop="center")
    pose = _frames(g, "pose", pose_file)
    face = _frames(g, "face", face_file)
    cond: dict[str, Any] = {
        "positive": positive, "negative": negative, "vae": vae, "width": width, "height": height,
        "length": length, "batch_size": 1, "clip_vision_output": vision_out,
        "reference_image": reference_image, "face_video": face, "pose_video": pose,
        "continue_motion_max_frames": OVERLAP_FRAMES, "video_frame_offset": 0,
    }
    soft = None
    if replace:
        if not mask_file:
            raise ValueError("replace needs the person's mask")
        mask_scaled = g.add("mask_scaled", "ImageScale", image=_frames(g, "mask", mask_file),
                            upscale_method="bilinear", width=width, height=height, crop="center")
        mask = g.add("mask_threshold", "ThresholdMask",
                     mask=g.add("mask_channel", "ImageToMask", image=mask_scaled, channel="red"), value=0.5)
        black = g.add("black", "EmptyImage", width=width, height=height, batch_size=length, color=0)
        # Wan-Animate's background video: the scene with the person's region blacked out.
        cond["background_video"] = g.add("background", "ImageCompositeMasked", destination=source,
                                         source=black, x=0, y=0, resize_source=False, mask=mask)
        cond["character_mask"] = mask
        radius = max(3, round(6 * height / 480))
        blurred = g.add("mask_soft_image", "ImageBlur", image=g.add("mask_as_image", "MaskToImage", mask=mask),
                        blur_radius=min(31, radius), sigma=max(1.0, radius / 2))
        soft = g.add("mask_soft", "ImageToMask", image=blurred, channel="red")
    if tail_file and window.overlap:
        cond["continue_motion"] = _frames(g, "tail", tail_file)
        cond["video_frame_offset"] = window.overlap
    g.add("cond", "WanAnimateToVideo", **cond)
    sampled = g.add("sampler", "KSampler", model=model, seed=segment_seed(plan, pass_index, window.index),
                    steps=plan.steps, cfg=plan.cfg, sampler_name="euler", scheduler="simple",
                    positive=["cond", 0], negative=["cond", 1], latent_image=["cond", 2], denoise=1.0)
    trimmed = g.add("trim", "TrimVideoLatent", samples=sampled, trim_amount=["cond", 3])
    decoded = g.add("decode", "VAEDecode", samples=trimmed, vae=vae)
    frames = decoded
    if replace:
        # Outside the feathered mask the scene stays the source's own pixels, so
        # people swapped in earlier passes and the background never drift.
        frames = g.add("composite", "ImageCompositeMasked", destination=source, source=decoded, x=0, y=0,
                       resize_source=False, mask=soft)
    _save(g, "save", frames, prefix)
    return g.nodes


def subject_prompt(plan: SwapPlan, pass_index: int) -> str:
    """The pass's person description, then the job prompt (scene, motion)."""
    subject = plan.subjects[pass_index] if pass_index < len(plan.subjects) else None
    own = (subject.prompt or "").strip() if subject else ""
    return f"{own} {plan.prompt}".strip() if own else plan.prompt


def finish_workflow(plan: SwapPlan, source_file: str, prefix: str) -> dict[str, Any]:
    """Upscale (1080p) and interpolate one chunk of the stitched result. Output node: ``save``."""
    g = _Graph()
    frames = _frames(g, "source", source_file)
    if plan.upscale:
        upscaler = g.add("upscale_model", "UpscaleModelLoader", model_name=vw.UPSCALE_MODEL)
        frames = g.add("upscale", "ImageUpscaleWithModel", upscale_model=upscaler, image=frames)
    if (plan.out_width, plan.out_height) != (plan.gen_width, plan.gen_height) or plan.upscale:
        frames = g.add("resize", "ImageScale", image=frames, upscale_method="lanczos",
                       width=plan.out_width, height=plan.out_height, crop="center")
    if plan.interpolation > 1:
        model = g.add("interp_model", "FrameInterpolationModelLoader", model_name=vw.INTERPOLATION_MODEL)
        frames = g.add("interpolate", "FrameInterpolate", interp_model=model, images=frames,
                       multiplier=plan.interpolation)
    _save(g, "save", frames, prefix, crf=12.0, fps=plan.workflow_fps)
    return g.nodes


def needs_finish(plan: SwapPlan) -> bool:
    return plan.upscale or plan.interpolation > 1 or (plan.out_width, plan.out_height) != (plan.gen_width, plan.gen_height)


def finish_chunks(frames: int) -> list[tuple[int, int]]:
    """[start, end) chunks that share their boundary frame, so interpolated chunks
    join exactly once the first frame of every later chunk is dropped."""
    chunks, start = [], 0
    while True:
        end = min(frames, start + FINISH_CHUNK_FRAMES)
        chunks.append((start, end))
        if end >= frames:
            return chunks
        start = end - 1


def segment_seed(plan: SwapPlan, pass_index: int, window_index: int) -> int:
    return plan.seed + 100 * pass_index + window_index


def checkpoints(plan: SwapPlan) -> list[str]:
    names = [ANIMATE_MODEL, vw.TEXT_ENCODER, vw.WAN21_VAE, CLIP_VISION, SAM2_FILE, vw.POSE_MODEL]
    if plan.mode == "replace":
        names.append(RELIGHT_LORA)
    if plan.accelerated:
        names.append(DISTILL_LORA)
    if plan.upscale:
        names.append(vw.UPSCALE_MODEL)
    if plan.interpolation > 1:
        names.append(vw.INTERPOLATION_MODEL)
    return names


def model_digests(plan: SwapPlan) -> dict[str, str]:
    return {name: CHECKPOINT_SHA256.get(name) or vw.CHECKPOINT_SHA256.get(name, "unverified")
            for name in checkpoints(plan)}


# --- estimates -----------------------------------------------------------------

def schedule(plan: SwapPlan) -> str:
    return "lightning" if plan.accelerated else "full"


def tier(plan: SwapPlan) -> str:
    return "480p" if plan.resolution == "480p" else "720p"


def sample_key(plan: SwapPlan) -> str:
    return f"animate-{plan.mode}|video-quality|{tier(plan)}|{schedule(plan)}"


def prepare_key(plan: SwapPlan) -> str:
    return f"swap-prepare|video-quality|{tier(plan)}|-"


def finish_key(plan: SwapPlan) -> str:
    return f"swap-finish|video-quality|{plan.resolution}|x{plan.interpolation}"


# Seconds per second. Sampling: per generated second per pass; prepare: per
# processed second per person; finish: per delivered second. Seeds are
# estimates from the VACE/I2V measurements on the 5090; real runs replace them.
SEED_RATES: dict[str, float] = {
    "animate-replace|video-quality|480p|lightning": 12, "animate-replace|video-quality|720p|lightning": 30,
    "animate-animate|video-quality|480p|lightning": 11, "animate-animate|video-quality|720p|lightning": 28,
    "animate-replace|video-quality|480p|full": 38, "animate-replace|video-quality|720p|full": 95,
    "animate-animate|video-quality|480p|full": 36, "animate-animate|video-quality|720p|full": 90,
    "swap-prepare|video-quality|480p|-": 4, "swap-prepare|video-quality|720p|-": 6,
    "swap-finish|video-quality|480p|x3": 1.5, "swap-finish|video-quality|480p|x2": 1.2,
    "swap-finish|video-quality|720p|x3": 3, "swap-finish|video-quality|720p|x2": 2.5,
    "swap-finish|video-quality|1080p|x3": 9, "swap-finish|video-quality|1080p|x2": 8,
}
STITCH_SECONDS_PER_SECOND = 0.6  # CPU: window cuts, crossfade stitch, audio mux, encode


def estimate(calibration, plan: SwapPlan) -> dict[str, Any]:
    """Whole-job estimate (GPU ready): model load + prepare + sampling + finish + stitching."""
    sample_rate, basis, samples = calibration.rate(sample_key(plan))
    prepare_rate = calibration.rate(prepare_key(plan))[0]
    finish_rate = calibration.rate(finish_key(plan))[0] if needs_finish(plan) else 0.0
    generated = plan.generated_frames / FPS
    seconds = plan.duration_seconds
    load = calibration.load_seconds()
    prepare = prepare_rate * seconds * len(plan.subjects)
    sampling = sample_rate * generated * plan.passes
    finish = finish_rate * seconds
    stitch = STITCH_SECONDS_PER_SECOND * seconds * (plan.passes + 1)
    total = load * (1 + 0.5 * (plan.passes - 1)) + prepare + sampling + finish + stitch
    return {
        "key": sample_key(plan), "basis": basis, "samples": samples,
        "ratePerSecond": round(sample_rate, 2),
        "perTakeSeconds": round(total - load),
        "loadSeconds": round(load),
        "prepareSeconds": round(prepare), "samplingSeconds": round(sampling),
        "finishSeconds": round(finish), "stitchSeconds": round(stitch),
        "claimSeconds": round(vw_claim_seconds()),
        "variants": 1,
        "passes": plan.passes, "segments": len(plan.windows),
        "processedSeconds": plan.duration_seconds,
        "seconds": round(total),
    }


def vw_claim_seconds() -> float:
    from . import estimates as est
    return est.CLAIM_SECONDS
