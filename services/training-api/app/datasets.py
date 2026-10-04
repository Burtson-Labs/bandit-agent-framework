"""Dataset versions: ingest an upload (manifest + examples.jsonl.gz + scrub report), index it,
compute stats, page through examples, record exclusions.

Storage layout (bucket ``training``):
  datasets/<id>/examples.jsonl.gz   the upload, byte for byte
  datasets/<id>/examples.jsonl      decompressed, so a page is a few range reads
  datasets/<id>/manifest.json, scrub-report.json
Mongo: ``datasets`` (one doc per version) and ``examples`` (one summary per example with its
byte offset, filters and the exclusion flag). Example text is only ever read back from storage.

Uploads are scrubbed on the collecting machine. The server re-checks every example for the
obvious secret shapes as a safety net: a hit excludes that example (flagged) instead of
silently training on it.
"""
from __future__ import annotations

import gzip
import io
import json
import re
import secrets
import tempfile
from collections import Counter
from datetime import UTC, datetime
from typing import Any, BinaryIO

from . import storage

ROLES = {"system", "user", "assistant", "tool"}
STATUSES = {"completed", "failed", "blocked", "cancelled", "unknown"}
TOKEN_BUCKETS = (1024, 2048, 4096, 8192, 16384, 32768)
MAX_LINE_BYTES = 4 * 1024 * 1024
PREVIEW_CHARS = 200

# Shapes that must never reach training data even if the collector missed them.
SECRET_PATTERNS: dict[str, re.Pattern] = {
    "jwt": re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
    "pem": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "github": re.compile(r"\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})"),
    "openai": re.compile(r"\bsk-(proj-)?[A-Za-z0-9_-]{32,}"),
    "burtson": re.compile(r"\bbai_[A-Za-z0-9]{20,}"),
    "slack": re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{20,}"),
    "aws": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "conn": re.compile(r"\b(mongodb(\+srv)?|postgres(ql)?|mysql|redis)://[^\s:@/]+:[^\s@/]+@"),
}


class DatasetError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def now() -> datetime:
    return datetime.now(UTC)


def new_dataset_id() -> str:
    return "ds_" + now().strftime("%Y%m%d%H%M%S") + "_" + secrets.token_hex(3)


def approx_tokens(example: dict) -> int:
    chars = 0
    for message in example.get("messages") or []:
        chars += len(str(message.get("content") or "")) + len(str(message.get("reasoning") or ""))
        for call in message.get("tool_calls") or []:
            fn = call.get("function") or {}
            chars += len(str(fn.get("name") or "")) + len(str(fn.get("arguments") or ""))
    chars += len(json.dumps(example.get("tools") or []))
    return max(1, chars // 4)


def secret_hits(raw: str) -> list[str]:
    return [name for name, pattern in SECRET_PATTERNS.items() if pattern.search(raw)]


def validate_example(example: Any) -> dict:
    """The canonical format (CONTRACT.md); raises ValueError with the reason."""
    if not isinstance(example, dict):
        raise ValueError("not an object")
    if not str(example.get("id") or "").strip():
        raise ValueError("missing id")
    scrub = example.get("scrub")
    if not isinstance(scrub, dict) or not scrub.get("version"):
        raise ValueError("not scrubbed (no scrub.version)")
    if scrub.get("dropped"):
        raise ValueError("marked dropped by the scrubber")
    messages = example.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ValueError("no messages")
    call_ids: set[str] = set()
    has_assistant = False
    for i, message in enumerate(messages):
        if not isinstance(message, dict) or message.get("role") not in ROLES:
            raise ValueError(f"message {i}: role must be one of {sorted(ROLES)}")
        role = message["role"]
        if role == "assistant":
            has_assistant = True
            for call in message.get("tool_calls") or []:
                fn = (call or {}).get("function") or {}
                if not fn.get("name"):
                    raise ValueError(f"message {i}: tool call without a function name")
                args = fn.get("arguments", "{}")
                if isinstance(args, str):
                    try:
                        json.loads(args or "{}")
                    except json.JSONDecodeError as exc:
                        raise ValueError(f"message {i}: tool call arguments are not JSON") from exc
                if call.get("id"):
                    call_ids.add(call["id"])
        if role == "tool" and message.get("tool_call_id") and message["tool_call_id"] not in call_ids:
            raise ValueError(f"message {i}: tool result for an unknown tool_call_id")
    if not has_assistant:
        raise ValueError("no assistant turn to learn from")
    tools = example.get("tools")
    if tools is not None and not isinstance(tools, list):
        raise ValueError("tools must be a list")
    return example


def summarize(example: dict, raw: str) -> dict:
    labels = example.get("labels") or {}
    messages = example["messages"]
    calls = [c for m in messages if m["role"] == "assistant" for c in (m.get("tool_calls") or [])]
    first_user = next((str(m.get("content") or "") for m in messages if m["role"] == "user"), "")
    status = example.get("status") if example.get("status") in STATUSES else "unknown"
    return {
        "source": str(example.get("source") or "unknown")[:40],
        "status": status,
        "model": (str(example["model"])[:80] if example.get("model") else None),
        "createdAt": example.get("createdAt"),
        "tokens": approx_tokens(example),
        "toolCalls": len(calls),
        "toolErrors": int(labels.get("toolErrors") or 0),
        "hitLimit": bool(labels.get("hitLimit")),
        "passed": labels.get("passed"),
        "tools": sorted({(c.get("function") or {}).get("name", "") for c in calls}),
        "messages": len(messages),
        "preview": " ".join(first_user.split())[:PREVIEW_CHARS],
    }


def bucket_of(tokens: int) -> str:
    for edge in TOKEN_BUCKETS:
        if tokens <= edge:
            return f"<={edge}"
    return f">{TOKEN_BUCKETS[-1]}"


def compute_stats(summaries: list[dict]) -> dict:
    included = [s for s in summaries if not s.get("excluded")]
    tools = Counter(t for s in included for t in s["tools"])
    return {
        "examples": len(summaries),
        "included": len(included),
        "excluded": len(summaries) - len(included),
        "flagged": sum(1 for s in summaries if s.get("flags")),
        "tokens": sum(s["tokens"] for s in included),
        "bySource": dict(Counter(s["source"] for s in included)),
        "byStatus": dict(Counter(s["status"] for s in included)),
        "byModel": dict(Counter(s["model"] or "unknown" for s in included)),
        "byTool": dict(tools.most_common(40)),
        "tokenHistogram": {b: n for b, n in Counter(bucket_of(s["tokens"]) for s in included).items()},
        "toolCalls": sum(s["toolCalls"] for s in included),
        "hitLimit": sum(1 for s in included if s["hitLimit"]),
    }


def ingest(store: storage.Store, db, *, owner: str, manifest_raw: bytes, examples_gz: BinaryIO,
           scrub_report_raw: bytes | None, max_bytes: int) -> dict:
    """Validate and store one upload; returns the dataset document."""
    try:
        manifest = json.loads(manifest_raw or b"{}")
        if not isinstance(manifest, dict):
            raise ValueError
    except ValueError as exc:
        raise DatasetError(400, "manifest.json is not a JSON object") from exc
    report = None
    if scrub_report_raw:
        try:
            report = json.loads(scrub_report_raw)
        except ValueError as exc:
            raise DatasetError(400, "scrub-report.json is not JSON") from exc

    dataset_id = new_dataset_id()
    base = f"{storage.DATASETS}/{dataset_id}"
    summaries: list[dict] = []
    seen: set[str] = set()
    errors: list[str] = []
    with tempfile.NamedTemporaryFile(prefix="ds-", suffix=".jsonl.gz") as gz_tmp, \
            tempfile.NamedTemporaryFile(prefix="ds-", suffix=".jsonl") as plain:
        size = 0
        while chunk := examples_gz.read(1024 * 1024):
            size += len(chunk)
            if size > max_bytes:
                raise DatasetError(413, f"examples.jsonl.gz is larger than {max_bytes // (1024 * 1024)} MiB")
            gz_tmp.write(chunk)
        gz_tmp.flush()
        offset = 0
        try:
            with gzip.open(gz_tmp.name, "rb") as lines:
                for number, line in enumerate(lines, start=1):
                    if not line.strip():
                        continue
                    if len(line) > MAX_LINE_BYTES:
                        errors.append(f"line {number}: longer than {MAX_LINE_BYTES} bytes")
                        continue
                    raw = line.decode("utf-8", errors="strict").rstrip("\n")
                    try:
                        example = validate_example(json.loads(raw))
                    except (ValueError, json.JSONDecodeError) as exc:
                        errors.append(f"line {number}: {exc}")
                        continue
                    ex_id = str(example["id"])[:120]
                    if ex_id in seen:
                        errors.append(f"line {number}: duplicate id {ex_id}")
                        continue
                    seen.add(ex_id)
                    body = (raw + "\n").encode()
                    plain.write(body)
                    summary = summarize(example, raw)
                    hits = secret_hits(raw)
                    summary.update({"_id": f"{dataset_id}:{ex_id}", "datasetId": dataset_id, "exId": ex_id,
                                    "offset": offset, "length": len(body) - 1,
                                    "excluded": bool(hits), "flags": hits,
                                    "note": f"server scrub check: {', '.join(hits)}" if hits else None})
                    offset += len(body)
                    summaries.append(summary)
        except (OSError, EOFError, UnicodeDecodeError) as exc:
            raise DatasetError(400, f"examples.jsonl.gz is not readable gzip/UTF-8 JSONL: {exc}") from exc
        if errors and len(errors) > max(5, len(summaries) // 10):
            raise DatasetError(400, f"{len(errors)} invalid examples (first: {errors[0]})")
        if not summaries:
            raise DatasetError(400, "no valid examples" + (f" (first error: {errors[0]})" if errors else ""))
        plain.flush()
        store.put_file(f"{base}/examples.jsonl.gz", gz_tmp.name, "application/gzip")
        store.put_file(f"{base}/examples.jsonl", plain.name, "application/x-ndjson")
    store.put_bytes(f"{base}/manifest.json", json.dumps(manifest, indent=2).encode(), "application/json")
    if report is not None:
        store.put_bytes(f"{base}/scrub-report.json", json.dumps(report, indent=2).encode(), "application/json")

    doc = {
        "_id": dataset_id,
        "name": str(manifest.get("name") or manifest.get("datasetId") or dataset_id)[:120],
        "sourceDatasetId": manifest.get("datasetId"),
        "owner": owner,
        "createdAt": now(),
        "manifest": manifest,
        "scrubVersion": manifest.get("scrubVersion") or (report or {}).get("version"),
        "scrubTotals": scrub_totals(report),
        "rejected": errors[:50],
        "rejectedCount": len(errors),
        "stats": compute_stats(summaries),
        "sizes": {"gz": size, "jsonl": offset},
    }
    if summaries:
        db.examples.insert_many(summaries, ordered=False)
    db.datasets.insert_one(doc)
    return doc


def scrub_totals(report: dict | None) -> dict | None:
    """Redaction counts by kind plus drops by reason. The collector (``bandit train collect``) writes
    ``redactions`` and ``dropCounts``; older/other clients may send ``totals``."""
    if not isinstance(report, dict):
        return None
    totals = report.get("totals")
    if isinstance(totals, dict):
        return totals
    redactions = report.get("redactions") if isinstance(report.get("redactions"), dict) else {}
    drops = report.get("dropCounts") if isinstance(report.get("dropCounts"), dict) else {}
    if not redactions and not drops:
        return None
    return {**{k: v for k, v in redactions.items() if isinstance(v, (int, float))},
            "dropped": sum(v for v in drops.values() if isinstance(v, (int, float))),
            "droppedByReason": drops}


def public_dataset(doc: dict) -> dict:
    out = {k: v for k, v in doc.items() if k != "_id"}
    out["id"] = doc["_id"]
    if isinstance(out.get("createdAt"), datetime):
        out["createdAt"] = out["createdAt"].astimezone(UTC).isoformat()
    return out


def refresh_stats(db, dataset_id: str) -> dict:
    summaries = list(db.examples.find({"datasetId": dataset_id}, {"_id": 0}))
    stats = compute_stats(summaries)
    db.datasets.update_one({"_id": dataset_id}, {"$set": {"stats": stats}})
    return stats


def example_query(dataset_id: str, *, source: str | None, status: str | None, q: str | None,
                  excluded: bool | None = None) -> dict:
    query: dict[str, Any] = {"datasetId": dataset_id}
    if source:
        query["source"] = source
    if status:
        query["status"] = status
    if excluded is not None:
        query["excluded"] = excluded
    if q:
        query["preview"] = {"$regex": re.escape(q[:100]), "$options": "i"}
    return query


def read_example(store: storage.Store, dataset_id: str, offset: int, length: int) -> dict:
    raw = store.get_range(f"{storage.DATASETS}/{dataset_id}/examples.jsonl", offset, length)
    return json.loads(raw)


def page(store: storage.Store, db, dataset_id: str, *, offset: int, limit: int, source: str | None,
         status: str | None, q: str | None, full: bool) -> dict:
    query = example_query(dataset_id, source=source, status=status, q=q)
    total = db.examples.count_documents(query)
    rows = list(db.examples.find(query).sort("offset", 1).skip(offset).limit(limit))
    items = []
    for row in rows:
        item = {k: v for k, v in row.items() if k not in ("_id", "datasetId", "offset", "length")}
        item["id"] = row["exId"]
        if full:
            item["example"] = read_example(store, dataset_id, row["offset"], row["length"])
        items.append(item)
    return {"total": total, "offset": offset, "limit": limit, "items": items}


def iter_selected(store: storage.Store, dataset_id: str, wanted: dict[int, Any]):
    """Stream a dataset's examples.jsonl once, yielding (meta, raw line) for wanted offsets."""
    position = 0
    for line in store.iter_lines(f"{storage.DATASETS}/{dataset_id}/examples.jsonl"):
        if not line:
            position += 1
            continue
        meta = wanted.get(position)
        if meta is not None:
            yield meta, line.decode() if isinstance(line, bytes) else line
        position += len(line) + 1


def gzip_bytes(lines: list[str]) -> bytes:
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb") as gz:
        for line in lines:
            gz.write(line.encode() + b"\n")
    return buf.getvalue()
