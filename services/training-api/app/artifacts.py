"""Where a run's artifacts live and how to read them back.

Bulky exports (GGUF, merged weights) sit on the NAS share mounted at ``TRAINING_NAS_DIR``
(``location: "nas"``, ``path`` relative to that root, e.g. ``runs/<runId>/model.q4_k_m.gguf``);
small irreplaceable ones (the LoRA adapter, run metadata) stay in MinIO (``location: "minio"``,
``key``). Older runs recorded only ``key`` and are treated as MinIO.
"""
from __future__ import annotations

import os
from typing import BinaryIO

NAS_ROOT = os.getenv("TRAINING_NAS_DIR", "/nas/training")


class ArtifactError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def location(artifact: dict) -> str:
    return artifact.get("location") or ("nas" if artifact.get("path") and not artifact.get("key") else "minio")


def nas_path(artifact: dict, root: str | None = None) -> str:
    """Absolute path of a NAS artifact, refusing anything that escapes the share."""
    base = os.path.realpath(root or NAS_ROOT)
    rel = str(artifact.get("path") or "")
    if not rel or rel.startswith("/") or ".." in rel.split("/"):
        raise ArtifactError(400, "artifact has no valid NAS path")
    full = os.path.realpath(os.path.join(base, rel))
    if not full.startswith(base + os.sep):
        raise ArtifactError(400, "artifact path escapes the NAS root")
    return full


def is_file(artifact: dict) -> bool:
    """Directory artifacts (adapter, merged weights) carry a prefix/files list instead of one object."""
    return bool(artifact.get("key") or (location(artifact) == "nas" and not artifact.get("files")))


def open_artifact(store, artifact: dict, root: str | None = None) -> tuple[BinaryIO, int | None]:
    """(readable stream, size) for a single-file artifact."""
    if not is_file(artifact):
        raise ArtifactError(400, "this artifact is a directory; download its files from the NAS share")
    if location(artifact) == "nas":
        path = nas_path(artifact, root)
        if not os.path.isfile(path):
            raise ArtifactError(404, "artifact file is missing on the NAS")
        return open(path, "rb"), os.path.getsize(path)
    key = artifact.get("key")
    if not key:
        raise ArtifactError(404, "artifact has no MinIO key")
    return store.open_stream(key), artifact.get("size") or store.size(key)


def filename(artifact: dict) -> str:
    ref = artifact.get("path") or artifact.get("key") or "artifact"
    return os.path.basename(ref.rstrip("/")) or "artifact"
