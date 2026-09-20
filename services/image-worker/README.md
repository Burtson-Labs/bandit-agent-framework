# ComfyUI image worker

Reproducible CUDA 12.8 / PyTorch cu128 worker for the RTX 5090. ComfyUI is pinned
to an exact commit and contains no custom nodes. Model weights are supplied by the
read-only `image-models` volume and are intentionally not downloaded at build or
startup time.

Expected file:

- `models/checkpoints/flux1-schnell-fp8.safetensors`
