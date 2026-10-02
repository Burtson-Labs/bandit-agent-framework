# training-api

Burtson Training Studio API: dataset versions (scrubbed Bandit trajectories), frozen train sets,
fine-tuning runs on the RTX 5090 through Anton's GPU arbitration, BanditBench results and
`bandit-local:<runId>` registration in the cluster Ollama. Contract: the Training Studio
`CONTRACT.md`; deploy: anton `docs/training/DEPLOY.md`.

- `/api/*` — AuthApi JWT (HS256). Admin for everything; the narrow `training` role may only
  upload and list datasets (the collector's key).
- `/internal/gpu-intent` — polled by Anton (owner `training`); never routed by an Ingress.
- `/internal/runs/{id}/*` — the worker's callbacks (per-run `X-Run-Token`).

Storage: MinIO bucket `training` (`datasets/`, `trainsets/`, `runs/`). State: Mongo database
`burtson_training`. Runs execute as `training-worker` Jobs in namespace `ai-training`.

    python -m pip install -r requirements.txt mongomock==4.3.0
    python -m unittest tests.test_api
