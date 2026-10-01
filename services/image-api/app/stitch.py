"""Frame-exact video plumbing for people swap (ffmpeg + numpy, CPU only).

- ``cut``: one generation window of a 16 fps intermediate, padded by repeating
  the last frame so every Wan-Animate input has exactly the window's length.
- ``Stitcher``: joins generated windows into one pass. Consecutive windows
  share ``overlap`` frames (the second continued from the first's tail); the
  overlap is crossfaded linearly so seams do not pop.
- ``join_chunks``: concatenates interpolated finish chunks that share their
  boundary frame.
- ``deliver``: the final H.264/yuv420p/faststart encode with the source's
  audio trimmed to the processed range (or no audio).
"""
from __future__ import annotations

import json
import os
import subprocess
from typing import Iterator

import numpy as np

FFMPEG = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
INTERMEDIATE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-pix_fmt", "yuv420p"]


def run(command: list[str], timeout: int = 1800) -> None:
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.strip()[-400:]}")


def probe(path: str) -> dict:
    result = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
        "-show_entries", "stream=width,height,nb_read_frames,r_frame_rate", "-of", "json", path,
    ], capture_output=True, text=True, timeout=300, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed on {os.path.basename(path)}")
    stream = (json.loads(result.stdout or "{}").get("streams") or [{}])[0]
    return {"width": int(stream.get("width") or 0), "height": int(stream.get("height") or 0),
            "frames": int(stream.get("nb_read_frames") or 0)}


def has_audio(path: str) -> bool:
    result = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type",
        "-of", "csv=p=0", path,
    ], capture_output=True, text=True, timeout=60, check=False)
    return result.returncode == 0 and "audio" in result.stdout


def extract_audio(source: str, target: str, max_seconds: float) -> bool:
    """AAC copy of the first audio stream (first ``max_seconds``); False when there is none."""
    if not has_audio(source):
        return False
    run(FFMPEG + ["-i", source, "-t", str(max_seconds), "-map", "0:a:0", "-vn", "-sn", "-dn",
                  "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-movflags", "+faststart", target])
    return os.path.getsize(target) > 0


def prepare_range(source: str, target: str, *, start: int, frames: int, width: int, height: int,
                  fps: int = 16) -> None:
    """The processed range of the normalised source at generation size (centre crop)."""
    scale = (f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,"
             f"crop={width}:{height},setsar=1")
    run(FFMPEG + ["-i", source, "-vf",
                  f"trim=start_frame={start}:end_frame={start + frames},setpts=PTS-STARTPTS,{scale},fps={fps}",
                  "-frames:v", str(frames), "-an", *INTERMEDIATE, "-r", str(fps), target])


def cut(source: str, target: str, *, start: int, length: int, total: int, fps: int = 16) -> None:
    """Frames [start, start + length) of a ``total``-frame clip, holding the last frame past the end."""
    end = min(start + length, total)
    pad = start + length - end
    chain = f"trim=start_frame={start}:end_frame={end},setpts=PTS-STARTPTS"
    if pad > 0:
        chain += f",tpad=stop_mode=clone:stop={pad}"
    run(FFMPEG + ["-i", source, "-vf", chain, "-frames:v", str(length), "-an", *INTERMEDIATE,
                  "-r", str(fps), target])


def frames_of(path: str, width: int, height: int) -> Iterator[np.ndarray]:
    """Decode a video as RGB frames at exactly width x height."""
    process = subprocess.Popen(
        FFMPEG + ["-i", path, "-vf", f"scale={width}:{height}:flags=lanczos", "-f", "rawvideo",
                  "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    size = width * height * 3
    try:
        while True:
            chunk = process.stdout.read(size)
            if len(chunk) < size:
                break
            yield np.frombuffer(chunk, dtype=np.uint8).reshape(height, width, 3)
    finally:
        process.stdout.close()
        process.wait(timeout=60)


class Encoder:
    """Raw RGB frames in, near-lossless H.264 out."""

    def __init__(self, path: str, width: int, height: int, fps: float, crf: str = "10"):
        self.path, self.count = path, 0
        self.process = subprocess.Popen(
            FFMPEG + ["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}", "-r", str(fps),
                      "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-pix_fmt", "yuv420p",
                      path],
            stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    def write(self, frame: np.ndarray) -> None:
        self.process.stdin.write(np.ascontiguousarray(frame, dtype=np.uint8).tobytes())
        self.count += 1

    def close(self) -> None:
        self.process.stdin.close()
        stderr = self.process.stderr.read().decode(errors="replace")
        self.process.stderr.close()
        if self.process.wait(timeout=600) != 0:
            raise RuntimeError(f"ffmpeg encode failed: {stderr.strip()[-400:]}")


def blend(previous: np.ndarray, current: np.ndarray, position: int, overlap: int) -> np.ndarray:
    """Linear crossfade weight for overlap frame ``position`` (0-based) of ``overlap``."""
    alpha = (position + 1) / (overlap + 1)
    mixed = previous.astype(np.float32) * (1 - alpha) + current.astype(np.float32) * alpha
    return np.clip(np.rint(mixed), 0, 255).astype(np.uint8)


class Stitcher:
    """Joins overlapping windows into one ``total``-frame clip at 16 fps.

    Each window's last ``overlap`` frames are held back: they are the frames the
    next window continues from (``tail``), and get crossfaded with that
    window's first frames.
    """

    def __init__(self, path: str, width: int, height: int, total: int, overlap: int, fps: int = 16):
        self.width, self.height, self.total, self.overlap = width, height, total, overlap
        self.encoder = Encoder(path, width, height, fps)
        self.pending: list[np.ndarray] = []
        self.position = 0  # timeline index of the next frame to be produced

    def add(self, path: str, start: int, overlap: int) -> None:
        # A window begins ``overlap`` frames before the end of the timeline so far.
        if start != self.position - overlap or overlap > len(self.pending):
            raise ValueError(f"window starts at {start} with overlap {overlap}; the timeline is at {self.position}")
        frames = list(frames_of(path, self.width, self.height))
        wanted = min(len(frames), self.total - start)
        if wanted <= overlap:
            raise RuntimeError("a generated window came back shorter than its overlap")
        frames = frames[:wanted]
        held = self.pending[-overlap:] if overlap else []
        for frame in self.pending[:len(self.pending) - len(held)]:
            self.encoder.write(frame)
        for index, previous in enumerate(held):
            self.encoder.write(blend(previous, frames[index], index, overlap))
        fresh = frames[overlap:]
        self.position = start + wanted
        if self.position >= self.total:
            for frame in fresh:
                self.encoder.write(frame)
            self.pending = []
        else:
            keep = self.overlap
            for frame in fresh[:-keep] if keep else fresh:
                self.encoder.write(frame)
            self.pending = list(fresh[-keep:]) if keep else []

    def tail(self, path: str, fps: int = 16) -> None:
        """Write the held-back frames (what the next window continues from)."""
        if not self.pending:
            raise RuntimeError("no frames to continue from")
        encoder = Encoder(path, self.width, self.height, fps)
        for frame in self.pending:
            encoder.write(frame)
        encoder.close()

    def close(self) -> int:
        for frame in self.pending:
            self.encoder.write(frame)
        self.pending = []
        self.encoder.close()
        return self.encoder.count


def join_chunks(paths: list[str], target: str, width: int, height: int, fps: float) -> int:
    """Concatenate chunks that share their boundary frame (drop each later chunk's first)."""
    encoder = Encoder(target, width, height, fps, crf="12")
    for number, path in enumerate(paths):
        for index, frame in enumerate(frames_of(path, width, height)):
            if number and index == 0:
                continue
            encoder.write(frame)
    encoder.close()
    return encoder.count


def deliver(video: str, target: str, *, width: int, height: int, fps: int, crf: str,
            audio: str | None, audio_start: float, duration: float) -> None:
    """Final delivery encode; the source's audio (trimmed to the range) when given."""
    command = FFMPEG + ["-i", video]
    if audio:
        command += ["-ss", f"{audio_start:.3f}", "-t", f"{duration:.3f}", "-i", audio]
    command += ["-map", "0:v:0"]
    if audio:
        command += ["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k", "-af", "apad", "-t", f"{duration:.3f}"]
    else:
        command += ["-an"]
    command += ["-vf", f"fps={fps},scale={width}:{height}:flags=lanczos,setsar=1",
                "-c:v", "libx264", "-preset", "medium", "-crf", crf, "-profile:v", "high",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart", target]
    run(command)
