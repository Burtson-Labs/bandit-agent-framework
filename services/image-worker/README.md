# ComfyUI image worker

Reproducible CUDA 12.8 / PyTorch cu128 worker for the RTX 5090. ComfyUI is pinned
to an exact commit and contains no custom nodes. Model weights are supplied by the
read-only `image-models` volume and are intentionally not downloaded at build or
startup time.

Expected file:

- `models/checkpoints/flux1-schnell-fp8.safetensors`

Video (Wan 2.2) files, staged with SHA-256 verification; licences, revisions and
digests are in `models/manifests/MODELS-wan22.md` on the volume:

- `models/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors`
- `models/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors`
- `models/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors`
- `models/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_{high,low}_noise.safetensors`
- `models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors`
- `models/vae/wan2.2_vae.safetensors`, `models/vae/wan_2.1_vae.safetensors`
- `models/upscale_models/RealESRGAN_x2plus.pth`
- `models/frame_interpolation/rife_v4.26.safetensors`

The pinned ComfyUI commit (2026-09-20) already has native Wan 2.2, first/last
frame, RIFE/FILM interpolation and model-upscale nodes, so video needs no
custom nodes and no worker rebuild.
