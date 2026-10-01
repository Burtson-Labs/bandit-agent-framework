"""Burtson people-swap preprocessing nodes (owned code, no third-party custom nodes).

ComfyUI core has everything Wan2.2-Animate needs except an Apache-2.0 video
tracker: its SAM 3 nodes use Meta's SAM License, so person tracking uses
SAM 2.1 (facebook/sam2.1-hiera-large, Apache-2.0) through the transformers
Sam2Video classes already in the worker image. Weights are read from the
read-only models volume (models/sam2/<name>/); nothing is downloaded.

Nodes:
  BurtsonSAM2VideoTrack  one seed point per person on frame 0 -> a mask per person per frame
  BurtsonSwapMasks       mask -> grown + blockified character mask (Wan-Animate style) and
                         per-frame person boxes for SDPose's top-down keypoints
  BurtsonFaceCrops       SDPose face keypoints -> steady square face crops (Animate's face video)
"""
from __future__ import annotations

import gc
import json
import logging
import os

import numpy as np
import torch
import torch.nn.functional as F

import comfy.model_management
import comfy.utils
import folder_paths

logger = logging.getLogger("burtson.people")

MAX_PEOPLE = 4
# Outputs older than this many frames are dropped from the tracker state; SAM 2
# attends to the conditioning frame, the last 7 memories and up to 16 object
# pointers, so 32 leaves headroom while keeping a 60 s clip's state small.
KEEP_TRACK_FRAMES = 32


def _sam2_dir(name: str) -> str:
    if not name or "/" in name or "\\" in name or name.startswith("."):
        raise ValueError("model must be a folder name under models/sam2")
    path = os.path.join(folder_paths.models_dir, "sam2", name)
    if not os.path.isfile(os.path.join(path, "model.safetensors")):
        raise FileNotFoundError(f"SAM 2 weights not found in models/sam2/{name}")
    return path


def _parse_points(points: str) -> list[tuple[float, float]]:
    try:
        data = json.loads(points)
    except json.JSONDecodeError as exc:
        raise ValueError("points must be JSON: [{\"x\": 0..1, \"y\": 0..1}, ...]") from exc
    if not isinstance(data, list) or not 1 <= len(data) <= MAX_PEOPLE:
        raise ValueError(f"points must list 1 to {MAX_PEOPLE} people")
    parsed = []
    for item in data:
        x, y = float(item["x"]), float(item["y"])
        if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
            raise ValueError("point coordinates are normalised to 0..1")
        parsed.append((x, y))
    return parsed


def _prune(session, frame_idx: int) -> None:
    """Drop the raw frame and old per-frame outputs the tracker no longer reads."""
    frames = getattr(session, "processed_frames", None)
    if isinstance(frames, dict) and frame_idx > 0:
        frames.pop(frame_idx, None)
    old = frame_idx - KEEP_TRACK_FRAMES
    if old <= 0:
        return
    for outputs in getattr(session, "output_dict_per_obj", {}).values():
        outputs.get("non_cond_frame_outputs", {}).pop(old, None)


class BurtsonSAM2VideoTrack:
    """Track up to four people through a clip from one tap point each on frame 0."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "points": ("STRING", {"default": "[{\"x\": 0.5, \"y\": 0.5}]", "multiline": False}),
                "model": ("STRING", {"default": "sam2.1-hiera-large"}),
                "threshold": ("FLOAT", {"default": 0.0, "min": -10.0, "max": 10.0, "step": 0.1}),
            }
        }

    RETURN_TYPES = ("MASK", "MASK", "MASK", "MASK")
    RETURN_NAMES = ("mask_1", "mask_2", "mask_3", "mask_4")
    FUNCTION = "track"
    CATEGORY = "burtson/people"

    def track(self, images, points, model, threshold):
        from transformers import Sam2VideoModel, Sam2VideoProcessor

        seeds = _parse_points(points)
        frames, height, width = images.shape[0], images.shape[1], images.shape[2]
        path = _sam2_dir(model)
        device = comfy.model_management.get_torch_device()
        dtype = torch.bfloat16 if comfy.model_management.should_use_bf16(device) else torch.float16
        # Make room: the diffusion model is loaded later in the same prompt.
        comfy.model_management.free_memory(4 * 1024 ** 3, device)

        processor = Sam2VideoProcessor.from_pretrained(path)
        tracker = Sam2VideoModel.from_pretrained(path, torch_dtype=dtype).to(device).eval()
        masks = torch.zeros((len(seeds), frames, height, width), dtype=torch.uint8)
        pbar = comfy.utils.ProgressBar(frames)
        try:
            with torch.inference_mode():
                session = processor.init_video_session(
                    inference_device=device, video_storage_device="cpu", dtype=dtype)
                for index in range(frames):
                    frame = (images[index, :, :, :3].clamp(0, 1) * 255).to(torch.uint8).numpy()
                    inputs = processor(images=frame, device=device, return_tensors="pt")
                    if index == 0:
                        processor.add_inputs_to_inference_session(
                            inference_session=session, frame_idx=0,
                            obj_ids=list(range(1, len(seeds) + 1)),
                            input_points=[[[[x * width, y * height]] for x, y in seeds]],
                            input_labels=[[[1] for _ in seeds]],
                            original_size=inputs.original_sizes[0],
                        )
                    output = tracker(inference_session=session, frame=inputs.pixel_values[0].to(dtype))
                    logits = processor.post_process_masks(
                        [output.pred_masks], original_sizes=inputs.original_sizes, binarize=False)[0]
                    masks[:, index] = (logits[:, 0] > threshold).to("cpu", torch.uint8)
                    _prune(session, index)
                    pbar.update(1)
        finally:
            del tracker
            gc.collect()
            comfy.model_management.soft_empty_cache()

        result = [masks[i].float() for i in range(len(seeds))]
        empty = torch.zeros((frames, height, width), dtype=torch.float32)
        while len(result) < MAX_PEOPLE:
            result.append(empty)
        for number, mask in enumerate(result[:len(seeds)], start=1):
            coverage = float(mask.mean())
            logger.info("person %d tracked: %.1f%% of pixels on average, empty in %d of %d frames",
                        number, 100 * coverage, int((mask.flatten(1).amax(1) == 0).sum()), frames)
        return tuple(result)


def _dilate(mask: torch.Tensor, radius: int) -> torch.Tensor:
    if radius <= 0:
        return mask
    kernel = 2 * radius + 1
    return F.max_pool2d(mask.unsqueeze(1), kernel, stride=1, padding=radius).squeeze(1)


def _blockify(mask: torch.Tensor, block: int) -> torch.Tensor:
    """Any covered pixel marks its whole block (Wan-Animate's training masks are blocky)."""
    if block <= 1:
        return mask
    height, width = mask.shape[-2:]
    pad_h, pad_w = (-height) % block, (-width) % block
    padded = F.pad(mask.unsqueeze(1), (0, pad_w, 0, pad_h))
    pooled = F.max_pool2d(padded, block, stride=block)
    return F.interpolate(pooled, scale_factor=block, mode="nearest")[:, 0, :height, :width]


def _bbox(mask: torch.Tensor, pad: float) -> dict | None:
    ys, xs = torch.nonzero(mask > 0.5, as_tuple=True)
    if ys.numel() == 0:
        return None
    height, width = mask.shape
    x1, x2, y1, y2 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
    px, py = int((x2 - x1) * pad), int((y2 - y1) * pad)
    x1, y1 = max(0, x1 - px), max(0, y1 - py)
    x2, y2 = min(width, x2 + px), min(height, y2 + py)
    return {"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1}


class BurtsonSwapMasks:
    """Shape a tracked person mask for Wan-Animate and give SDPose one box per frame."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask": ("MASK",),
                "grow": ("INT", {"default": 10, "min": 0, "max": 256}),
                "block": ("INT", {"default": 32, "min": 0, "max": 256}),
                "box_padding": ("FLOAT", {"default": 0.1, "min": 0.0, "max": 1.0, "step": 0.01}),
            }
        }

    RETURN_TYPES = ("MASK", "BOUNDING_BOX")
    RETURN_NAMES = ("character_mask", "bboxes")
    FUNCTION = "shape"
    CATEGORY = "burtson/people"

    def shape(self, mask, grow, block, box_padding):
        mask = mask.reshape((-1, mask.shape[-2], mask.shape[-1])).float()
        frames, height, width = mask.shape
        # A frame where tracking lost the person keeps the last good mask, so the
        # region being regenerated never blinks off for a frame.
        held = mask.clone()
        last = None
        for index in range(frames):
            if held[index].amax() > 0:
                last = held[index]
            elif last is not None:
                held[index] = last
        shaped = torch.empty_like(held)
        for start in range(0, frames, 64):
            chunk = held[start:start + 64]
            shaped[start:start + 64] = _blockify(_dilate(chunk, grow), block)
        boxes = []
        last_box = {"x": 0, "y": 0, "width": width, "height": height}
        for index in range(frames):
            box = _bbox(_dilate(held[index:index + 1], grow)[0], box_padding) or last_box
            boxes.append([box])
            last_box = box
        return (shaped.clamp(0, 1), boxes)


def _face_box(person: dict, width: int, height: int, scale: float, threshold: float):
    flat = person.get("face_keypoints_2d") or []
    if not flat:
        return None
    points = np.array(flat, dtype=np.float32).reshape(-1, 3)
    good = points[points[:, 2] >= threshold][:, :2]
    if len(good) < 8:
        return None
    (x1, y1), (x2, y2) = good.min(axis=0), good.max(axis=0)
    w, h = x2 - x1, y2 - y1
    if w <= 1 or h <= 1:
        return None
    side = float(np.sqrt(w * h * scale)) * 1.15
    # Landmarks start at the brows; shift up a little so the crop holds the forehead.
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2 - 0.08 * side
    return cx, cy, side


class BurtsonFaceCrops:
    """Square face crops per frame from SDPose face keypoints, smoothed and gap-filled."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "keypoints": ("POSE_KEYPOINT",),
                "size": ("INT", {"default": 512, "min": 64, "max": 1024, "step": 8}),
                "scale": ("FLOAT", {"default": 1.5, "min": 1.0, "max": 4.0, "step": 0.1}),
                "smoothing": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 0.95, "step": 0.05}),
                "threshold": ("FLOAT", {"default": 0.3, "min": 0.0, "max": 1.0, "step": 0.05}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("faces",)
    FUNCTION = "crop"
    CATEGORY = "burtson/people"

    def crop(self, images, keypoints, size, scale, smoothing, threshold):
        frames, height, width = images.shape[0], images.shape[1], images.shape[2]
        boxes: list[tuple[float, float, float] | None] = []
        for index in range(frames):
            frame = keypoints[min(index, len(keypoints) - 1)] if keypoints else {"people": []}
            people = frame.get("people") or []
            boxes.append(_face_box(people[0], width, height, scale, threshold) if people else None)
        found = [box for box in boxes if box is not None]
        if not found:
            # No face anywhere: the upper-middle of the frame keeps the shapes valid.
            side = min(width, height) / 3
            found = [(width / 2, side, side)]
        # Fill gaps from the nearest earlier box (or the first one), then smooth.
        filled, last = [], found[0]
        for box in boxes:
            last = box if box is not None else last
            filled.append(last)
        smooth, state = [], None
        for box in filled:
            state = box if state is None else tuple(smoothing * s + (1 - smoothing) * b for s, b in zip(state, box))
            smooth.append(state)
        crops = torch.empty((frames, size, size, 3), dtype=images.dtype)
        for index, (cx, cy, side) in enumerate(smooth):
            side = max(16.0, min(side, float(max(width, height))))
            x1, y1 = int(round(cx - side / 2)), int(round(cy - side / 2))
            x2, y2 = x1 + int(round(side)), y1 + int(round(side))
            frame = images[index, :, :, :3].movedim(-1, 0).unsqueeze(0)
            # Pad instead of clamping so the face stays centred near frame edges.
            pad = (max(0, -x1), max(0, x2 - width), max(0, -y1), max(0, y2 - height))
            if any(pad):
                frame = F.pad(frame, pad, mode="replicate")
                x1, x2, y1, y2 = x1 + pad[0], x2 + pad[0], y1 + pad[2], y2 + pad[2]
            patch = frame[:, :, y1:y2, x1:x2]
            crops[index] = F.interpolate(patch, size=(size, size), mode="bilinear",
                                         align_corners=False)[0].movedim(0, -1)
        return (crops.clamp(0, 1),)


NODE_CLASS_MAPPINGS = {
    "BurtsonSAM2VideoTrack": BurtsonSAM2VideoTrack,
    "BurtsonSwapMasks": BurtsonSwapMasks,
    "BurtsonFaceCrops": BurtsonFaceCrops,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "BurtsonSAM2VideoTrack": "Burtson: track people (SAM 2.1)",
    "BurtsonSwapMasks": "Burtson: swap masks + boxes",
    "BurtsonFaceCrops": "Burtson: face crops",
}
