"""Register a finished run's GGUF with the cluster Ollama as ``bandit-local:<runId>``.

Ollama is parked while a run holds the GPU, so registration is a pending task that waits until
Ollama answers again. The GGUF streams from the NAS share (or MinIO for older runs) straight into
Ollama's blob store (no local copy): ``HEAD/POST /api/blobs/sha256:<digest>`` then ``POST /api/create`` with the Qwen3 chat
template (tools + thinking) and sampling defaults.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Iterator

import httpx

from . import artifacts, storage

logger = logging.getLogger("training.ollama")

# Ollama's Qwen3 template: tools in the system block, <tool_call>{"name","arguments"}</tool_call>
# from the assistant, tool results as <tool_response> user turns, optional <think>.
QWEN3_TEMPLATE = r"""{{- $lastUserIdx := -1 -}}
{{- range $idx, $msg := .Messages -}}
{{- if eq $msg.Role "user" }}{{ $lastUserIdx = $idx }}{{ end -}}
{{- end }}
{{- if or .System .Tools }}<|im_start|>system
{{ if .System }}{{ .System }}

{{ end }}
{{- if .Tools }}# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{{- range .Tools }}
{"type": "function", "function": {{ .Function }}}
{{- end }}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>
{{- end -}}
<|im_end|>
{{ end }}
{{- range $i, $_ := .Messages }}
{{- $last := eq (len (slice $.Messages $i)) 1 -}}
{{- if eq .Role "user" }}<|im_start|>user
{{ .Content }}<|im_end|>
{{ else if eq .Role "assistant" }}<|im_start|>assistant
{{ if (and $.IsThinkSet (and .Thinking (or $last (gt $i $lastUserIdx)))) -}}
<think>{{ .Thinking }}</think>
{{ end -}}
{{ if .Content }}{{ .Content }}
{{- end }}
{{- if .ToolCalls }}<tool_call>
{{ range .ToolCalls }}{"name": "{{ .Function.Name }}", "arguments": {{ .Function.Arguments }}}
{{ end }}</tool_call>
{{- end }}{{ if not $last }}<|im_end|>
{{ end }}
{{- else if eq .Role "tool" }}<|im_start|>user
<tool_response>
{{ .Content }}
</tool_response><|im_end|>
{{ end }}
{{- if and (ne .Role "assistant") $last }}<|im_start|>assistant
{{ if and $.IsThinkSet (not $.Think) -}}
<think>

</think>

{{ end -}}
{{ end }}
{{- end }}"""

QWEN3_PARAMETERS = {"stop": ["<|im_start|>", "<|im_end|>"], "temperature": 0.6, "top_p": 0.95, "top_k": 20}


def model_name(run_id: str) -> str:
    return "bandit-local:" + re.sub(r"[^a-z0-9._-]", "-", run_id.lower())[:60]


def create_body(run: dict, digest: str, quant: str) -> dict:
    body = {"model": model_name(run["_id"]), "files": {f"{model_name(run['_id']).replace(':', '-')}.{quant}.gguf": f"sha256:{digest}"},
            "stream": False}
    if run.get("family") == "qwen3":
        body["template"] = QWEN3_TEMPLATE
        body["parameters"] = {**QWEN3_PARAMETERS, "num_ctx": int((run.get("hyper") or {}).get("maxSeqLen") or 8192)}
    # gpt-oss: Ollama recognises the harmony template from the GGUF metadata.
    return body


class Registrar:
    def __init__(self, store: storage.Store, base_url: str | None = None, client: httpx.Client | None = None):
        self.store = store
        self.base_url = (base_url or os.getenv("OLLAMA_URL", "http://ollama-k8s.ollama.svc.cluster.local:11434")).rstrip("/")
        self.client = client or httpx.Client(timeout=httpx.Timeout(60, read=3600))

    def available(self) -> bool:
        try:
            return self.client.get(f"{self.base_url}/api/version", timeout=5).status_code == 200
        except httpx.HTTPError:
            return False

    def register(self, run: dict, quant: str = "q4_k_m") -> dict:
        artifact = (run.get("artifacts") or {}).get(f"gguf-{quant}")
        if not artifact:
            raise ValueError(f"run has no gguf-{quant} artifact")
        digest = artifact["sha256"]
        exists = self.client.head(f"{self.base_url}/api/blobs/sha256:{digest}")
        if exists.status_code != 200:
            stream, size = artifacts.open_artifact(self.store, artifact)

            def chunks() -> Iterator[bytes]:
                while chunk := stream.read(8 * 1024 * 1024):
                    yield chunk

            try:
                res = self.client.post(f"{self.base_url}/api/blobs/sha256:{digest}", content=chunks(),
                                       headers={"Content-Length": str(artifact.get("size") or size)})
            finally:
                stream.close()
            if res.status_code not in (200, 201):
                raise RuntimeError(f"blob upload answered {res.status_code}: {res.text[:200]}")
        res = self.client.post(f"{self.base_url}/api/create", json=create_body(run, digest, quant))
        if res.status_code != 200:
            raise RuntimeError(f"create answered {res.status_code}: {res.text[:300]}")
        return {"status": "registered", "model": model_name(run["_id"]), "quant": quant}


def pending_pass(db, registrar: Registrar, now) -> int:
    """Register every completed run still pending; returns how many succeeded this pass."""
    pending = list(db.runs.find({"status": "completed", "ollama.status": "pending"}))
    if not pending or not registrar.available():
        return 0
    done = 0
    for run in pending:
        quant = (run.get("ollama") or {}).get("quant") or ("q4_k_m" if "gguf-q4_k_m" in (run.get("artifacts") or {}) else "q8_0")
        try:
            result = registrar.register(run, quant)
            db.runs.update_one({"_id": run["_id"]}, {"$set": {"ollama": {**result, "at": now()}}})
            done += 1
        except Exception as exc:  # recorded on the run; a re-register retries
            logger.warning("ollama registration of %s failed: %s", run["_id"], exc)
            db.runs.update_one({"_id": run["_id"]}, {"$set": {"ollama": {"status": "failed", "error": str(exc)[:500], "quant": quant, "at": now()}}})
    return done
