"""training-worker entrypoint: one run, start to finish.

    python -m worker.main --run <runId> [--smoke]        # in the Job (env from training-api)
    python -m worker.main --local --smoke                # no API/MinIO: synthetic data, files in ./smoke-out

Stages: spec → download trainset → SFT (resumable) → merge → exports → upload → BanditBench →
POST /complete. Any exception posts /fail. SIGTERM saves a checkpoint and exits non-zero so the
Job retries and the next attempt resumes.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import traceback

from . import data, nas
from .client import Api, Bucket, Cancelled

SMOKE_SPEC = {"runId": "local-smoke", "baseModel": "qwen3-0.6b", "hf": "Qwen/Qwen3-0.6B", "family": "qwen3",
              "method": "lora", "exports": ["gguf-q8_0"], "evalBanditBench": False, "smoke": True,
              "hyper": {"rank": 8, "alpha": 16, "lr": 2e-4, "epochs": 1, "maxSeqLen": 2048, "batch": 1, "gradAccum": 4},
              "resume": False, "attempt": 1, "trainKeys": None, "ollama": None}


class LocalApi:
    """--local: print progress instead of calling training-api."""

    def spec(self):
        return dict(SMOKE_SPEC)

    def progress(self, **fields):
        print("progress", json.dumps({k: v for k, v in fields.items() if v is not None}), flush=True)

    def complete(self, artifacts, eval_result):
        print("complete", json.dumps({"artifacts": artifacts, "eval": eval_result}, indent=2), flush=True)

    def fail(self, error):
        print("FAILED", error, flush=True)


def load_rows(spec: dict, bucket, work: str, smoke: bool) -> tuple[list[dict], list[dict]]:
    keys = spec.get("trainKeys")
    if not keys or bucket is None:
        rows = data.smoke_examples() if smoke else []
        return rows[:-4], rows[-4:]
    out = {}
    for split in ("train", "eval"):
        path = os.path.join(work, f"{split}.jsonl")
        bucket.download(keys[split], path)
        with open(path, encoding="utf-8") as handle:
            out[split] = data.load_jsonl(handle)
    return out["train"], out["eval"]


def main(argv: list[str] | None = None) -> int:
    args = argparse.ArgumentParser()
    args.add_argument("--run", default=os.getenv("RUN_ID"))
    args.add_argument("--smoke", action="store_true")
    args.add_argument("--local", action="store_true")
    opts = args.parse_args(argv)

    from .train import Stop, run_sft
    from . import evaluate, export

    Stop.install()
    if opts.local:
        api, bucket = LocalApi(), None
    else:
        api = Api(os.environ["TRAINING_API_URL"], opts.run, os.environ["RUN_TOKEN"])
        bucket = Bucket()
    try:
        spec = api.spec()
        smoke = opts.smoke or bool(spec.get("smoke"))
        run_id = spec["runId"]
        runs_dir = os.getenv("RUNS_DIR", os.path.abspath("smoke-out") if opts.local else "/models/runs")
        out_dir = os.path.join(runs_dir, run_id)
        os.makedirs(out_dir, exist_ok=True)
        work = tempfile.mkdtemp(prefix="train-")
        api.progress(status="preparing", stage="downloading trainset")
        train_rows, eval_rows = load_rows(spec, bucket, work, smoke)
        model, tokenizer, metrics = run_sft(spec, train_rows, eval_rows, os.path.join(out_dir, "checkpoints"),
                                            api.progress, smoke=smoke)
        if Stop.requested:
            print("stop requested: checkpoint saved, exiting for a retry/resume", flush=True)
            return 143

        api.progress(status="exporting", stage="merging adapter")
        adapter = export.save_adapter(model, tokenizer, out_dir)
        merged = export.merge(model, tokenizer, out_dir)
        del model
        try:
            import torch
            torch.cuda.empty_cache()
        except Exception:
            pass
        api.progress(status="exporting", stage="gguf")
        ggufs = export.gguf(merged, out_dir, spec["exports"])

        artifacts: dict = {}
        prefix = f"runs/{run_id}"
        nas_runs = nas.runs_dir() if bucket else None
        if bucket:
            api.progress(status="exporting", stage="uploading")
            # Small and irreplaceable → MinIO (backed up nightly); bulky and rebuildable → NAS.
            artifacts["adapter"] = {"location": "minio", **bucket.upload_dir(adapter, f"{prefix}/adapter")}
            for name, path in ggufs.items():
                artifacts[name] = (nas.copy_file(path, nas_runs, run_id) if nas_runs
                                   else {"location": "minio", **bucket.upload(path, f"{prefix}/{os.path.basename(path)}")})
            if "safetensors" in spec["exports"]:
                artifacts["safetensors"] = (nas.copy_dir(merged, nas_runs, run_id, "merged") if nas_runs
                                            else {"location": "minio", **bucket.upload_dir(merged, f"{prefix}/hf")})
        else:
            artifacts = {name: {"path": path} for name, path in ggufs.items()} | {"adapter": {"path": adapter},
                                                                                   "merged": {"path": merged}}
        eval_result = {"training": metrics}
        eval_gguf = ggufs.get("gguf-q8_0") or ggufs.get("gguf-q4_k_m")
        if eval_gguf and (spec.get("evalBanditBench") or smoke) and spec.get("ollama"):
            api.progress(status="evaluating", stage="banditbench" if not smoke else "ollama probe")
            eval_result.update(evaluate.evaluate(eval_gguf, spec["ollama"], smoke=smoke))
        api.complete(artifacts, eval_result)
        if nas_runs:
            # Everything worth keeping is on the NAS or in MinIO now; free son-of-anton's disk.
            nas.clean_scratch(out_dir)
        return 0
    except Cancelled:
        print("run was cancelled in training-api; stopping", flush=True)
        return 0
    except Exception as exc:
        traceback.print_exc()
        api.fail(f"{type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
