"""Merge the adapter, write HF safetensors and GGUF (llama.cpp convert + quantize)."""
from __future__ import annotations

import os
import subprocess

LLAMA_CPP = os.getenv("LLAMA_CPP_DIR", "/opt/llama.cpp")
QUANTS = {"gguf-q4_k_m": "Q4_K_M", "gguf-q8_0": "Q8_0"}


def run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"{os.path.basename(cmd[0])} failed: {(proc.stderr or proc.stdout)[-1500:]}")


def merge(model, tokenizer, out_dir: str) -> str:
    merged = os.path.join(out_dir, "merged")
    model.save_pretrained_merged(merged, tokenizer, save_method="merged_16bit")
    return merged


def save_adapter(model, tokenizer, out_dir: str) -> str:
    adapter = os.path.join(out_dir, "adapter")
    model.save_pretrained(adapter)
    tokenizer.save_pretrained(adapter)
    return adapter


def gguf(merged: str, out_dir: str, wanted: list[str]) -> dict[str, str]:
    """{export name: path}. Converts once to f16, quantizes per export, removes the f16."""
    quants = [w for w in wanted if w in QUANTS]
    if not quants:
        return {}
    f16 = os.path.join(out_dir, "model.f16.gguf")
    run(["python3", os.path.join(LLAMA_CPP, "convert_hf_to_gguf.py"), merged, "--outfile", f16, "--outtype", "f16"])
    paths = {}
    for name in quants:
        path = os.path.join(out_dir, f"model.{QUANTS[name].lower()}.gguf")
        run([os.path.join(LLAMA_CPP, "build", "bin", "llama-quantize"), f16, path, QUANTS[name]])
        paths[name] = path
    os.remove(f16)
    return paths
