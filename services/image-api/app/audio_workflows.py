"""Server-owned ComfyUI workflow for music: ACE-Step 1.5 XL SFT (Quality, default) or 2B turbo (Fast).

ComfyUI supports ACE-Step 1.5 natively at the pinned commit (96be9a1):
UNETLoader + DualCLIPLoader(type "ace") + VAELoader, TextEncodeAceStepAudio1.5,
EmptyAceStep1.5LatentAudio, ModelSamplingAuraFlow and KSampler (the Comfy-Org
"ACE-Step 1.5 split" template). ComfyUI sizes the DiT from the weights, so the XL
checkpoints load through the same graph; steps, CFG and shift come from MUSIC_MODELS.

Licences (verified 2026-10-01, see /mnt/ai-models/comfyui/manifests/MODELS-audio.md
and MODELS-audio-xl.md): the DiTs, the 5 Hz LMs and the VAE are MIT (ACE-Step); the text
embedding model is Qwen3-Embedding-0.6B, Apache-2.0. The model card states the
training data is licensed, royalty-free/public-domain and synthetic music and
that output may be used commercially.

No sound-effects model is installed: every candidate failed the licence bar
(see SFX_UNAVAILABLE_REASON).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

TEXT_ENCODER = "qwen_0.6b_ace15.safetensors"
VAE = "ace_1.5_vae.safetensors"
MODEL_LICENSE = "MIT"


@dataclass(frozen=True)
class MusicModel:
    alias: str
    label: str
    description: str
    diffusion_model: str
    lm_model: str
    workflow_version: str
    steps: int
    cfg: float
    shift: float


# Fast: the 2B turbo DiT (8 steps, no CFG) with the 1.7B 5 Hz LM. Quality: the 4B XL SFT DiT
# (50 steps with CFG) with the 4B LM, which the model card ranks highest; the 2B turbo leans on
# the synthetic (MIDI-rendered) part of the training data and can sound like a MIDI mock-up.
MUSIC_MODELS: dict[str, MusicModel] = {
    "music-ace15-xl": MusicModel(
        alias="music-ace15-xl", label="Quality", description="ACE-Step 1.5 XL SFT (4B) with the 4B planner",
        diffusion_model="acestep_v1.5_xl_sft_bf16.safetensors", lm_model="qwen_4b_ace15.safetensors",
        workflow_version="ace15-xl-sft-v1", steps=50, cfg=5.0, shift=1.0),
    "music-ace15": MusicModel(
        alias="music-ace15", label="Fast", description="ACE-Step 1.5 turbo (2B) with the 1.7B planner",
        diffusion_model="acestep_v1.5_turbo.safetensors", lm_model="qwen_1.7b_ace15.safetensors",
        workflow_version="ace15-turbo-v1", steps=8, cfg=1.0, shift=3.0),
}
DEFAULT_MUSIC_MODEL = "music-ace15-xl"
MusicModelAlias = Literal["music-ace15-xl", "music-ace15"]

CHECKPOINT_SHA256: dict[str, str] = {
    "acestep_v1.5_turbo.safetensors": "3f6e0797fad420a39bd33979eb6e840e30989e34a3794e843d23b60ec6e422d7",
    "acestep_v1.5_xl_sft_bf16.safetensors": "3c05ae268353b3540fb1fd7db4fd77ffbda9802ec641b624e15648e030ecf3ce",
    TEXT_ENCODER: "fd4590c82153b8ddb67e15a2e7aaa8afa8b83a858c8a9b82a4831063156aa7a7",
    "qwen_1.7b_ace15.safetensors": "ed63e9247d1f55f3ace04fa11e95b085fc82d459c82c5626f0b2e37b91ebd710",
    "qwen_4b_ace15.safetensors": "ffe5ffb855086c2ab55e467e9859fb01894781020a0376484dd19de166b79873",
    VAE: "6de92e3a862acd287e08b024ac90f0783a8635451b728721a33ff03565bcb2bb",
}


def music_model(alias: str | None) -> MusicModel:
    model = MUSIC_MODELS.get(alias or DEFAULT_MUSIC_MODEL)
    if model is None:
        raise ValueError(f"unknown music model {alias!r}")
    return model


MIN_SECONDS = 3.0
MAX_SECONDS = 240.0
# Loopable tracks render this much extra and crossfade the tail into the head.
LOOP_CROSSFADE_SECONDS = 4.0
INSTRUMENTAL_LYRICS = "[Instrumental]"
DEFAULT_BPM_INSTRUMENTAL = 100
DEFAULT_BPM_SONG = 110

TimeSignature = Literal["2", "3", "4", "6"]
TIME_SIGNATURES = ("2", "3", "4", "6")
LANGUAGES = (
    "ar", "az", "bg", "bn", "ca", "cs", "da", "de", "el", "en", "es", "fa", "fi", "fr", "he", "hi", "hr", "ht",
    "hu", "id", "is", "it", "ja", "ko", "la", "lt", "ms", "ne", "nl", "no", "pa", "pl", "pt", "ro", "ru", "sa",
    "sk", "sr", "sv", "sw", "ta", "te", "th", "tl", "tr", "uk", "ur", "vi", "yue", "zh", "unknown",
)
KEY_ROOTS = ("C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B")
KEYSCALES = tuple(f"{root} {quality}" for quality in ("major", "minor") for root in KEY_ROOTS)

SFX_UNAVAILABLE_REASON = (
    "No sound-effects model with a commercial-friendly licence is installed. MMAudio weights are CC-BY-NC-4.0; "
    "ThinkSound is research-only and ships a Stability AI Community License VAE; HunyuanVideo-Foley uses the "
    "Tencent Hunyuan Community License (territory and user-count limits); Stable Audio 3 SFX is under the "
    "Stability AI Community License (revenue cap). Keep the clip's original audio or add music instead."
)


@dataclass(frozen=True)
class MusicPlan:
    prompt: str
    tags: str
    lyrics: str
    instrumental: bool
    seed: int
    bpm: int
    keyscale: str
    time_signature: str
    language: str
    duration_seconds: float   # what the user gets
    render_seconds: float     # what the model generates (adds the loop overlap)
    loopable: bool
    model: str = DEFAULT_MUSIC_MODEL

    @property
    def spec(self) -> MusicModel:
        return music_model(self.model)

    def describe(self) -> dict[str, Any]:
        return {
            "model": self.model, "workflowVersion": self.spec.workflow_version, "tags": self.tags,
            "instrumental": self.instrumental, "seed": self.seed, "bpm": self.bpm, "keyscale": self.keyscale,
            "timeSignature": self.time_signature, "language": self.language,
            "durationSeconds": self.duration_seconds, "renderSeconds": self.render_seconds,
            "loopable": self.loopable, "steps": self.spec.steps, "cfg": self.spec.cfg,
        }


def music_tags(prompt: str, genre: str | None = None, mood: str | None = None) -> str:
    """The caption ACE-Step conditions on: the prompt plus genre/mood hints, de-duplicated."""
    parts = [" ".join((prompt or "").split())]
    for hint in (genre, mood):
        hint = " ".join((hint or "").split())
        if hint and hint.lower() not in parts[0].lower():
            parts.append(hint)
    return ", ".join(part for part in parts if part)


def default_keyscale(mood: str | None, prompt: str) -> str:
    text = f"{mood or ''} {prompt}".lower()
    minor = any(word in text for word in ("tense", "dark", "sad", "suspense", "somber", "sombre", "melanch",
                                          "serious", "ominous", "tension", "moody", "minor"))
    return "A minor" if minor else "C major"


def plan_music(*, prompt: str, seed: int, duration_seconds: float, instrumental: bool = True,
               lyrics: str | None = None, genre: str | None = None, mood: str | None = None,
               bpm: int | None = None, keyscale: str | None = None, time_signature: str = "4",
               language: str = "en", loopable: bool = False, model: str | None = None) -> MusicPlan:
    """Validate and resolve one music take. Raises ValueError for impossible requests."""
    if not (MIN_SECONDS <= duration_seconds <= MAX_SECONDS):
        raise ValueError(f"durationSeconds must be {MIN_SECONDS:g}-{MAX_SECONDS:g}")
    if time_signature not in TIME_SIGNATURES:
        raise ValueError("timeSignature must be one of 2, 3, 4, 6")
    if language not in LANGUAGES:
        raise ValueError("unsupported language")
    if keyscale is not None and keyscale not in KEYSCALES:
        raise ValueError("keyscale must look like 'C major' or 'F# minor'")
    spec = music_model(model)
    words = (lyrics or "").strip()
    if not instrumental and not words:
        raise ValueError("lyrics are required for a song (or set instrumental)")
    if loopable and duration_seconds < LOOP_CROSSFADE_SECONDS * 3:
        raise ValueError(f"a loopable track must be at least {LOOP_CROSSFADE_SECONDS * 3:g} s")
    tags = music_tags(prompt, genre, mood)
    if instrumental and "instrumental" not in tags.lower():
        tags = f"{tags}, instrumental"
    resolved_bpm = bpm or (DEFAULT_BPM_INSTRUMENTAL if instrumental else DEFAULT_BPM_SONG)
    render = duration_seconds + (LOOP_CROSSFADE_SECONDS if loopable else 0.0)
    return MusicPlan(
        prompt=prompt, tags=tags, lyrics=INSTRUMENTAL_LYRICS if instrumental else words, instrumental=instrumental,
        seed=int(seed), bpm=int(resolved_bpm), keyscale=keyscale or default_keyscale(mood, prompt),
        time_signature=time_signature, language=language, duration_seconds=round(float(duration_seconds), 2),
        render_seconds=round(float(render), 2), loopable=loopable, model=spec.alias,
    )


def ace_workflow(plan: MusicPlan, *, filename_prefix: str) -> dict[str, Any]:
    """ComfyUI API-format prompt for one take (node ids are stable for progress/outputs)."""
    return {
        "unet": {"class_type": "UNETLoader", "inputs": {"unet_name": plan.spec.diffusion_model, "weight_dtype": "default"}},
        "clip": {"class_type": "DualCLIPLoader", "inputs": {
            "clip_name1": TEXT_ENCODER, "clip_name2": plan.spec.lm_model, "type": "ace", "device": "default"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "shift": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["unet", 0], "shift": plan.spec.shift}},
        "encode": {"class_type": "TextEncodeAceStepAudio1.5", "inputs": {
            "clip": ["clip", 0], "tags": plan.tags, "lyrics": plan.lyrics, "seed": plan.seed % (2**63),
            "bpm": plan.bpm, "duration": plan.render_seconds, "timesignature": plan.time_signature,
            "language": plan.language, "keyscale": plan.keyscale, "generate_audio_codes": True,
            "cfg_scale": 2.0, "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
        }},
        "negative": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["encode", 0]}},
        "latent": {"class_type": "EmptyAceStep1.5LatentAudio", "inputs": {
            "seconds": plan.render_seconds, "batch_size": 1}},
        "sampler": {"class_type": "KSampler", "inputs": {
            "model": ["shift", 0], "seed": plan.seed % (2**63), "steps": plan.spec.steps, "cfg": plan.spec.cfg,
            "sampler_name": "euler", "scheduler": "simple", "positive": ["encode", 0],
            "negative": ["negative", 0], "latent_image": ["latent", 0], "denoise": 1.0,
        }},
        "decode": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["sampler", 0], "vae": ["vae", 0]}},
        "save": {"class_type": "SaveAudio", "inputs": {"audio": ["decode", 0], "filename_prefix": filename_prefix}},
    }


def plan_checkpoints(plan: MusicPlan) -> list[str]:
    return [plan.spec.diffusion_model, TEXT_ENCODER, plan.spec.lm_model, VAE]
