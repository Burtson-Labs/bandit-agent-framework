# training-worker

One Burtson Training Studio run per Kubernetes Job (namespace `ai-training`, RTX 5090 on
son-of-anton, launched by training-api once Anton holds the GPU for owner `training`).

Stages: spec from training-api → trainset from MinIO → SFT with LoRA/QLoRA (Unsloth + TRL,
assistant tokens only via `train_on_responses_only`, Qwen3 chat template with tools) →
checkpoint every 50 steps on the `training-models` PVC (a retried or resumed run continues
from the newest) → merge → GGUF Q4_K_M/Q8_0 (llama.cpp) + optional safetensors → upload →
private Ollama with the deploy template: tool-call probe + BanditBench (`--provider ollama`) →
`POST /complete`. training-api then registers `bandit-local:<runId>` in the cluster Ollama.

Smoke test (Qwen3-0.6B, 20 steps, minutes):

    # in the cluster: POST /api/runs {"trainsetId": …, "baseModel": "qwen3-0.6b", "smoke": true, "schedule": "now"}
    # on any CUDA box:  docker run --gpus all ghcr.io/burtson-labs/training-worker:<sha> --local --smoke

CPU tests (no torch needed): `python -m unittest tests.test_worker` (needs httpx, boto3).
Pinned versions are in `requirements.txt`; the resolved set is written to `/opt/requirements.lock`.
