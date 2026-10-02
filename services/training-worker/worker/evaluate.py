"""BanditBench on the exported model, served exactly as it will be deployed.

A private Ollama runs inside the Job (127.0.0.1:11435), the GGUF is registered with the same
template/parameters training-api will use for the cluster Ollama, and the CLI eval runs
against it with ``--provider ollama``. Any missing piece (no repo configured, clone/build
failure, CLI without ollama support) returns ``{"skipped": reason}`` — the run still completes.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time

import httpx

from .client import sha256_file

OLLAMA_PORT = int(os.getenv("EVAL_OLLAMA_PORT", "11435"))
EVAL_MODEL = "bandit-local:eval"


def _wait(url: str, seconds: int) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if httpx.get(url, timeout=3).status_code == 200:
                return True
        except httpx.HTTPError:
            pass
        time.sleep(1)
    return False


def serve_and_register(gguf_path: str, modelfile: dict, work: str) -> tuple[subprocess.Popen, str]:
    if not shutil.which("ollama"):
        raise RuntimeError("ollama binary not found in the image")
    env = {**os.environ, "OLLAMA_HOST": f"127.0.0.1:{OLLAMA_PORT}", "OLLAMA_MODELS": os.path.join(work, "ollama-models"),
           "OLLAMA_KEEP_ALIVE": "30m"}
    proc = subprocess.Popen(["ollama", "serve"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{OLLAMA_PORT}"
    if not _wait(f"{base}/api/version", 60):
        proc.terminate()
        raise RuntimeError("private ollama did not start")
    digest = sha256_file(gguf_path)
    with open(gguf_path, "rb") as handle:
        res = httpx.post(f"{base}/api/blobs/sha256:{digest}", content=handle, timeout=None)
    if res.status_code not in (200, 201):
        raise RuntimeError(f"blob upload: {res.status_code} {res.text[:200]}")
    body = {"model": EVAL_MODEL, "files": {"model.gguf": f"sha256:{digest}"}, "stream": False, **modelfile}
    res = httpx.post(f"{base}/api/create", json=body, timeout=600)
    if res.status_code != 200:
        raise RuntimeError(f"create: {res.status_code} {res.text[:300]}")
    return proc, base


def banditbench(ollama_url: str, work: str, runs: int = 1) -> dict:
    repo = os.getenv("BANDITBENCH_REPO", "").strip()
    if not repo:
        return {"skipped": "BANDITBENCH_REPO is not set"}
    if not (shutil.which("git") and shutil.which("node") and shutil.which("corepack")):
        return {"skipped": "git/node/corepack not available in the image"}
    src = os.path.join(work, "bandit-agent-framework")
    try:
        subprocess.run(["git", "clone", "--depth", "1", repo, src], check=True, capture_output=True, timeout=600)
        subprocess.run(["corepack", "enable"], cwd=src, check=True, capture_output=True, timeout=120)
        subprocess.run(["pnpm", "install", "--frozen-lockfile"], cwd=src, check=True, capture_output=True, timeout=1800)
        subprocess.run(["pnpm", "build"], cwd=src, check=True, capture_output=True, timeout=1800)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        err = getattr(exc, "stderr", b"") or b""
        return {"skipped": f"could not build the CLI: {err.decode(errors='replace')[-400:] or exc}"}
    out = os.path.join(work, "eval.json")
    env = {**os.environ, "OLLAMA_URL": ollama_url, "HOME": work}
    proc = subprocess.run(["pnpm", "--filter", "@burtson-labs/bandit-stealth-cli", "eval", "--",
                           "--provider", "ollama", "--model", EVAL_MODEL, "--runs", str(runs), "--json-out", out],
                          cwd=src, env=env, capture_output=True, text=True, timeout=4 * 3600)
    if not os.path.exists(out):
        return {"skipped": f"eval produced no JSON (exit {proc.returncode}): {(proc.stderr or proc.stdout)[-400:]}"}
    with open(out) as handle:
        report = json.load(handle)
    totals = report.get("totals") or {}
    fixtures = report.get("fixtures") or []
    passed, total = int(totals.get("passed") or 0), int(totals.get("fixtures") or len(fixtures))
    return {"suite": "banditbench", "passed": passed, "fixtures": total,
            "passRate": round(passed / total, 4) if total else None, "runsPerFixture": runs,
            "failed": [{"id": f.get("id"), "passRate": f.get("passRate"), "reasons": (f.get("failureReasons") or [])[:3]}
                       for f in fixtures if not f.get("passed")][:30]}


def evaluate(gguf_path: str, modelfile: dict, *, smoke: bool) -> dict:
    work = tempfile.mkdtemp(prefix="eval-")
    proc = None
    try:
        proc, base = serve_and_register(gguf_path, modelfile, work)
        # Always prove the artifact answers through Ollama with tools (the deploy path).
        probe = httpx.post(f"{base}/api/chat", timeout=600, json={
            "model": EVAL_MODEL, "stream": False, "messages": [{"role": "user", "content": "Read src/index.ts and summarise it."}],
            "tools": [{"type": "function", "function": {"name": "read_file", "description": "Read a file",
                                                         "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}}]})
        message = (probe.json() if probe.status_code == 200 else {}).get("message") or {}
        result = {"ollamaProbe": {"ok": probe.status_code == 200, "toolCalls": len(message.get("tool_calls") or []),
                                  "content": (message.get("content") or "")[:300]}}
        if smoke:
            result["banditbench"] = {"skipped": "smoke run"}
        else:
            result["banditbench"] = banditbench(base, work)
        return result
    except Exception as exc:
        return {"skipped": str(exc)[:500]}
    finally:
        if proc:
            proc.terminate()
        shutil.rmtree(work, ignore_errors=True)
