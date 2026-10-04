# training-worker

One Burtson Training Studio run per Kubernetes Job (namespace `ai-training`, on the GPU node
named by `TRAINING_NODE`, launched by training-api once Anton holds the GPU for owner `training`).

Stages: spec from training-api → trainset from MinIO → SFT with LoRA/QLoRA (Unsloth + TRL,
assistant tokens only via `train_on_responses_only`, Qwen3 chat template with tools) →
checkpoint every 50 steps on the `training-models` PVC (a retried or resumed run continues
from the newest) → merge → GGUF Q4_K_M/Q8_0 (llama.cpp) + optional safetensors → store →
private Ollama with the deploy template: tool-call probe + BanditBench (`--provider ollama`) →
`POST /complete`. training-api then registers `bandit-local:<runId>` in the cluster Ollama.

Storage: the LoRA adapter (small, irreplaceable) goes to MinIO bucket `training`; GGUF and merged
weights (bulky, rebuildable from adapter + base) are copied to the NAS share (`NAS_RUNS_DIR`,
`/nas/training/runs/<runId>/`, size + sha256 verified) and the run's scratch on the
`training-models` PVC (checkpoints, merged, local GGUF) is deleted once the run completes. Without
the share mounted, exports fall back to MinIO as before.

Smoke test (Qwen3-0.6B, 20 steps, minutes):

    # in the cluster: POST /api/runs {"trainsetId": …, "baseModel": "qwen3-0.6b", "smoke": true, "schedule": "now"}
    # on any CUDA box:  docker run --gpus all ghcr.io/burtson-labs/training-worker:<sha> --local --smoke

CPU tests (no torch needed): `python -m unittest tests.test_worker` (needs httpx, boto3).
Pinned versions are in `requirements.txt`; the resolved set is written to `/opt/requirements.lock`.
