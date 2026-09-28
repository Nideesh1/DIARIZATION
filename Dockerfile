# ASR service: Parakeet TDT 0.6B v3 (NeMo) + pyannote community-1 diarization.
# CUDA comes from the PyTorch cu128 wheels (they bundle the CUDA runtime), so a
# slim Python base is enough; the host only needs the NVIDIA driver (595, CUDA 13.2).
# Model weights are NOT in the image: they live on the `asr-models` volume (HF cache),
# downloaded once by prefetch.py with a HF token, then used offline.
FROM python:3.12-slim

# ffmpeg: decode every input format (wav/mp3/flac/ogg/m4a/webm) to 16 kHz mono.
# libsndfile: soundfile (NeMo). build-essential: a few NeMo deps compile at install.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libsndfile1 build-essential git \
    && rm -rf /var/lib/apt/lists/*

ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1

# torch first, from the CUDA 12.8 index, pinned; everything after must accept it.
RUN pip install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128

COPY requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt \
    && pip freeze > /opt/requirements.lock   # exact resolved versions, for the record

# Non-root. HOME is where caches would go if anything tried to write one.
RUN useradd -m -u 10001 asr
WORKDIR /app
COPY app.py prefetch.py /app/
USER 10001

ENV HF_HOME=/models/hf \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    NEMO_CACHE_DIR=/models/nemo \
    TORCH_HOME=/models/torch

EXPOSE 9100
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9100", "--workers", "1", "--no-access-log"]
