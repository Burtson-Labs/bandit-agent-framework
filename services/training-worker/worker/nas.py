"""Bulky exports on the NAS share; local /models is scratch.

The share is mounted at the parent of ``NAS_RUNS_DIR`` (default ``/nas/training``). Each run gets
``<NAS_RUNS_DIR>/<runId>/`` and artifacts record a path relative to the share root
(``runs/<runId>/model.q4_k_m.gguf``) so training-api can resolve them under its own mount.
"""
from __future__ import annotations

import os
import shutil

from .client import sha256_file


def runs_dir() -> str | None:
    """The NAS runs directory, or None when the share isn't mounted (local runs, old Job specs)."""
    path = os.getenv("NAS_RUNS_DIR")
    if not path:
        return None
    root = os.path.dirname(path.rstrip("/"))
    if not os.path.isdir(root):
        return None
    os.makedirs(path, exist_ok=True)
    return path


def _rel(runs: str, *parts: str) -> str:
    return "/".join([os.path.basename(runs.rstrip("/")), *parts])


def copy_file(src: str, runs: str, run_id: str) -> dict:
    """Copy one export to the NAS, verify size + sha256 of the copy, return its artifact record."""
    dest_dir = os.path.join(runs, run_id)
    os.makedirs(dest_dir, exist_ok=True)
    name = os.path.basename(src)
    dest = os.path.join(dest_dir, name)
    tmp = dest + ".partial"
    digest = sha256_file(src)
    size = os.path.getsize(src)
    shutil.copyfile(src, tmp)
    if os.path.getsize(tmp) != size or sha256_file(tmp) != digest:
        os.remove(tmp)
        raise RuntimeError(f"NAS copy of {name} did not verify")
    os.replace(tmp, dest)
    return {"location": "nas", "path": _rel(runs, run_id, name), "size": size, "sha256": digest}


def copy_dir(src: str, runs: str, run_id: str, name: str) -> dict:
    dest = os.path.join(runs, run_id, name)
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    shutil.copytree(src, dest)
    files = sorted(os.path.relpath(os.path.join(r, f), dest) for r, _d, fs in os.walk(dest) for f in fs)
    return {"location": "nas", "path": _rel(runs, run_id, name), "files": files}


def clean_scratch(out_dir: str) -> None:
    """After a successful, verified export: drop merged weights, checkpoints and local GGUFs."""
    shutil.rmtree(out_dir, ignore_errors=True)
