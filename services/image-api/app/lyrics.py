"""Song lyrics: sung lines, a length estimate from the lyrics, and timing.

ACE-Step takes lyrics with [Section] tags. Timing comes afterwards: stt-api (whisper)
transcribes the finished take with word timestamps, biased with the lyrics as its
prompt, and ``align`` maps those words back onto the known sung lines with a
monotonic sequence alignment, so misheard, dropped and extra words only cost a few
points instead of shifting every line after them. Lines with no matched words are
interpolated between their neighbours. The result is a list of
{"t", "end", "text"} lines and an LRC file.
"""
from __future__ import annotations

import difflib
import math
import re
from typing import Any, Iterable

SECTION = re.compile(r"^\s*\[[^\]]*\]\s*$")
TOKEN = re.compile(r"[a-z0-9]+")
# Sections that add bars without sung lines (count toward the length estimate).
INSTRUMENTAL_SECTIONS = {"intro": 8, "outro": 8, "guitar solo": 16, "solo": 16, "instrumental": 16,
                         "interlude": 8, "break": 8, "breakdown": 8}
BARS_PER_LINE = 2
SONG_MIN_SECONDS = 60.0
SONG_HEADROOM = 1.10
MIN_MATCH_RATIO = 0.15      # below this share of matched tokens the timing is not trusted
FUZZY_MATCH = 0.72          # difflib ratio at which a heard word counts as the lyric word


def sections(text: str) -> list[str]:
    return [line.strip()[1:-1].strip().lower() for line in (text or "").splitlines() if SECTION.match(line)]


def sung_lines(text: str) -> list[str]:
    """The lines that are sung: no [Section] tags, no blank lines."""
    return [" ".join(line.split()) for line in (text or "").splitlines()
            if line.strip() and not SECTION.match(line)]


def ensure_outro(text: str) -> str:
    """Lyrics that end with an [Outro] section, so the model writes an ending."""
    text = (text or "").rstrip()
    if any(name.startswith("outro") for name in sections(text)):
        return text
    return f"{text}\n\n[Outro]"


def estimate_song_seconds(text: str, bpm: int, time_signature: str = "4", *, max_seconds: float) -> float:
    """Seconds a song needs for its lyrics: about two bars per sung line plus the
    instrumental sections, +10 % headroom, clamped to [60, max_seconds], rounded up."""
    beats_per_bar = int(time_signature) if time_signature in ("2", "3", "4", "6") else 4
    bars = BARS_PER_LINE * len(sung_lines(text))
    for name in sections(text):
        for key, extra in INSTRUMENTAL_SECTIONS.items():
            if name.startswith(key):
                bars += extra
                break
    if not any(name.startswith("intro") for name in sections(text)):
        bars += 4
    seconds = bars * beats_per_bar * 60.0 / max(40, bpm) * SONG_HEADROOM
    return float(min(max_seconds, max(SONG_MIN_SECONDS, math.ceil(seconds))))


def tokens(text: str) -> list[str]:
    return TOKEN.findall((text or "").lower().replace("'", "").replace("’", ""))


def _similar(a: str, b: str) -> bool:
    return a == b or (len(a) > 2 and len(b) > 2 and difflib.SequenceMatcher(None, a, b).ratio() >= FUZZY_MATCH)


def align(lines: list[str], words: Iterable[dict[str, Any]], *, min_ratio: float = MIN_MATCH_RATIO
          ) -> list[dict[str, Any]] | None:
    """Time each sung line from whisper's words ({"word", "start", "end"}).

    Monotonic alignment (dynamic programming, match +2, mismatch/gap -1) of the
    lyric tokens against the heard tokens; a line's time is the first and last of
    its matched words. Unmatched lines are interpolated between neighbours,
    proportionally to their token counts. Returns None when too little matched to
    trust (e.g. an instrumental take or a failed transcription)."""
    lyric: list[tuple[str, int]] = [(tok, index) for index, line in enumerate(lines) for tok in tokens(line)]
    heard: list[tuple[str, float, float]] = []
    for word in words:
        for tok in tokens(str(word.get("word", ""))):
            heard.append((tok, float(word.get("start", 0.0)), float(word.get("end", word.get("start", 0.0)))))
    if not lyric or not heard:
        return None
    n, m = len(lyric), len(heard)
    # score[i][j]: best score aligning lyric[:i] with heard[:j]
    score = [[0] * (m + 1) for _ in range(n + 1)]
    move = [[0] * (m + 1) for _ in range(n + 1)]   # 0 diag, 1 skip lyric, 2 skip heard
    for i in range(1, n + 1):
        score[i][0] = -i
        move[i][0] = 1
    for j in range(1, m + 1):
        score[0][j] = 0             # heard words before the first lyric (ad libs, intro talk) are free
        move[0][j] = 2
    for i in range(1, n + 1):
        lt = lyric[i - 1][0]
        row, prev = score[i], score[i - 1]
        for j in range(1, m + 1):
            diag = prev[j - 1] + (2 if _similar(lt, heard[j - 1][0]) else -1)
            up = prev[j] - 1
            left = row[j - 1] - (0 if i == n else 1)   # trailing heard words are free too
            best = max(diag, up, left)
            row[j] = best
            move[i][j] = 0 if best == diag else 1 if best == up else 2
    matched: dict[int, list[tuple[float, float]]] = {}
    hits = 0
    i, j = n, m
    while i > 0 and j > 0:
        step = move[i][j]
        if step == 0:
            if _similar(lyric[i - 1][0], heard[j - 1][0]):
                matched.setdefault(lyric[i - 1][1], []).append((heard[j - 1][1], heard[j - 1][2]))
                hits += 1
            i, j = i - 1, j - 1
        elif step == 1:
            i -= 1
        else:
            j -= 1
    if hits < max(2, math.ceil(min_ratio * n)):
        return None
    first_onset = heard[0][1]
    last_end = heard[-1][2]
    timed: list[dict[str, Any]] = []
    for index, line in enumerate(lines):
        spans = matched.get(index)
        if spans:
            timed.append({"t": min(s for s, _ in spans), "end": max(e for _, e in spans), "text": line})
        else:
            timed.append({"t": None, "end": None, "text": line})
    _interpolate(timed, [max(1, len(tokens(line))) for line in lines], first_onset, last_end)
    previous = 0.0
    for line in timed:
        line["t"] = round(max(line["t"], previous, first_onset if line is timed[0] else 0.0), 2)
        line["end"] = None if line["end"] is None else round(max(line["end"], line["t"]), 2)
        previous = line["t"]
    for current, nxt in zip(timed, timed[1:]):
        if current["end"] is not None and current["end"] > nxt["t"]:
            current["end"] = nxt["t"]
    return timed


def _interpolate(timed: list[dict[str, Any]], weights: list[int], first_onset: float, last_end: float) -> None:
    """Fill lines without matches between the nearest timed neighbours."""
    known = [index for index, line in enumerate(timed) if line["t"] is not None]
    if not known:
        return
    per_token = _seconds_per_token(timed, weights, known)
    index = 0
    while index < len(timed):
        if timed[index]["t"] is not None:
            index += 1
            continue
        start = index
        while index < len(timed) and timed[index]["t"] is None:
            index += 1
        gap = range(start, index)
        before = timed[start - 1] if start > 0 else None
        after = timed[index] if index < len(timed) else None
        total = sum(weights[k] for k in gap)
        if before and after:
            lo = before["end"] if before["end"] is not None else before["t"]
            hi = after["t"]
            if hi <= lo:
                hi = lo + per_token * total
        elif after:          # leading lines: back off from the first timed line, not before the vocals start
            hi = after["t"]
            lo = max(first_onset, hi - per_token * total)
        else:                # trailing lines
            lo = before["end"] if before["end"] is not None else before["t"]
            hi = max(lo + per_token * total, min(last_end, lo + per_token * total * 2))
        cursor = lo
        for k in gap:
            share = (hi - lo) * weights[k] / total
            timed[k]["t"], timed[k]["end"] = cursor, cursor + share
            cursor += share


def _seconds_per_token(timed: list[dict[str, Any]], weights: list[int], known: list[int]) -> float:
    spans = [(timed[k]["end"] - timed[k]["t"]) / weights[k] for k in known
             if timed[k]["end"] is not None and timed[k]["end"] > timed[k]["t"]]
    if not spans:
        return 0.45
    spans.sort()
    return min(1.5, max(0.15, spans[len(spans) // 2]))


def to_lrc(lines: list[dict[str, Any]], *, title: str | None = None, artist: str | None = None) -> str:
    """Standard LRC: optional [ti:]/[ar:] tags, then [mm:ss.xx]line."""
    out = []
    if title:
        out.append(f"[ti:{title}]")
    if artist:
        out.append(f"[ar:{artist}]")
    for line in lines:
        t = max(0.0, float(line["t"]))
        minutes, seconds = divmod(t, 60)
        out.append(f"[{int(minutes):02d}:{seconds:05.2f}]{line['text']}")
    return "\n".join(out) + "\n"


def words_from_transcript(body: dict[str, Any]) -> list[dict[str, Any]]:
    """stt-api's {"segments": [{"words": [...]}]} -> a flat word list."""
    return [word for segment in body.get("segments") or [] for word in segment.get("words") or []]
