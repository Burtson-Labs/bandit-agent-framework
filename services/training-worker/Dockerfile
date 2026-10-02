# Burtson Training Studio worker: Unsloth/TRL SFT (LoRA/QLoRA) on Blackwell (sm_120, CUDA 12.8),
# llama.cpp GGUF convert + quantize, a private Ollama for evaluation, Node 22 for BanditBench.
# Licences: torch BSD, Unsloth/TRL/PEFT/transformers/datasets Apache-2.0, bitsandbytes/llama.cpp/Ollama MIT.

# --- llama.cpp tools (CPU build: convert + quantize need no GPU) -------------------------------
FROM ubuntu:24.04 AS llama
ARG LLAMA_CPP_TAG=v0.5.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git build-essential cmake \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${LLAMA_CPP_TAG} https://github.com/ggml-org/llama.cpp /opt/llama.cpp \
 && cmake -S /opt/llama.cpp -B /opt/llama.cpp/build -DGGML_CUDA=OFF -DBUILD_SHARED_LIBS=OFF \
 && cmake --build /opt/llama.cpp/build --target llama-quantize -j"$(nproc)" \
 && rm -rf /opt/llama.cpp/.git

# --- runtime ------------------------------------------------------------------------------
FROM nvidia/cuda:12.8.1-cudnn-devel-ubuntu24.04
ARG OLLAMA_VERSION=v0.35.0
ARG NODE_MAJOR=22
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_BREAK_SYSTEM_PACKAGES=1 \
    HF_HUB_ENABLE_HF_TRANSFER=1 LLAMA_CPP_DIR=/opt/llama.cpp TORCH_CUDA_ARCH_LIST=12.0
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-dev git ca-certificates curl zstd build-essential \
 && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && corepack enable \
 && curl -fsSL https://github.com/ollama/ollama/releases/download/${OLLAMA_VERSION}/ollama-linux-amd64.tar.zst | zstd -d | tar -x -C /usr \
 && rm -rf /var/lib/apt/lists/*
RUN pip install torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128
COPY requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt \
 && pip freeze > /opt/requirements.lock
COPY --from=llama /opt/llama.cpp /opt/llama.cpp
RUN pip install /opt/llama.cpp/gguf-py
WORKDIR /app
COPY worker ./worker
ENTRYPOINT ["python3", "-m", "worker.main"]
