# DIARIZATION

Self-hosted speech-to-text + speaker diarization as a Dockerized Python FastAPI service.
Send an audio file, get back the transcript with word timestamps and who spoke when.

- STT: [`nvidia/parakeet-tdt-0.6b-v3`](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (NeMo), multilingual, word timestamps
- Diarization: [`pyannote/speaker-diarization-community-1`](https://huggingface.co/pyannote/speaker-diarization-community-1) (pyannote.audio 4.0.7)
- Runs fully offline once the models are downloaded; no Hugging Face token at runtime.

This is a **batch** API: one request carries a whole recording and returns when it is
done. For live captions with speaker labels over WebSocket, see [`stream/`](stream/README.md)
(Nemotron 3.5 streaming ASR + Nemotron-3-Diarization, ~0.2-0.55 s word latency). It is fast, though: about 40x real time per job (a 30-minute
call takes about 45 s), and about 55 audio-minutes per minute with two jobs in flight
on two RTX 3090s capped at 300 W.

## Quick start (Docker Compose)

Needs an NVIDIA GPU (two are assumed, see below), the NVIDIA driver and the
NVIDIA Container Toolkit.

```bash
./gen_token.sh                                   # creates asr.env (ASR_TOKEN=..., mode 600)
docker compose build                             # image asr-service:0.2.0
HF_TOKEN_FILE=/path/to/hf_token ./prefetch.sh    # one-off: models -> the asr-models volume
docker compose up -d
curl -s http://127.0.0.1:9100/health             # 200 once both model pools are loaded (a few min)
```

The Hugging Face token must have accepted the pyannote community-1 terms. It is only used by
`prefetch.sh`, passed through a temporary mode-600 env file, and never stored in the image.

Without Compose, `./run.sh [image-tag]` starts the same container with `docker run` and
waits for `/health`.

## API

- `GET /health`: 200 `{"status":"ok","models":{...}}` once the models are loaded; 503 while loading or after a fatal error.
- `POST /v1/transcribe?diarize=true&num_speakers=&min_speakers=&max_speakers=`
  - Header `Authorization: Bearer $ASR_TOKEN`; the body is the raw audio bytes (anything ffmpeg decodes: wav, mp3, flac, ogg, m4a, webm).
  - Response: `{model, duration_s, language:"auto", text, speakers, segments[{speaker,start,end,text}], words[{word,start,end,speaker}]}`.
    With `diarize=false`, `speakers` is `[]` and every `speaker` field is `null`.
  - Errors: 401 bad or missing token; 413 body > 500 MB or audio > 2 h (checked with ffprobe before any GPU work);
    422 undecodable or empty body; 503 + `Retry-After: 15` when `MAX_JOBS` jobs are already in flight;
    500 internal error (a CUDA fault also makes the process exit, and Docker restarts it).

```bash
ASR_TOKEN=$(sed -n 's/^ASR_TOKEN=//p' asr.env)
curl -H "Authorization: Bearer $ASR_TOKEN" --data-binary @call.mp3 \
  "http://127.0.0.1:9100/v1/transcribe?num_speakers=2"
```

## How it works

- Audio is decoded to 16 kHz mono with ffmpeg.
- Models load once at startup as pools of independent instances that stay on the GPUs
  (`STT_REPLICAS` over `STT_DEVICES`, `DIAR_REPLICAS` over `DIAR_DEVICES`). Neither model is
  thread-safe, so each job checks out one instance of each, and different jobs run in parallel.
- Within a job, STT and diarization run concurrently; words are then assigned to speakers by time overlap.
- Long audio is transcribed in overlapping chunks (`CHUNK_S` 300 s, `OVERLAP_S` 10 s); each word
  is kept only from the chunk whose core covers it, so chunk seams do not duplicate or drop words.
- `MAX_JOBS` is a non-blocking admission limit: extra requests get 503 + `Retry-After`.

## Configuration (env)

Defaults below are what `compose.yaml` and `run.sh` set; `app.py`'s own fallbacks are
`DIAR_REPLICAS=3` and `MAX_JOBS=3`, which are too much for 2x 3090 at 300 W. The defaults are
single-user: one job at a time, idling at ~3.9 GB on GPU 0 (vs ~20 GB with two of each), with the
same per-file speed. For throughput use `STT_REPLICAS=2 DIAR_REPLICAS=2 DIAR_DEVICES=cuda:0,cuda:1 MAX_JOBS=2`.

| Variable | Default | Meaning |
|----------|---------|---------|
| `ASR_TOKEN` | (asr.env) | Bearer token clients must send |
| `STT_REPLICAS` / `STT_DEVICES` | `1` / `cuda:0` | Parakeet instances and the GPUs they round-robin over |
| `DIAR_REPLICAS` / `DIAR_DEVICES` | `1` / `cuda:0` | pyannote instances and their GPUs |
| `MAX_JOBS` | `1` | Concurrent jobs admitted |
| `CHUNK_S`, `OVERLAP_S` | `300`, `10` | STT chunking for long audio |
| `MAX_BYTES`, `MAX_SECONDS` | 500 MB, 2 h | Request limits |
| `RETRY_AFTER_S` | `15` | `Retry-After` on 503 |
| `STT_MODEL`, `DIARIZE_MODEL` | see above | Model repos (set for both prefetch and run) |

With a single GPU, set `STT_DEVICES=cuda:0 DIAR_DEVICES=cuda:0` and change `device_ids` in
`compose.yaml` (or `--gpus` in `run.sh`).

## Files

| File | Purpose |
|------|---------|
| `app.py` | FastAPI service |
| `Dockerfile`, `requirements.txt`, `.dockerignore` | Image build. torch 2.8.0 cu128 is installed first, then the pins. `requirements.lock` is the image's `pip freeze`. |
| `compose.yaml` | Docker Compose service (GPUs, models volume, healthcheck, log rotation) |
| `run.sh` | Same container with plain `docker run`, then waits for `/health` |
| `prefetch.py`, `prefetch.sh` | One-off model download into the `asr-models` volume |
| `gen_token.sh` | Create (or `--rotate`) the bearer token in `asr.env` |
| `k8s-service.yaml` | Selector-less Service + Endpoints so k8s pods can reach the host container |
| `stream/` | Live WebSocket service (separate container, port 9101); see `stream/README.md` |
| `testdata/` | Test helpers: `tx.sh` (one request), `concurrent.sh`, `careful-concurrency.sh`, GPU/CPU monitors, `logcheck.sh` |

Test clips are not in git (large). The ones used were NASA STS-41C mission audio (public domain)
trimmed to 2, 30 and 118 minutes with `testdata/trim.py`, plus a LibriVox recording; put any
audio in `testdata/` and point `tx.sh` at it.

## Operations

```bash
docker compose logs -f asr     # JSON lines; one "request" line per call, no audio or tokens
docker compose down
./gen_token.sh --rotate && docker compose up -d     # rotate the token (update clients)

# update code or dependencies: bump the tag in compose.yaml / run.sh / prefetch.sh, then
docker compose build && docker compose up -d
docker run --rm asr-service:<tag> cat /opt/requirements.lock > requirements.lock
```

## Measured (2x RTX 3090, 300 W caps)

- Default (1 of each, 1 job): 30-min file in 42.5 s, 2-min in 4.3 s; idle 3.9 GB on GPU 0.
- 2 of each, 2 concurrent jobs: 55 audio-minutes per minute; 3 jobs: 52 and GPU 0 peaked at 23.0 of 24 GB.
- Per job the models peak at about 6.7 GB on GPU 0 and 2.4 GB on GPU 1; idle about 3 GB and 0.5 GB.
- Without the power caps, three concurrent jobs tripped a 1200 W PSU and froze the host.
  Cap both GPUs first, e.g. `nvidia-smi -pl 300`.

## Known behaviour

- NeMo's CUDA-graph greedy decoder is disabled in `app.py`: with it on, the second request
  failed with `CUDA error: an illegal memory access`, which kills the CUDA context. The eager
  decoder is about 20% slower (RTF 0.019 -> 0.024), still more than 40x real time.
- `language` is always `"auto"`: Parakeet v3 does not report the language it detected.

## License

The code in this repository is MIT licensed (see `LICENSE`). The model weights are not
included: they are downloaded by `prefetch.sh` and are covered by their own licenses and
terms, listed on the `nvidia/parakeet-tdt-0.6b-v3` and `pyannote/speaker-diarization-community-1`
model cards.
