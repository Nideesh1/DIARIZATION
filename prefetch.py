"""One-off: download both models into the HF cache on the models volume.

Run once (and after changing models) with HF_TOKEN in the environment and
HF_HUB_OFFLINE=0. The service itself then runs offline without any token.
"""
import os

from huggingface_hub import snapshot_download

token = os.environ["HF_TOKEN"]
# NeMo only needs the .nemo archive; skip the repo's extra safetensors/gguf (~3 GB).
for repo, allow in ((os.environ.get("STT_MODEL", "nvidia/parakeet-tdt-0.6b-v3"),
                     ["*.nemo", "*.json", "README.md"]),
                    (os.environ.get("DIARIZE_MODEL", "pyannote/speaker-diarization-community-1"),
                     None)):
    path = snapshot_download(repo, token=token, allow_patterns=allow)
    print(f"cached {repo} -> {path}", flush=True)
