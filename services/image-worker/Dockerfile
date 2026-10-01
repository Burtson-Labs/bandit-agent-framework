ARG CUDA_IMAGE=nvidia/cuda:12.8.1-runtime-ubuntu24.04
FROM ${CUDA_IMAGE}

ARG COMFYUI_COMMIT=96be9a139d68c1d45ee9380e2aad2746ecf6bc48
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    VIRTUAL_ENV=/opt/venv \
    HOME=/home/comfy
ENV PATH="${VIRTUAL_ENV}/bin:${PATH}"

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv git curl libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv "$VIRTUAL_ENV"

WORKDIR /opt/ComfyUI
# constraints.txt pins every Python package to the versions of the image this
# was last validated as (ComfyUI's own requirements are unpinned).
COPY constraints.txt /tmp/constraints.txt
RUN git clone https://github.com/Comfy-Org/ComfyUI.git . \
 && git checkout "$COMFYUI_COMMIT" \
 && rm -rf .git \
 && pip install --upgrade pip \
 && pip install --index-url https://download.pytorch.org/whl/cu128 --extra-index-url https://pypi.org/simple \
      -c /tmp/constraints.txt torch torchvision torchaudio \
 && pip install -c /tmp/constraints.txt -r requirements.txt

RUN printf 'comfy:x:10001:10001:ComfyUI:/home/comfy:/usr/sbin/nologin\n' >> /etc/passwd \
 && printf 'comfy:x:10001:\n' >> /etc/group \
 && mkdir -p /home/comfy/.cache models input output temp \
 && chown -R 10001:10001 /opt/ComfyUI /home/comfy "$VIRTUAL_ENV"

# Burtson's own people-swap preprocessing nodes (SAM 2.1 tracking via
# transformers, mask shaping, face crops). No third-party custom nodes.
COPY --chown=10001:10001 custom_nodes/burtson_people /opt/ComfyUI/custom_nodes/burtson_people

USER 10001:10001
EXPOSE 8188
ENTRYPOINT ["python", "main.py"]
CMD ["--listen", "0.0.0.0", "--port", "8188", "--disable-auto-launch"]
