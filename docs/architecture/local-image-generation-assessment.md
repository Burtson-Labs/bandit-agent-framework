# Local image generation assessment for `son-of-anton`

Assessment date: 2026-09-20. All cluster inspection was read-only. No workload was restarted, scaled, or otherwise changed, and no model was downloaded.

## Executive recommendation

Use **exclusive, application-controlled GPU switching (Option C)**. Keep a CPU-only `image-api` continuously available, but run the ComfyUI worker at zero or one replica. Extend the existing Anton GPU-mode controller so exactly one heavy owner—currently Ollama, Voice Studio, or the image worker—holds `nvidia.com/gpu: 1`. Route ordinary chat to cloud providers while image work owns the GPU, queue image jobs durably in the existing MongoDB, upload completed assets to the existing MinIO, and retain ComfyUI for a short idle window (initially 10 minutes) to amortize model load.

Do not enable NVIDIA time-slicing for Ollama plus image generation on this card. Do not let either pod bypass the Kubernetes GPU resource. The current device plugin exposes exactly one indivisible extended resource, so two pods that each request `nvidia.com/gpu: 1` cannot schedule together. NVIDIA time-slicing could make both schedulable, but it has no VRAM or fault isolation and therefore makes two large, bursty model servers less reliable, not more reliable.

## Implementation status

The first implementation is now present in this workspace and its sibling application repositories:

- `services/image-api`: CPU-only FastAPI abstraction with validation, an in-process single-worker queue, cancellation, fixed/versioned FLUX workflow generation, MinIO output/provenance storage, and authenticated asset streaming through Anton.
- `services/image-worker`: pinned ComfyUI container on CUDA 12.8 / PyTorch cu128, with no public interface and no model baked into the image.
- `ops/k8s/image-generation-draft.yaml`: zero-replica GPU worker, static retained model PV, ClusterIP-only services, security contexts, resource limits, and namespace ingress policies.
- Anton: one shared transition gate for Ollama, the GPU VM, Voice Studio, and image generation; image claim/release/status endpoints; idle reclaim; failure rollback to Ollama; narrowly scoped worker-scale RBAC; authenticated image API proxy.
- Burtson Labs website: `/image-studio`, a MUI chat-style prompt experience with explicit GPU claim/release, async job progress, authenticated image retrieval/download, and a link back to cloud-capable chat while local Ollama is parked.
- Voice Studio: the long-reference clone failure was traced to a valid, audible WebM falling into a broken ASR fallback. The container build now pins upstream, installs isolated cuDNN 8 compatibility libraries, and selects the already-installed `faster-whisper` backend. The same compatibility files and environment were placed on the live PVC/deployment while Voice Studio was scaled down; no voice profile or model data was removed.

The MVP deliberately uses FLUX.1 Schnell as the initial production workflow because it is commercially permissive (Apache-2.0), fast at four steps, and predictable on 32 GB. It does not claim that this is the final quality model; FLUX.2/Qwen candidates still require the measured smoke-test phase below.

The API queue is intentionally in-process for one GPU and one API replica. Mongo-backed durable leases remain a production-hardening step before scaling the API or promising restart-safe queued jobs. The manifests have not been applied because the new images have not been built/pinned and the model files and least-privilege MinIO credentials have not been provisioned; applying them before those prerequisites would create a knowingly broken rollout.

## 1. Current-state findings

### Cluster and node

- Context: `burtson.ai`; 15-node k3s cluster.
- `son-of-anton`: Ready, k3s `v1.33.5+k3s1`, Ubuntu 24.04.3, kernel `6.8.0-90-generic`, containerd `2.1.4-k3s1`.
- Labels: `node-role.kubernetes.io/ai`, `nvidia.com/gpu.present=true`, `disktype=ssd`, `kubernetes.io/arch=amd64`.
- Taint: `dedicated=ai:NoSchedule`.
- Allocatable: 24 CPU, about 125.6 GiB RAM, 3.48 TiB ephemeral storage, 110 pods, and exactly `nvidia.com/gpu: 1`.
- At inspection time: 82m CPU and 9,978 MiB node RAM reported by metrics-server.
- Local filesystem: 3.6 TiB total, 411 GiB used, 3.1 TiB available (12% used). No node disk pressure.

### GPU and runtime

- NVIDIA GeForce RTX 5090, 32,607 MiB VRAM.
- Driver `570.211.01`; `nvidia-smi` reports CUDA 12.8.
- NVIDIA Container Toolkit `1.17.8`.
- k3s containerd's default runtime is `nvidia`, backed by `/usr/bin/nvidia-container-runtime`.
- Device plugin: a hand-managed DaemonSet using `nvcr.io/nvidia/k8s-device-plugin:v0.16.0`, NVML discovery, no sharing configuration. Current upstream is materially newer (`v0.20.0` at assessment time), so this should be upgraded in a planned maintenance window rather than bundled into image-service deployment.
- The device-plugin checkpoint assigns the sole GPU UUID only to the current Voice Studio pod.
- Snapshot: 0% GPU utilization, about 2.8 GiB VRAM reported used, P1, 40–41 C. `nvidia-smi` showed no compute process, but host device handles showed Voice Studio Python processes holding `/dev/nvidia*`. Treat this discrepancy as an observability/recovery warning and add DCGM metrics before production use.
- No NVRM Xid or “fallen off bus” kernel entry appeared in the last 30 days of retained kernel logs. This does not disprove the historical disappearance issue.

### GPU workloads and switching already present

- `ollama/ollama-k8s` is a Helm-managed Deployment with `Recreate`, `replicas: 0`, `nvidia.com/gpu: 1`, the AI node selector/toleration, and a ClusterIP service on 11434.
- `voice-studio/voice-studio` is currently `replicas: 1`, `Recreate`, requests and limits the one GPU, and is pinned to `son-of-anton`. It requests 2 CPU/8 GiB RAM and limits RAM to 16 GiB.
- Recent events show Voice Studio previously remained Pending with `Insufficient nvidia.com/gpu` until the prior owner released it. This directly confirms exclusive scheduling behavior.
- The existing privileged `anton-node-agent` already knows the Ollama and Voice Studio Deployment names and is therefore the natural place to extend the current exclusive-mode state machine. Do not create a second independent scaler.
- Two `stt-api` pods, Bandit Voice, Anton, exporters, and preload helpers also run on the node. STT does not request a GPU, but the two replicas currently consume about 7.2 GiB system RAM in total and have no resource requests or limits. They are a CPU/RAM contention risk even though they are not scheduled GPU owners.
- Voice Studio's model PVC is 60 GiB local-path on `son-of-anton`; its PV reclaim policy is `Delete` despite the Helm keep annotation. This deserves backup/retention review.

### Ollama configuration and storage

- Ollama is deliberately off at present, not continuously busy.
- Environment includes `OLLAMA_KEEP_ALIVE=24h`, `OLLAMA_NUM_PARALLEL=3`, and `OLLAMA_MAX_QUEUE=64`. A 24-hour keepalive is hostile to burst sharing because it intentionally retains model VRAM. Under GPU arbitration, reduce it to roughly `5m`–`10m`, or explicitly issue an unload (`keep_alive: 0`) before relinquishing the mode, then scale to zero.
- The persistent hostPath is `/mnt/ollama-models`, currently about 214 GiB, with roughly 3.1 TiB free on the same filesystem.
- Stored tags include Bandit Core/Logic, Gemma, Qwen 2.5/3/3.6, DeepSeek Coder, Llama 3, and Nomic Embed. Several blobs are 17–35 GiB, so Ollama can plausibly consume most or all VRAM when active.
- Gateway API has two replicas and already has OpenAI, Anthropic, Azure OpenAI, Ollama Cloud, local Ollama, MongoDB, Qdrant, and MinIO wiring. Local Ollama points to the internal ClusterIP service. This supports cloud-first routing during image mode without a new gateway layer.

### Storage and networking

- Storage is primarily k3s `local-path`; MinIO is a four-pod StatefulSet with four 300 GiB local volumes and internal services on 9000.
- There are no NetworkPolicy objects in the cluster today. Adding ingress isolation only for the new namespace is useful, but first confirm that the installed CNI enforces NetworkPolicy.
- Existing public ingress is NGINX/MetalLB. ComfyUI needs neither Ingress nor LoadBalancer; only the Gateway-facing image API should be reachable, and that should initially be ClusterIP-only.

## 2. GPU-sharing answer

**Same physical node:** yes. Ollama, Voice Studio, ComfyUI, and future vision workloads can all be defined for `son-of-anton` and reuse its local model disk.

**Same physical GPU:** yes, sequentially. Each heavy worker can request the one GPU while it is the selected mode.

**Same time:** not safely with the current configuration. Kubernetes treats `nvidia.com/gpu` as a whole-number extended resource; a GPU limit is also the request when only the limit is specified. One current owner consumes capacity 1/1, and the next GPU pod remains Pending. This is exactly what recent Voice Studio events show.

**By bypassing resource requests:** technically CUDA processes could share a card, but Kubernetes would lose arbitration. Ollama and ComfyUI could independently retain tens of GiB, leaving no hard VRAM boundary; the likely failure modes are allocation errors, process OOMs, context churn, long tail latency, and hard-to-recover driver state.

**NVIDIA time-slicing:** not recommended. It changes scheduling capacity by advertising replicas but provides neither memory nor fault isolation. The RTX 5090 also does not offer the datacenter-style MIG partitioning needed for real VRAM isolation. Time-slicing is appropriate for many small kernels, not two servers whose working sets can each approach 32 GiB.

**Sequential/bursty use:** yes, and it is the best fit. Existing cloud routing means there is no need to keep local text generation resident while images run.

### Options verdict

- A — simultaneous Kubernetes GPU workloads: does not schedule today; reject.
- B — process-level sharing: possible only by weakening isolation; reject for production.
- C — workload switching: **recommended**, and consistent with the existing Ollama/Voice Studio pattern.
- D — always-running ComfyUI: viable only if image traffic becomes dominant and Voice Studio/Ollama are intentionally displaced. Today it adds a third long-lived claimant and worsens cold/warm ownership ambiguity; do not make it the default.

## 3. Recommended architecture

```text
General worker nodes                         son-of-anton (dedicated=ai)
┌──────────────────────────────┐             ┌──────────────────────────────┐
│ Gateway API (existing)       │             │ Anton GPU mode controller   │
│ image-api (always on, CPU)   │──mode API──>│  exactly one owner at once  │
│ MongoDB job records          │             │                              │
│ MinIO final assets           │<──upload────│ image-worker + ComfyUI      │
└──────────────────────────────┘             │ replicas 0/1, GPU=1         │
                                             │ Ollama replicas 0/1, GPU=1  │
                                             │ Voice replicas 0/1, GPU=1   │
                                             │ local model files / NVMe     │
                                             └──────────────────────────────┘
```

Use one container/pod as the image worker with ComfyUI running as its internal workflow engine. Avoid a separate GPU sidecar: it would complicate process supervision without improving GPU isolation. The API submits a versioned, server-owned workflow to ComfyUI; users never submit arbitrary Comfy graphs or custom-node code.

### Arbitration policy

1. Normal chat prefers cloud when policy/cost/privacy permit. Local Ollama remains available for local/privacy/offline/specific-model work.
2. A requested image is persisted in MongoDB as `queued` before acknowledgement.
3. The image API requests the `image` GPU mode from Anton. Anton serializes mode transitions with a durable lease/state record.
4. Anton drains the current owner: stop accepting its new work, allow a bounded grace period, explicitly unload Ollama models where applicable, scale it to zero, wait for its pod and GPU device handles to disappear, then scale image-worker to one.
5. Image jobs execute one at a time initially. Keep the worker/model warm for 10 idle minutes; process queued jobs during that window.
6. After the idle window, scale image-worker to zero and restore the configured safe default, currently local Ollama.
7. While image mode is active, Gateway routes normal text to cloud. Local-only callers receive a clear busy/queued response rather than triggering concurrent GPU use.

Do not use Kubernetes Jobs per image. Model startup and graph compilation make one pod per image expensive, Jobs make cancellation and warm reuse awkward, and the ComfyUI queue already serializes a warm worker. Use a Deployment scaled 0/1 plus a durable application queue.

Do not add RabbitMQ yet. MongoDB already exists, is already integrated into Gateway, supports atomic claim/lease patterns, and provides durable status across image-api or worker restarts. ComfyUI's queue is an execution detail, not the system of record. Revisit a broker only when there are multiple GPU workers or sustained throughput that justifies it.

## 4. Image API and request flow

```text
Bandit chat / agent
  -> Gateway `generate_image`
  -> POST image-api /v1/images/generations
  -> validate auth, tenant, dimensions, model capability, reference image
  -> store job in MongoDB; return 202 + jobId
  -> acquire image GPU mode through Anton
  -> image-worker becomes Ready
  -> image-api compiles model alias + workflow version into a fixed ComfyUI graph
  -> ComfyUI queue executes one job
  -> temporary output is checksummed and uploaded to MinIO
  -> metadata/provenance is written to MongoDB and a sidecar JSON object
  -> signed/CDN asset URL returned by GET /v1/images/jobs/{jobId}
  -> after idle timeout, image-worker releases GPU mode
```

Suggested public tool contract:

```json
{
  "prompt": "...",
  "width": 1024,
  "height": 1024,
  "model": "production",
  "style": "optional-style-id",
  "referenceImageAssetId": "optional-existing-asset-id",
  "transparentBackground": false,
  "clientRequestId": "idempotency-key"
}
```

Use model aliases (`production`, `quality`, `fast`, `experimental`) rather than exposing checkpoint paths. Return `capabilities` errors when a model does not support editing or transparency. “Transparent background” should be a separate, versioned background-removal stage unless the chosen workflow natively and reliably emits alpha.

Required job states: `queued`, `acquiring_gpu`, `loading_model`, `running`, `uploading`, `completed`, `failed`, `cancel_requested`, `cancelled`, `retry_wait`. Include progress as advisory only. Cancellation must remove a queued Comfy prompt or interrupt between safe workflow stages; a CUDA kernel already executing may not be instantly cancellable.

## 5. Model recommendation

VRAM numbers are working-set estimates and must be benchmarked with the exact ComfyUI build, quantization, attention backend, resolution, and edit/reference count. Leave at least 3–4 GiB headroom on this 32 GiB card; do not plan against the nominal maximum.

| Role | Model | Practical fit on 5090 | License and recommendation |
|---|---|---|---|
| Default production | FLUX.2 Klein 4B | Official card says about 13 GiB; four-step distilled generation; unified text-to-image and multi-reference editing. Expect roughly 14–18 GiB depending on encoder/workflow. | Apache-2.0; commercially usable. Best first production default because it leaves useful headroom and covers future editing. |
| High quality | Qwen-Image-2512 | 20B BF16 base is too large to assume a native all-GPU fit. Use a vetted FP8/quantized workflow and/or CPU offload; plan around 24–30 GiB and substantially slower 50-step runs. Benchmark at 1024 and 1328-class resolutions. | Apache-2.0. Strong realism, detail, prompt adherence, and text rendering; make this opt-in `quality`, not the first bring-up model. |
| Fast | Z-Image-Turbo | Official card says it fits 16 GiB and uses 8 NFEs. Expect roughly 12–16 GiB with an optimized workflow. Strong photorealism and English/Chinese text; generation-focused rather than the editing default. | Apache-2.0. Good high-throughput alternative once FLUX is stable. |
| Experimental only | FLUX.2 Klein 9B | Official card says about 29 GiB. This is too close to the card's limit for comfortable coexistence with residual contexts or complex edits. | FLUX Non-Commercial License. Do not use as a Burtson Labs/Bandit production default without a separate commercial license and legal review. |

Licensing buckets:

- Commercially permissive: official FLUX.2 Klein 4B, Qwen-Image/Qwen-Image-2512/Qwen-Image-Edit official releases, and Z-Image-Turbo are labelled Apache-2.0.
- Research/non-commercial: FLUX.2 Klein 9B official weights.
- Ambiguous/requires review: community quantizations, merges, LoRAs, custom nodes with bundled assets, or any checkpoint whose uploader is not the original rights holder. Record the exact repository, revision hash, license snapshot, SHA-256, and approval status before promotion.

Primary model sources: [FLUX.2 Klein 4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B), [FLUX.2 Klein 9B](https://huggingface.co/black-forest-labs/FLUX.2-klein-9B), [Qwen-Image-2512](https://huggingface.co/Qwen/Qwen-Image-2512), [Qwen-Image-Edit](https://huggingface.co/Qwen/Qwen-Image-Edit), and [Z-Image-Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo).

## 6. Kubernetes layout

- Namespace: `ai-image`, separate from `ollama` and `voice-studio` to avoid changing their Helm ownership.
- `image-api`: Deployment, one replica initially, CPU-only, kept away from the dedicated AI node, ClusterIP only, no Kubernetes API token. Scale API replicas only after implementing Mongo-backed leader/claim semantics.
- `image-worker`: Deployment with `Recreate`, zero replicas initially, `nvidia.com/gpu: 1`, the existing AI node selector and taint toleration, ClusterIP only, no Kubernetes API token.
- Anton remains the only component permitted to change GPU-owner Deployment scales. Add the image worker to its mode API and RBAC rather than granting the image API broad cross-namespace patch rights.
- No PDB for the GPU worker: there is only one eligible node and deliberate scale-to-zero. A PDB would add no availability.
- No PriorityClass initially. Preemption does not solve active CUDA work safely; explicit drain/switch does.
- Pin both application images by digest. Pin ComfyUI and every custom-node revision. Do not enable ComfyUI Manager in production.
- Use a startup probe long enough for model load, readiness only after ComfyUI can accept work, and liveness that detects a wedged server without using short thresholds that create GPU restart loops.

### Model directory

Do not move the existing 214 GiB Ollama directory during this project. Add:

```text
/mnt/ollama-models/                    # existing, unchanged; Ollama format
/mnt/ai-models/comfyui/
  diffusion_models/
  checkpoints/
  text_encoders/
  vae/
  loras/
  controlnet/
  cache/
  manifests/                           # license, source revision, SHA-256
```

Ollama blobs and ComfyUI safetensors generally are not interchangeable, so forcing a shared blob directory would not avoid meaningful duplication. Within ComfyUI, use `extra_model_paths.yaml` to share text encoders/VAEs across workflows. Pre-stage models out of band into a temporary filename, verify size and SHA-256, then atomically rename; never let a partial download become selectable.

The draft uses a static local PV with `Retain`, bound to `son-of-anton`, rather than a dynamically deleted local-path PV. Back up small manifests/workflows separately; model weights can generally be reconstructed from pinned sources.

### Temporary and final object storage

- Use bounded pod-local `emptyDir` only for reference downloads, intermediate tensors/images, and upload staging. Delete it on success/failure.
- Upload final images to MinIO before marking the job complete.
- Prefer a dedicated bucket `generated-images` with keys:

```text
v1/tenant/{tenantId}/yyyy/mm/dd/{jobId}/image-0001.png
v1/tenant/{tenantId}/yyyy/mm/dd/{jobId}/metadata.json
```

- Store immutable metadata: job/tenant/user IDs; created/completed times; normalized prompt hash and optionally encrypted/restricted raw prompt; negative prompt; model alias and exact checkpoint digest; workflow ID/version/hash; ComfyUI image digest; sampler/scheduler/steps/CFG/seed; width/height; reference asset IDs and hashes; safety decisions; software/container digests; output SHA-256; retry lineage.
- Do not expose raw MinIO credentials or permanent public objects. Return short-lived signed URLs or the existing authenticated CDN/S3 API URL.
- Suggested lifecycle: failed/intermediate objects 24 hours, unclaimed generated assets 30 days, retained chat assets according to tenant policy. Keep metadata longer than the binary only if privacy policy permits.

## 7. Security

- No public ComfyUI ingress, NodePort, or LoadBalancer. Bind behind ClusterIP and NetworkPolicy.
- Gateway authenticates users and passes a signed internal identity/tenant context to image-api. Image-api uses its own MinIO credentials restricted to the generated-images bucket/prefix.
- Disable arbitrary workflow submission, filesystem paths, URLs, and custom-node installation. Reference images should be existing authenticated asset IDs or tightly validated uploads, not worker-side arbitrary URL fetches (SSRF risk).
- Run non-root, read-only root filesystem where images permit, drop capabilities, disallow privilege escalation, and do not mount the host container socket or Kubernetes token.
- Keep prompt and source-image logs out of normal application logs. Log job IDs, model/workflow IDs, timings, sizes, and error classes. Treat prompts, input images, face images, and EXIF as tenant data; strip EXIF unless preservation is explicitly requested.
- Enforce tenant quotas, max pixels, max references, concurrency, retention, moderation policy, and per-job cost/time ceilings at image-api.

## 8. Failure behavior

| Failure | Required behavior |
|---|---|
| ComfyUI CUDA OOM | Mark attempt failed/retryable, terminate and recreate worker to clear CUDA state, retry once with known-safe resolution/offload profile, then fail explicitly. Never immediately loop. |
| Ollama OOM | Stop routing local work, restart only Ollama through its owner controller, and prefer cloud. Do not start image-worker until Ollama pod/device handles are gone. |
| Simultaneous requests | Mongo claim admits one active GPU image job; remaining image jobs queue. Text goes to cloud unless explicitly local-only. |
| GPU disappears / `nvidia-smi` fails | Anton marks GPU unhealthy, scales all GPU owners to zero, blocks transitions, and alerts. Recovery should be an explicit staged device/plugin/node procedure; image automation must not power-cycle or reset PCI automatically. |
| Node/k3s reboot | Mongo jobs with expired leases return to queued/retry state; partial local output is discarded; worker is re-created only after device health and ownership reconciliation. |
| Job interrupted | Idempotency key and attempt number prevent duplicate published assets; only commit `completed` after checksum-verified MinIO upload. |
| MinIO unavailable | Keep result in bounded staging, use exponential backoff, report `uploading`; stop admitting jobs before disk fills. Never report completion with only a pod-local file. |
| Model download incomplete | Download to `.partial`, verify pinned digest and free-space floor, atomic rename; worker readiness fails if required manifest/digest is absent. |
| Disk full | Alert at 80/90%, reject new jobs before the hard floor, clean only TTL-governed intermediates, never delete model or tenant assets ad hoc. |
| Cloud unavailable during image mode | Local-only text queues or returns 503/busy. Optionally finish the active image, then switch back based on configured priority; do not force concurrent GPU use. |

## 9. Phased implementation

1. **Stabilize/measure:** add DCGM or equivalent GPU metrics; document the Anton mode transition; plan an R580+ driver and current device-plugin maintenance upgrade; add resource requests/limits to STT. Do not combine the driver upgrade with the first image test.
2. **Single image smoke test:** create the static model PV and image-worker Deployment, pre-stage only FLUX.2 Klein 4B with hashes/license, manually use the existing controller to select image mode, and generate one 1024x1024 image. Record cold load, warm generation, peak VRAM/RAM, and GPU recovery.
3. **Private image API:** deploy CPU-only image-api, fixed workflow registry, Mongo job collection, idempotency, status, cancellation, retry policy, and ClusterIP-only access.
4. **MinIO:** create least-privilege bucket credentials and lifecycle; upload image plus provenance metadata; return signed/CDN asset URLs.
5. **Bandit integration:** add `generate_image`, async status events, model aliases/capabilities, tenant quotas, and cloud text routing while image mode is active.
6. **Automated arbitration:** extend Anton to support `image`, durable leases, bounded drain, device-handle health gates, warm idle timeout, and prior-mode restoration. Run forced-failure drills.
7. **Quality expansion:** benchmark Z-Image-Turbo, then a vetted Qwen-Image-2512 quantized/offload workflow. Promote only from measured quality/latency/VRAM data and license records.
8. **Second GPU later:** add a second labeled worker and let Mongo claims select `workerId`; the API and object contract do not change. At that point, reconsider a broker only if Mongo claim throughput or routing is inadequate.

## 10. Risks and blockers before production

1. Driver branch R570 is old for September 2026 and NVIDIA's current compatibility table puts CUDA 13.x on R580+. Current ComfyUI documentation recommends CUDA 13 wheels. Either pin a CUDA 12.8/Blackwell-compatible image now or upgrade the host driver in a separate tested maintenance window; do not accidentally deploy a CUDA 13 image against the current host.
2. Device plugin `v0.16.0` is far behind current `v0.20.0`. Upgrade deliberately and validate the GPU disappearance/re-registration path.
3. The unexplained ~2.8 GiB VRAM/device-handle state while `nvidia-smi` lists no processes needs a repeatable metric and recovery runbook before automated switching.
4. Anton already controls Ollama and Voice modes. A second scaler would race it; image mode must be integrated there.
5. STT has no resource requests/limits and consumes significant RAM. Bound it so image CPU offload cannot be starved.
6. No NetworkPolicy currently exists. Confirm CNI enforcement before treating the draft policy as a security boundary.
7. Ollama's 24-hour keepalive should be reduced or explicitly unloaded when it participates in switching.
8. The current Ollama Deployment reports an old Available condition while desired replicas are zero; dashboards should use desired/current/ready replicas, not the condition alone.
9. MinIO capacity is much smaller than the GPU node's free NVMe and is shared. Set quotas/lifecycle and monitor usable distributed capacity before retaining large volumes of generated images.

## References

- [Kubernetes GPU scheduling and whole-number extended resources](https://kubernetes.io/docs/tasks/manage-gpus/scheduling-gpus/)
- [NVIDIA time-slicing limitations](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/24.9.2/gpu-sharing.html)
- [Ollama `keep_alive`, including immediate unload](https://docs.ollama.com/api/generate)
- [NVIDIA CUDA/driver compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html)
- [Current NVIDIA device-plugin releases](https://github.com/NVIDIA/k8s-device-plugin/releases)
- [ComfyUI upstream](https://github.com/Comfy-Org/ComfyUI)
