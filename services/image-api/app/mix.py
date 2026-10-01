"""Finishing: music beds, narration and captions mixed onto a Studio take (CPU, ffmpeg).

The recipe is the one proven in the walkthrough pipelines (rwt-load-intake
web/video/lib/music.mjs and the TrueMarks build.py):

- Voice first: every narration line is measured (EBU R128) and gained to
  speech at -16 LUFS, mono, centred in stereo, 48 kHz, placed on the timeline.
- The bed (music, and the take's own audio when kept) is gained from its
  measured loudness to rest ``bed_db`` under the voice, looped with
  crossfades when short, faded at both ends, and ducked further by a
  sidechain compressor keyed on the voice while a line plays.
- Without narration the bed is the programme, at -16 LUFS.
- No loudness normaliser runs over the sum (single-pass loudnorm rides the
  bed up between lines); a true-peak limiter at -1.5 dBTP guards it instead.

Everything that decides levels, timing and the filter graph is pure and
unit-tested; ``render`` and the measurement helpers run ffmpeg.
"""
from __future__ import annotations

import json
import math
import os
import re
import subprocess
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal

VOICE_LUFS = -16.0
VOICE_TP = -1.5
PROGRAMME_LUFS = -16.0
SILENT_LUFS = -60.0
SAMPLE_RATE = 48000
NARRATION_LEAD = 0.5
NARRATION_GAP = 0.4
NARRATION_TAIL = 0.6
LOOP_CROSSFADE = 4.0
BOOKEND_XFADE = 0.5
MAX_GAIN_DB = 30.0

Levels = Literal["voice-forward", "balanced", "music-forward"]


@dataclass(frozen=True)
class Duck:
    threshold: float
    ratio: float
    attack: float
    release: float


@dataclass(frozen=True)
class LevelPreset:
    bed_db: float      # where the bed rests under the voice, dB
    duck: Duck


LEVELS: dict[str, LevelPreset] = {
    # Narration first: bed well under, a firm dip while a line plays.
    "voice-forward": LevelPreset(-24.0, Duck(threshold=0.02, ratio=4.0, attack=30, release=600)),
    # The walkthrough default (TrueMarks ducking, a slightly higher bed).
    "balanced": LevelPreset(-20.0, Duck(threshold=0.02, ratio=3.0, attack=30, release=700)),
    # Music carries it: bed close under, a gentle dip that breathes back between lines.
    "music-forward": LevelPreset(-15.0, Duck(threshold=0.02, ratio=1.5, attack=40, release=900)),
}


def num(value: float) -> str:
    """Up to three decimals, no trailing zeros: stable text for a filter graph."""
    text = f"{round(float(value), 3):.3f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def db_to_linear(db: float) -> float:
    return 10 ** (db / 20)


def gain_to(target_lufs: float, measured_lufs: float) -> float:
    """dB that moves a source measured at ``measured_lufs`` to ``target_lufs`` (clamped)."""
    return max(-MAX_GAIN_DB, min(MAX_GAIN_DB, target_lufs - measured_lufs))


def loop_plan(track_seconds: float, need_seconds: float, crossfade: float = LOOP_CROSSFADE) -> tuple[int, float]:
    """How many copies of a track cover ``need_seconds``, overlapping by ``crossfade``."""
    if not track_seconds > 0:
        raise ValueError("music track has no duration")
    if track_seconds >= need_seconds:
        return 1, 0.0
    if track_seconds <= crossfade * 2:
        raise ValueError(f"music track is too short to loop ({num(track_seconds)} s)")
    copies = 1 + math.ceil((need_seconds - track_seconds) / (track_seconds - crossfade))
    return copies, crossfade


# --- timeline ---------------------------------------------------------------------


@dataclass
class Line:
    path: str
    duration: float
    lufs: float
    text: str = ""
    start: float | None = None     # seconds from the start of the take (before bookends)


@dataclass
class Bed:
    path: str | None            # None: the take's own audio track (input 0)
    duration: float
    lufs: float
    offset: float = 0.0         # seconds into the source
    role: str = "music"         # music | original


@dataclass
class Logo:
    path: str                   # rendered full-frame card PNG
    start: bool
    end: bool
    seconds: float = 2.0


@dataclass
class MixSpec:
    video_path: str
    video_duration: float
    width: int
    height: int
    fps: float
    lines: list[Line] = field(default_factory=list)
    music: Bed | None = None
    original: Bed | None = None
    levels: str = "balanced"
    fade_in: float = 0.5
    fade_out: float = 1.5
    video_fades: bool = False
    fit: str = "audio"          # audio: hold the last frame until narration ends; video: cut at the take's end
    captions: list[tuple[str, float, float, str]] = field(default_factory=list)  # (text, start, end, png path)
    logo: Logo | None = None


@dataclass
class Timeline:
    main_offset: float          # where the take starts in the output (after the start card)
    main_seconds: float         # the take, extended by held frames if needed
    hold_seconds: float         # held last frame added to the take
    total: float
    line_starts: list[float]    # absolute start of each narration line in the output


def place_lines(lines: list[Line]) -> list[float]:
    """Start of each line relative to the take: explicit, or sequential with a lead and gaps."""
    starts: list[float] = []
    cursor = NARRATION_LEAD
    for line in lines:
        start = line.start if line.start is not None else cursor
        starts.append(max(0.0, float(start)))
        cursor = starts[-1] + line.duration + NARRATION_GAP
    return starts


def timeline(spec: MixSpec) -> Timeline:
    relative = place_lines(spec.lines)
    voice_end = max((start + line.duration for start, line in zip(relative, spec.lines)), default=0.0)
    main = spec.video_duration
    if spec.fit == "audio" and spec.lines:
        main = max(main, voice_end + NARRATION_TAIL)
    hold = max(0.0, main - spec.video_duration)
    start_card = spec.logo.seconds if spec.logo and spec.logo.start else 0.0
    end_card = spec.logo.seconds if spec.logo and spec.logo.end else 0.0
    offset = max(0.0, start_card - BOOKEND_XFADE) if start_card else 0.0
    total = offset + main + (max(0.0, end_card - BOOKEND_XFADE) if end_card else 0.0)
    return Timeline(main_offset=offset, main_seconds=main, hold_seconds=hold, total=total,
                    line_starts=[offset + start for start in relative])


def caption_cues(lines: list[Line], starts: list[float], max_chars: int = 84) -> list[tuple[str, float, float]]:
    """Captions for the narration: each line split at sentence/clause breaks into chunks of
    at most ``max_chars``, timed in proportion to their length across the line."""
    cues: list[tuple[str, float, float]] = []
    for line, start in zip(lines, starts):
        text = " ".join((line.text or "").split())
        if not text:
            continue
        chunks = split_caption(text, max_chars)
        total_chars = sum(len(chunk) for chunk in chunks) or 1
        at = start
        for chunk in chunks:
            length = line.duration * len(chunk) / total_chars
            cues.append((chunk, round(at, 3), round(at + length + (0.25 if chunk is chunks[-1] else 0.0), 3)))
            at += length
    return cues


def caption_chars(width: int, height: int) -> int:
    """Chunk length that fits two caption lines for the frame's shape."""
    ratio = width / max(1, height)
    return 84 if ratio >= 1.3 else 64 if ratio >= 0.9 else 46


def split_caption(text: str, max_chars: int) -> list[str]:
    if len(text) <= max_chars:
        return [text]
    pieces = [p for p in re.split(r"(?<=[.!?;:])\s+|(?<=,)\s+", text) if p]
    chunks: list[str] = []
    current = ""
    for piece in pieces:
        candidate = f"{current} {piece}".strip()
        if len(candidate) <= max_chars:
            current = candidate
            continue
        if current:
            chunks.append(current)
        while len(piece) > max_chars:  # one long clause: break at the last space that fits
            cut = piece.rfind(" ", 0, max_chars)
            cut = cut if cut > 0 else max_chars
            chunks.append(piece[:cut].strip())
            piece = piece[cut:].strip()
        current = piece
    if current:
        chunks.append(current)
    return chunks


# --- the graph ----------------------------------------------------------------------


@dataclass
class Graph:
    inputs: list[list[str]]     # ffmpeg input args, in order (input 0 is the take)
    filter: str
    video_map: str              # "[vout]" or "0:v" (stream copy)
    audio_map: str              # "[aout]"
    copy_video: bool
    timeline: Timeline
    levels: dict[str, Any]


def needs_video_encode(spec: MixSpec, tl: Timeline) -> bool:
    return bool(spec.captions or spec.logo or spec.video_fades or tl.hold_seconds > 0.01)


def build_graph(spec: MixSpec) -> Graph:
    """The whole ffmpeg graph for one finish (pure: measurements come in on the spec)."""
    if spec.levels not in LEVELS:
        raise ValueError(f"unknown levels preset {spec.levels!r}")
    preset = LEVELS[spec.levels]
    tl = timeline(spec)
    inputs: list[list[str]] = [["-i", spec.video_path]]
    parts: list[str] = []

    def add_input(*args: str) -> int:
        inputs.append(list(args))
        return len(inputs) - 1

    total = tl.total
    voice_labels: list[str] = []
    applied: dict[str, Any] = {"preset": spec.levels, "bedDb": preset.bed_db, "voiceLufs": VOICE_LUFS,
                               "truePeak": VOICE_TP, "duck": preset.duck.__dict__, "lines": []}

    # Voice: each line gained to -16 LUFS from its measurement, mono -> centred stereo, placed.
    for i, (line, start) in enumerate(zip(spec.lines, tl.line_starts)):
        k = add_input("-i", line.path)
        gain = gain_to(VOICE_LUFS, line.lufs)
        ms = int(round(start * 1000))
        parts.append(
            f"[{k}:a]aformat=sample_fmts=fltp:channel_layouts=mono,aresample={SAMPLE_RATE},"
            f"volume={num(gain)}dB,aformat=channel_layouts=stereo,adelay={ms}|{ms}[v{i}]")
        voice_labels.append(f"[v{i}]")
        applied["lines"].append({"start": round(start, 3), "duration": round(line.duration, 3),
                                 "gainDb": round(gain, 2)})
    has_voice = bool(voice_labels)
    # The bed's resting level: under the voice, or the programme itself.
    bed_target = PROGRAMME_LUFS + preset.bed_db if has_voice else PROGRAMME_LUFS

    bed_labels: list[str] = []
    if spec.music is not None:
        m = spec.music
        k = add_input("-i", m.path) if m.path else 0
        need = total + 0.5
        available = max(0.0, m.duration - m.offset)
        copies, crossfade = loop_plan(available, need)
        src = f"[{k}:a]atrim=start={num(m.offset)},asetpts=PTS-STARTPTS," \
              f"aformat=sample_fmts=fltp:sample_rates={SAMPLE_RATE}:channel_layouts=stereo"
        if copies == 1:
            parts.append(f"{src}[m0]")
            current = "[m0]"
        else:
            labels = [f"[m{i}]" for i in range(copies)]
            parts.append(f"{src},asplit={copies}{''.join(labels)}")
            current = labels[0]
            for i in range(1, copies):
                parts.append(f"{current}{labels[i]}acrossfade=d={num(crossfade)}:c1=qsin:c2=qsin[mx{i}]")
                current = f"[mx{i}]"
        # Music under the original audio when that is the programme (no narration).
        target = bed_target if (has_voice or spec.original is None) else PROGRAMME_LUFS + preset.bed_db
        gain = gain_to(target, m.lufs)
        fade_out_at = max(0.0, total - spec.fade_out)
        parts.append(
            f"{current}atrim=end={num(total)},asetpts=PTS-STARTPTS,volume={num(gain)}dB,"
            f"afade=t=in:st=0:d={num(max(0.01, spec.fade_in))}:curve=tri,"
            f"afade=t=out:st={num(fade_out_at)}:d={num(max(0.01, min(spec.fade_out, total)))}:curve=qsin[bedm]")
        bed_labels.append("[bedm]")
        applied["music"] = {"gainDb": round(gain, 2), "targetLufs": round(target, 2), "loops": copies,
                            "offset": m.offset, "measuredLufs": m.lufs}
    if spec.original is not None:
        o = spec.original
        k = add_input("-i", o.path) if o.path else 0
        gain = gain_to(bed_target, o.lufs)
        ms = int(round(tl.main_offset * 1000))
        end = min(o.duration, spec.video_duration)
        parts.append(
            f"[{k}:a]atrim=end={num(end)},asetpts=PTS-STARTPTS,"
            f"aformat=sample_fmts=fltp:sample_rates={SAMPLE_RATE}:channel_layouts=stereo,volume={num(gain)}dB,"
            f"afade=t=out:st={num(max(0.0, end - 0.3))}:d=0.3,adelay={ms}|{ms}[bedo]")
        bed_labels.append("[bedo]")
        applied["original"] = {"gainDb": round(gain, 2), "targetLufs": round(bed_target, 2), "measuredLufs": o.lufs}

    final_inputs: list[str] = []
    if has_voice:
        # A copy of the voice keys the bed's compressor (only when there is a bed).
        tail = ",asplit=2[vox][key]" if bed_labels else "[vox]"
        if len(voice_labels) == 1:
            parts.append(f"{voice_labels[0]}apad,atrim=end={num(total)}{tail}")
        else:
            parts.append(f"{''.join(voice_labels)}amix=inputs={len(voice_labels)}:duration=longest:normalize=0,"
                         f"apad,atrim=end={num(total)}{tail}")
        final_inputs.append("[vox]")
    if bed_labels:
        if len(bed_labels) == 1:
            parts.append(f"{bed_labels[0]}apad,atrim=end={num(total)}[bed]")
        else:
            parts.append(f"{''.join(bed_labels)}amix=inputs={len(bed_labels)}:duration=longest:normalize=0,"
                         f"apad,atrim=end={num(total)}[bed]")
        if has_voice:
            d = preset.duck
            parts.append(
                f"[bed][key]sidechaincompress=threshold={num(d.threshold)}:ratio={num(d.ratio)}:"
                f"attack={num(d.attack)}:release={num(d.release)}:makeup=1:detection=rms:link=average[ducked]")
            final_inputs.append("[ducked]")
        else:
            final_inputs.append("[bed]")
    if not final_inputs:
        # Nothing to mix: a silent track keeps players and social uploads happy.
        parts.append(f"anullsrc=r={SAMPLE_RATE}:cl=stereo,atrim=end={num(total)}[silence]")
        final_inputs.append("[silence]")
    head = "".join(final_inputs)
    mix = f"{head}amix=inputs={len(final_inputs)}:duration=longest:normalize=0," if len(final_inputs) > 1 else f"{head}"
    parts.append(
        f"{mix}{'' if len(final_inputs) > 1 else 'anull,'}"
        f"afade=t=in:st=0:d={num(max(0.01, spec.fade_in))},"
        f"afade=t=out:st={num(max(0.0, total - spec.fade_out))}:d={num(max(0.01, min(spec.fade_out, total)))},"
        f"alimiter=limit={num(db_to_linear(VOICE_TP))}:attack=5:release=50:level=0,"
        f"atrim=end={num(total)}[aout]")

    copy_video = not needs_video_encode(spec, tl)
    video_map = "0:v"
    if not copy_video:
        norm = f"fps={num(spec.fps)},scale={spec.width}:{spec.height}:flags=lanczos,setsar=1,format=yuv420p"
        chain = f"[0:v]{norm}"
        if tl.hold_seconds > 0.01:
            chain += f",tpad=stop_mode=clone:stop_duration={num(tl.hold_seconds)}"
        parts.append(f"{chain}[main0]")
        current = "[main0]"
        for j, (_text, start, end, png) in enumerate(spec.captions):
            k = add_input("-i", png)
            # Cue times are absolute; the take starts at main_offset in the output.
            a, b = start - tl.main_offset, end - tl.main_offset
            parts.append(f"{current}[{k}:v]overlay=0:0:enable='between(t,{num(a)},{num(b)})'[cap{j}]")
            current = f"[cap{j}]"
        if spec.logo is not None:
            current = _bookends(spec, tl, current, parts, add_input, norm)
        fades = ""
        if spec.video_fades:
            fades = (f",fade=t=in:st=0:d={num(max(0.01, spec.fade_in))},"
                     f"fade=t=out:st={num(max(0.0, total - spec.fade_out))}:d={num(max(0.01, spec.fade_out))}")
        parts.append(f"{current}trim=end={num(total)},setpts=PTS-STARTPTS{fades},format=yuv420p[vout]")
        video_map = "[vout]"
    return Graph(inputs=inputs, filter=";".join(parts), video_map=video_map, audio_map="[aout]",
                 copy_video=copy_video, timeline=tl, levels=applied)


def _bookends(spec: MixSpec, tl: Timeline, current: str, parts: list[str], add_input, norm: str) -> str:
    logo = spec.logo
    assert logo is not None
    seconds = logo.seconds
    if logo.start:
        k = add_input("-loop", "1", "-t", num(seconds), "-i", logo.path)
        parts.append(f"[{k}:v]{norm},fade=t=in:st=0:d=0.4[card0]")
        parts.append(f"[card0]{current}xfade=transition=fade:duration={num(BOOKEND_XFADE)}:"
                     f"offset={num(seconds - BOOKEND_XFADE)}[book0]")
        current = "[book0]"
    if logo.end:
        k = add_input("-loop", "1", "-t", num(seconds), "-i", logo.path)
        parts.append(f"[{k}:v]{norm},fade=t=out:st={num(seconds - 0.5)}:d=0.5[card1]")
        offset = tl.main_offset + tl.main_seconds - BOOKEND_XFADE
        parts.append(f"{current}[card1]xfade=transition=fade:duration={num(BOOKEND_XFADE)}:"
                     f"offset={num(offset)}[book1]")
        current = "[book1]"
    return current


def ffmpeg_command(graph: Graph, script_path: str, output: str, *, fps: float, crf: str = "17") -> list[str]:
    command = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
    for args in graph.inputs:
        command += args
    command += ["-filter_complex_script", script_path, "-map", graph.video_map, "-map", graph.audio_map]
    if graph.copy_video:
        command += ["-c:v", "copy"]
    else:
        command += ["-c:v", "libx264", "-preset", "medium", "-crf", crf, "-profile:v", "high",
                    "-pix_fmt", "yuv420p", "-r", num(fps)]
    command += ["-c:a", "aac", "-b:a", "192k", "-ar", str(SAMPLE_RATE), "-ac", "2",
                "-t", num(graph.timeline.total), "-movflags", "+faststart", output]
    return command


# --- music mastering (after ACE-Step) -------------------------------------------------


def loop_seam_filter(duration: float, crossfade: float) -> str:
    """Make a seamless loop: the first ``crossfade`` seconds are crossfaded with the
    ``crossfade`` seconds rendered past the end, so the end flows into the start."""
    return (f"[0:a]aformat=sample_fmts=fltp:sample_rates={SAMPLE_RATE}:channel_layouts=stereo,asplit=2[a][b];"
            f"[a]atrim=end={num(duration)},asetpts=PTS-STARTPTS,"
            f"afade=t=in:st=0:d={num(crossfade)}:curve=qsin[head];"
            f"[b]atrim=start={num(duration)}:end={num(duration + crossfade)},asetpts=PTS-STARTPTS,"
            f"afade=t=out:st=0:d={num(crossfade)}:curve=qsin[tail];"
            f"[head][tail]amix=inputs=2:duration=first:normalize=0[out]")


def trim_filter(duration: float) -> str:
    """A plain take: cut to length with click-free edges (the model writes its own ending)."""
    return (f"[0:a]aformat=sample_fmts=fltp:sample_rates={SAMPLE_RATE}:channel_layouts=stereo,"
            f"atrim=end={num(duration)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.01,"
            f"afade=t=out:st={num(max(0.0, duration - 0.3))}:d=0.3[out]")


def loudnorm_second_pass(measured: dict[str, float], target: float = PROGRAMME_LUFS, tp: float = VOICE_TP) -> str:
    """Linear (two-pass) loudnorm settings from a first-pass measurement."""
    return (f"loudnorm=I={num(target)}:TP={num(tp)}:LRA=11:measured_I={num(measured['lufs'])}:"
            f"measured_TP={num(measured['truePeak'])}:measured_LRA={num(measured['lra'])}:"
            f"measured_thresh={num(measured['threshold'])}:offset={num(measured.get('offset', 0.0))}:"
            f"linear=true:print_format=summary")


def run(command: list[str], timeout: int = 900) -> subprocess.CompletedProcess:
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.strip()[-500:]}")
    return result


def measure(path: str, *, stream: str = "0:a:0", start: float = 0.0, duration: float | None = None) -> dict[str, float]:
    """EBU R128 measurement (loudnorm first pass): lufs, truePeak, lra, threshold, offset.

    ``start``/``duration`` measure only the window that will actually play (a bed
    taken from the middle of a track can sit far from the track's average)."""
    window = (["-ss", num(start)] if start > 0 else []) + (["-t", num(duration)] if duration else [])
    result = subprocess.run([
        "ffmpeg", "-nostdin", "-hide_banner", "-nostats", *window, "-i", path, "-map", stream, "-vn",
        "-af", f"loudnorm=I={num(PROGRAMME_LUFS)}:TP={num(VOICE_TP)}:LRA=11:print_format=json", "-f", "null", "-",
    ], capture_output=True, text=True, timeout=600, check=False)
    return parse_loudnorm(result.stderr, result.returncode)


def parse_loudnorm(stderr: str, returncode: int = 0) -> dict[str, float]:
    at = stderr.rfind("{")
    end = stderr.find("}", at)
    if returncode != 0 or at < 0 or end < 0:
        raise RuntimeError(f"could not measure loudness: {stderr.strip()[-300:]}")
    raw = json.loads(stderr[at:end + 1])

    def value(key: str, default: float) -> float:
        try:
            parsed = float(raw.get(key))
        except (TypeError, ValueError):
            return default
        return default if math.isinf(parsed) or math.isnan(parsed) else parsed

    return {"lufs": value("input_i", -70.0), "truePeak": value("input_tp", -70.0), "lra": value("input_lra", 0.0),
            "threshold": value("input_thresh", -80.0), "offset": value("target_offset", 0.0)}


def probe_media(path: str) -> dict[str, Any]:
    """Duration plus the first video and audio streams (None when absent)."""
    result = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries",
        "stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels:format=duration,format_name",
        "-of", "json", path,
    ], capture_output=True, text=True, timeout=60, check=False)
    if result.returncode != 0:
        return {}
    data = json.loads(result.stdout or "{}")
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video" and s.get("width")), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = data.get("format") or {}
    try:
        duration = float(fmt.get("duration") or 0)
    except ValueError:
        duration = 0.0
    fps = None
    if video and video.get("r_frame_rate") and "/" in video["r_frame_rate"]:
        n, d = video["r_frame_rate"].split("/")
        fps = round(float(n) / float(d), 3) if float(d) else None
    return {
        "duration": round(duration, 3), "format": fmt.get("format_name", ""),
        "video": None if video is None else {"width": video.get("width"), "height": video.get("height"),
                                              "fps": fps, "codec": video.get("codec_name")},
        "audio": None if audio is None else {"codec": audio.get("codec_name"),
                                              "sampleRate": int(audio.get("sample_rate") or 0),
                                              "channels": int(audio.get("channels") or 0)},
    }


def waveform_command(source: str, output: str, *, width: int = 640, height: int = 160) -> list[str]:
    return ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-filter_complex",
            f"[0:a]aformat=channel_layouts=mono,showwavespic=s={width}x{height}:colors=0x9aa4b2[w];"
            f"color=c=0x111827:s={width}x{height}[bg];[bg][w]overlay=format=auto,format=yuvj420p",
            "-frames:v", "1", "-q:v", "3", output]


def master_music(raw: str, work: str, *, duration: float, loopable: bool,
                 crossfade: float = LOOP_CROSSFADE) -> dict[str, Any]:
    """ACE-Step output -> delivery files: WAV 48 kHz s16 stereo at -16 LUFS / -1.5 dBTP,
    MP3 (LAME V0) and a waveform JPEG. Returns paths and the measured result."""
    shaped = os.path.join(work, "shaped.wav")
    graph = loop_seam_filter(duration, crossfade) if loopable else trim_filter(duration)
    run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", raw,
         "-filter_complex", graph, "-map", "[out]", "-c:a", "pcm_f32le", shaped])
    return master_wav(shaped, work)


def master_wav(source: str, work: str, *, normalise: bool = True) -> dict[str, Any]:
    """Any audio -> delivery WAV (+ MP3 + waveform), optionally loudness-normalised."""
    wav = os.path.join(work, "master.wav")
    mp3 = os.path.join(work, "master.mp3")
    wave = os.path.join(work, "wave.jpg")
    first = measure(source)
    chain = [f"aresample={SAMPLE_RATE}", "aformat=sample_fmts=fltp:channel_layouts=stereo"]
    if normalise and first["lufs"] > SILENT_LUFS:
        chain.append(loudnorm_second_pass(first))
        chain.append(f"aresample={SAMPLE_RATE}")
    run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-vn",
         "-af", ",".join(chain), "-ar", str(SAMPLE_RATE), "-ac", "2", "-c:a", "pcm_s16le", wav])
    run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", wav,
         "-c:a", "libmp3lame", "-q:a", "0", "-id3v2_version", "3", mp3])
    run(waveform_command(wav, wave))
    final = measure(wav)
    probe = probe_media(wav)
    return {"wav": wav, "mp3": mp3, "waveform": wave, "lufs": round(final["lufs"], 2),
            "truePeak": round(final["truePeak"], 2), "durationSeconds": probe.get("duration"),
            "sampleRate": SAMPLE_RATE, "channels": 2}


# --- captions and logo cards (Pillow) ---------------------------------------------------

FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
)


def caption_font(size: int):
    from PIL import ImageFont

    for candidate in FONT_CANDIDATES:
        if os.path.exists(candidate):
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default(size=size)


def wrap_text(text: str, font, max_width: int, draw) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if draw.textlength(candidate, font=font) <= max_width or not current:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def caption_png(text: str, path: str, width: int, height: int) -> None:
    """A full-frame transparent PNG with the caption in a dark rounded box near the bottom."""
    from PIL import Image, ImageDraw

    # Sized from the short side so portrait captions do not swamp the frame.
    size = max(16, round(min(width, height) * 0.048))
    font = caption_font(size)
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    lines = wrap_text(text, font, int(width * 0.84), draw)[:3]
    line_height = round(size * 1.3)
    pad_x, pad_y = round(size * 0.6), round(size * 0.35)
    text_width = max(draw.textlength(line, font=font) for line in lines)
    box_w, box_h = int(text_width) + 2 * pad_x, line_height * len(lines) + 2 * pad_y
    x0 = (width - box_w) // 2
    y0 = height - round(height * 0.07) - box_h
    draw.rounded_rectangle((x0, y0, x0 + box_w, y0 + box_h), radius=round(size * 0.3), fill=(17, 22, 32, 222))
    for i, line in enumerate(lines):
        line_w = draw.textlength(line, font=font)
        draw.text(((width - line_w) / 2, y0 + pad_y + i * line_height), line, font=font, fill=(255, 255, 255, 255))
    image.save(path)


def logo_card(logo_path: str, path: str, width: int, height: int, background: str = "#000000") -> None:
    """The real logo, untouched, centred on a solid card (at most 50% wide, 40% tall)."""
    from PIL import Image

    color = parse_hex_color(background)
    card = Image.new("RGB", (width, height), color)
    with Image.open(logo_path) as source:
        logo = source.convert("RGBA")
        scale = min(width * 0.5 / logo.width, height * 0.4 / logo.height, 1.0 if logo.width > width * 0.25 else 4.0)
        size = (max(1, round(logo.width * scale)), max(1, round(logo.height * scale)))
        logo = logo.resize(size, Image.LANCZOS)
        card.paste(logo, ((width - size[0]) // 2, (height - size[1]) // 2), logo)
    card.save(path)


def parse_hex_color(value: str) -> tuple[int, int, int]:
    match = re.fullmatch(r"#?([0-9a-fA-F]{6})", (value or "").strip())
    if not match:
        raise ValueError("logo background must be a #RRGGBB colour")
    raw = match.group(1)
    return int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16)


def summarise(values: Iterable[float]) -> float:
    values = list(values)
    return round(sum(values) / len(values), 2) if values else 0.0
