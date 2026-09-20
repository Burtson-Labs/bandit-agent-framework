# Burtson image API

Private, asynchronous adapter in front of ComfyUI. It accepts a stable image
generation contract, owns a small in-process queue, submits a versioned workflow,
and writes images plus provenance metadata to MinIO.

The service has no public ingress and no Kubernetes credentials. Anton authenticates
callers, claims the single GPU, and proxies `/image/generations` and job requests.
ComfyUI is also ClusterIP-only.

The initial production model is FLUX.1 Schnell because its Apache-2.0 license is
commercially permissive and its four-step workflow is a good fit for an on-demand
single RTX 5090. Model files are mounted, not baked into either image.
