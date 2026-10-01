"""Night window, manual sessions and nightly capacity. Pure functions of (now, settings).

The window is local wall-clock time in the configured zone (default
22:00-07:00 America/Chicago, every night). An end at or before the start means
the window runs past midnight; the night belongs to the weekday it starts on
(0 = Monday). Daylight-saving changes are handled by zoneinfo: a 22:00-07:00
night is 8 or 10 hours long on the change nights.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DEFAULT_SETTINGS: dict = {
    "windowStart": "22:00",
    "windowEnd": "07:00",
    "days": [0, 1, 2, 3, 4, 5, 6],
    "timezone": "America/Chicago",
    "budgetMinutes": 480,
    "graceMinutes": 10,
    "paused": False,
    "pausedReason": None,
    "defaultTakes": 2,
}

# A claim plus the first model load; subtracted from a night's usable time.
CLAIM_OVERHEAD_SECONDS = 150


@dataclass(frozen=True)
class Window:
    start: datetime  # UTC
    end: datetime    # UTC
    open: bool
    kind: str = "night"  # night | session
    local_date: str = ""  # the local date the night starts on

    @property
    def night_id(self) -> str:
        """One budget/record per night (or per manual session)."""
        return self.start.strftime("session-%Y%m%dT%H%M") if self.kind == "session" else self.local_date

    def remaining(self, now: datetime) -> float:
        return max(0.0, (self.end - now).total_seconds())

    def length(self) -> float:
        return (self.end - self.start).total_seconds()


def parse_hhmm(value: str) -> time:
    try:
        hours, minutes = value.strip().split(":")
        parsed = time(int(hours), int(minutes))
    except (ValueError, AttributeError) as exc:
        raise ValueError(f"expected HH:MM, got {value!r}") from exc
    return parsed


def zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError(f"unknown time zone {name!r}") from exc


def validate(settings: dict) -> dict:
    """Normalised copy of the scheduling settings; raises ValueError on bad input."""
    merged = {**DEFAULT_SETTINGS, **{k: v for k, v in settings.items() if v is not None or k == "pausedReason"}}
    start, end = parse_hhmm(merged["windowStart"]), parse_hhmm(merged["windowEnd"])
    if start == end:
        raise ValueError("the window must not start and end at the same time")
    zone(merged["timezone"])
    days = sorted({int(day) for day in merged["days"]})
    if any(day < 0 or day > 6 for day in days):
        raise ValueError("days are 0 (Monday) to 6 (Sunday)")
    merged["days"] = days
    merged["windowStart"], merged["windowEnd"] = start.strftime("%H:%M"), end.strftime("%H:%M")
    merged["budgetMinutes"] = int(merged["budgetMinutes"])
    if not 10 <= merged["budgetMinutes"] <= 24 * 60:
        raise ValueError("budgetMinutes must be between 10 and 1440")
    merged["graceMinutes"] = int(merged["graceMinutes"])
    if not 0 <= merged["graceMinutes"] <= 60:
        raise ValueError("graceMinutes must be between 0 and 60")
    merged["defaultTakes"] = int(merged["defaultTakes"])
    if not 1 <= merged["defaultTakes"] <= 4:
        raise ValueError("defaultTakes must be between 1 and 4")
    merged["paused"] = bool(merged["paused"])
    return merged


def _window(day: date, start: time, end: time, tz: ZoneInfo, now: datetime) -> Window:
    local_start = datetime.combine(day, start, tz)
    end_day = day + timedelta(days=1) if end <= start else day
    local_end = datetime.combine(end_day, end, tz)
    s, e = local_start.astimezone(UTC), local_end.astimezone(UTC)
    return Window(start=s, end=e, open=s <= now < e, local_date=day.isoformat())


def window_at(now: datetime, settings: dict) -> Window:
    """The night window containing ``now``, else the next one (open=False)."""
    settings = {**DEFAULT_SETTINGS, **settings}
    tz = zone(settings["timezone"])
    start, end = parse_hhmm(settings["windowStart"]), parse_hhmm(settings["windowEnd"])
    days = set(settings["days"])
    today = now.astimezone(tz).date()
    upcoming: Window | None = None
    for offset in range(-1, 9):
        day = today + timedelta(days=offset)
        if day.weekday() not in days:
            continue
        candidate = _window(day, start, end, tz, now)
        if candidate.open:
            return candidate
        if candidate.start > now and (upcoming is None or candidate.start < upcoming.start):
            upcoming = candidate
    if upcoming is None:  # no days enabled: report a far-future, closed window
        far = now + timedelta(days=3650)
        return Window(start=far, end=far, open=False, local_date=far.date().isoformat())
    return upcoming


def session_window(now: datetime, session: dict | None) -> Window | None:
    """A manual "run now" session, while it lasts."""
    if not session or not session.get("until"):
        return None
    until = datetime.fromisoformat(session["until"])
    started = datetime.fromisoformat(session.get("startedAt") or session["until"])
    if until <= now:
        return None
    return Window(start=min(started, now), end=until, open=True, kind="session")


def active_window(now: datetime, settings: dict) -> Window | None:
    """What allows dispatch right now: a manual session, else an open night window."""
    session = session_window(now, settings.get("session"))
    if session:
        return session
    window = window_at(now, settings)
    return window if window.open else None


def nightly_capacity_seconds(now: datetime, settings: dict) -> float:
    """GPU seconds one night can deliver: the window minus claim overhead, capped by the budget."""
    window = window_at(now, settings)
    length = max(0.0, window.length() - CLAIM_OVERHEAD_SECONDS)
    return min(length, float(settings.get("budgetMinutes", 480)) * 60)


def nights_for(seconds: float, capacity: float) -> float:
    if seconds <= 0:
        return 0.0
    if capacity <= 0:
        return float("inf")
    return round(seconds / capacity, 2)
