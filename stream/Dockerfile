# asr-stream: live speech-to-text + speaker labels over WebSocket (port 9101).
# NeMo Speech (main, pinned below) + Nemotron 3.5 streaming ASR + Nemotron-3-Diarization.
# Separate from the batch asr-service, which pins NeMo 3.0.0 (too old for these models).
# Model weights are NOT in the image: they live on the `asr-stream-models` volume (HF cache).
FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libsndfile1 git build-essential curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /usr/local/bin/uv

ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never PYTHONUNBUFFERED=1
# NeMo Speech main at the commit the models were validated with (2026-09-28).
ARG NEMO_COMMIT=cf724ac337d1ebc7d0dda1e23fb80916f52927a5
RUN git init -q /opt/Speech && cd /opt/Speech \
    && git remote add origin https://github.com/NVIDIA-NeMo/Speech.git \
    && git fetch -q --depth 1 origin "$NEMO_COMMIT" && git checkout -q FETCH_HEAD
WORKDIR /opt/Speech
# Driver 595 = CUDA 13.2, so the cu13 torch wheels.
RUN uv sync --python /usr/local/bin/python3.13 --extra asr --extra cu13 --no-dev \
    && uv pip install --python .venv/bin/python "fastapi==0.141.1" "uvicorn[standard]==0.54.0" \
    && uv pip freeze --python .venv/bin/python > /opt/requirements.lock

RUN useradd -m -u 10001 asr
WORKDIR /app
COPY app.py warmup.wav /app/
USER 10001
ENV PATH=/opt/Speech/.venv/bin:$PATH \
    HF_HOME=/models/hf \
    NEMO_CACHE_DIR=/models/nemo \
    TORCH_HOME=/models/torch \
    TRITON_CACHE_DIR=/models/triton

EXPOSE 9101
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9101", "--workers", "1", "--no-access-log", "--ws-max-size", "1048576"]
