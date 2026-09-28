"""Self-hosted speech-to-text + speaker diarization over HTTP.

POST /v1/transcribe  raw audio bytes -> words, timestamps, speakers (JSON)
GET  /health         200 once both models are loaded, 503 while loading

Models load ONCE at startup, as POOLS of independent instances that stay on the GPUs:
  STT          nvidia/parakeet-tdt-0.6b-v3 (NeMo), word timestamps
               STT_REPLICAS instances, round-robin over STT_DEVICES
  diarization  pyannote/speaker-diarization-community-1
               DIAR_REPLICAS instances, round-robin over DIAR_DEVICES
Neither model is thread-safe, so a job checks an instance out of each pool, uses it
exclusively, and returns it; different jobs run truly in parallel on different
instances. Within a job, STT and diarization run concurrently (both only read the
decoded audio). MAX_JOBS is the admission limit (non-blocking: 503 + Retry-After).
Weights come from the HF cache on the models volume (HF_HUB_OFFLINE=1): no network
and no Hugging Face token at runtime.

Long audio is transcribed in CHUNK_S windows overlapping by OVERLAP_S; each word is
kept only from the chunk whose "core" (the window minus half the overlap at each
edge) contains its midpoint, so nothing is dropped or duplicated at the seams and GPU
memory stays bounded for 2-hour files.

Never logs audio or tokens.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import numpy as np
from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse

# ---------------------------------------------------------------- config
TOKEN = os.environ.get("ASR_TOKEN", "")
STT_MODEL = os.environ.get("STT_MODEL", "nvidia/parakeet-tdt-0.6b-v3")
DIARIZE_MODEL = os.environ.get("DIARIZE_MODEL", "pyannote/speaker-diarization-community-1")



def _devices(name: str, legacy: str, default: str) -> list[str]:
    """Comma-separated device list; falls back to the old single-device variable."""
    raw = os.environ.get(name) or os.environ.get(legacy) or default
    devs = [d.strip() for d in raw.split(",") if d.strip()]
    if not devs:
        raise ValueError(f"{name} is empty")
    return devs


STT_DEVICES = _devices("STT_DEVICES", "STT_DEVICE", "cuda:0")
DIAR_DEVICES = _devices("DIAR_DEVICES", "DIARIZE_DEVICE", "cuda:0,cuda:0,cuda:1")
STT_REPLICAS = max(1, int(os.environ.get("STT_REPLICAS", "2")))
DIAR_REPLICAS = max(1, int(os.environ.get("DIAR_REPLICAS", "3")))
MAX_BYTES = int(os.environ.get("MAX_BYTES", str(500 * 1024 * 1024)))   # 500 MB
MAX_SECONDS = float(os.environ.get("MAX_SECONDS", "7200"))             # 2 h
MAX_JOBS = max(1, int(os.environ.get("MAX_JOBS", "3")))
# Optional hard cap on this process's PyTorch allocator per GPU, "cuda:1=2600,cuda:0=16000"
# (MiB; the ~0.35 GB CUDA context comes on top). At the cap the allocator frees its cache
# and retries instead of growing, so a GPU shared with another server is never squeezed.
GPU_MEM_LIMIT_MIB = {k.strip(): int(v) for k, v in (
    kv.split("=", 1) for kv in os.environ.get("GPU_MEM_LIMIT_MIB", "").split(",") if "=" in kv)}
CHUNK_S = float(os.environ.get("CHUNK_S", "300"))
OVERLAP_S = float(os.environ.get("OVERLAP_S", "10"))
RETRY_AFTER_S = os.environ.get("RETRY_AFTER_S", "15")
SR = 16_000

# ---------------------------------------------------------------- logging (JSON lines)
class JsonFormatter(logging.Formatter):
    def format(self, r: logging.LogRecord) -> str:
        d = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r.created)),
             "level": r.levelname, "msg": r.getMessage()}
        if r.name != "asr":
            d["logger"] = r.name
        d.update(getattr(r, "extra_fields", {}))
        if r.exc_info:
            d["exc"] = self.formatException(r.exc_info)
        return json.dumps(d)

log = logging.getLogger("asr")
_h = logging.StreamHandler(sys.stdout)
_h.setFormatter(JsonFormatter())
log.handlers[:] = [_h]
log.setLevel(logging.INFO)
log.propagate = False


def _jsonify_logging() -> None:
    """Route third-party loggers (uvicorn, NeMo, pyannote, warnings) through the JSON
    handler so every line on stdout is one JSON object. NeMo installs its own plain-text
    handlers on import, so this runs again after the models are loaded."""
    import warnings
    logging.captureWarnings(True)
    # known-benign per-request noise from pyannote's pooling / TF32 notice
    warnings.filterwarnings("ignore", message=r"std\(\): degrees of freedom")
    warnings.filterwarnings("ignore", message=r".*TensorFloat-32.*")
    root = logging.getLogger()
    root.handlers[:] = [_h]
    root.setLevel(logging.WARNING)
    for name in ("uvicorn", "uvicorn.error", "py.warnings", "nemo_logger", "nemo",
                 "pyannote", "lightning", "pytorch_lightning", "lightning.pytorch"):
        lg = logging.getLogger(name)
        lg.handlers[:] = []
        lg.propagate = True
        lg.setLevel(logging.INFO if name.startswith("uvicorn") else logging.WARNING)


_jsonify_logging()

def logj(msg: str, **fields: Any) -> None:
    log.info(msg, extra={"extra_fields": fields})

# ---------------------------------------------------------------- models
state: dict[str, Any] = {"ready": False, "error": None}
_slots = threading.BoundedSemaphore(MAX_JOBS)   # jobs in flight (non-blocking acquire)
# NeMo's transcribe() and the pyannote pipeline mutate model state per call and are not
# thread-safe, so every instance is used by one thread at a time: a job takes an
# instance out of the pool's queue and puts it back when done. With MAX_JOBS <= the
# pool sizes a job never waits; with fewer replicas it waits (blocking get) for one.
_stt_pool: "queue.Queue[Any]" = queue.Queue()
_diar_pool: "queue.Queue[Any]" = queue.Queue()
# Diarization of a job runs in its own thread, concurrently with that job's STT.
_diar_exec = ThreadPoolExecutor(max_workers=MAX_JOBS, thread_name_prefix="diar")


class _Lease:
    """`with _Lease(pool) as (device, model):` -- exclusive use of one pooled instance."""

    def __init__(self, pool: "queue.Queue[Any]") -> None:
        self.pool, self.inst = pool, None

    def __enter__(self) -> Any:
        self.inst = self.pool.get()
        return self.inst

    def __exit__(self, *exc: Any) -> None:
        self.pool.put(self.inst)


class Undecodable(Exception):
    """ffmpeg could not turn the body into audio."""


def _load_stt(nemo_asr: Any, device: str) -> Any:
    stt = nemo_asr.models.ASRModel.from_pretrained(STT_MODEL, map_location=device)
    stt = stt.to(device).eval()
    # Configure decoding once, up front: word timestamps on, and NeMo's CUDA-graph
    # greedy decoder OFF. With it on, the service hit "CUDA error: an illegal memory
    # access" on the 2nd request (the graphs are captured on one executor thread and
    # replayed from others / after the allocator released blocks), which poisons the
    # CUDA context for good. The eager decoder costs little at batch_size=1.
    from omegaconf import open_dict
    dec = stt.cfg.decoding
    with open_dict(dec):
        dec.compute_timestamps = True
        dec.greedy.use_cuda_graph_decoder = False
    stt.change_decoding_strategy(dec, verbose=False)
    return stt


def _load_models() -> None:
    try:
        import torch
        t0 = time.time()
        import nemo.collections.asr as nemo_asr
        from pyannote.audio import Pipeline
        _jsonify_logging()   # NeMo installs plain-text handlers on import
        for dev, mib in GPU_MEM_LIMIT_MIB.items():
            total = torch.cuda.get_device_properties(torch.device(dev)).total_memory
            torch.cuda.set_per_process_memory_fraction(min(1.0, mib * 2**20 / total),
                                                       torch.device(dev))
        stt_placement = [STT_DEVICES[i % len(STT_DEVICES)] for i in range(STT_REPLICAS)]
        diar_placement = [DIAR_DEVICES[i % len(DIAR_DEVICES)] for i in range(DIAR_REPLICAS)]
        for dev in stt_placement:
            _stt_pool.put((dev, _load_stt(nemo_asr, dev)))
        for dev in diar_placement:
            diar = Pipeline.from_pretrained(DIARIZE_MODEL)
            diar.to(torch.device(dev))
            _diar_pool.put((dev, diar))
        _jsonify_logging()   # in case loading added handlers
        state.update(ready=True)
        logj("models loaded", seconds=round(time.time() - t0, 1),
             stt=STT_MODEL, stt_devices=stt_placement,
             diarization=DIARIZE_MODEL, diarization_devices=diar_placement,
             max_jobs=MAX_JOBS, gpu_mem_limit_mib=GPU_MEM_LIMIT_MIB)
    except Exception as e:  # noqa: BLE001 -- surfaced via /health
        state["error"] = f"{type(e).__name__}: {e}"
        log.exception("model load failed")


app = FastAPI(title="asr", docs_url=None, redoc_url=None, openapi_url=None)


@app.on_event("startup")
def _startup() -> None:
    threading.Thread(target=_load_models, daemon=True).start()


# ---------------------------------------------------------------- helpers
def _err(code: int, message: str, rid: str, headers: dict | None = None) -> JSONResponse:
    return JSONResponse({"error": message, "request_id": rid}, status_code=code, headers=headers)


def _authorized(request: Request) -> bool:
    h = request.headers.get("authorization", "")
    if not TOKEN or not h.startswith("Bearer "):
        return False
    return hmac.compare_digest(h[7:].encode(), TOKEN.encode())


def _probe_duration(path: str) -> float | None:
    """Container duration via ffprobe; None if the file isn't decodable audio."""
    p = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "format=duration:stream=codec_type",
         "-of", "json", path],
        capture_output=True, text=True, timeout=60)
    if p.returncode != 0:
        return None
    try:
        d = json.loads(p.stdout)
    except json.JSONDecodeError:
        return None
    if not d.get("streams"):
        return None
    try:
        return float(d.get("format", {}).get("duration"))
    except (TypeError, ValueError):
        return -1.0   # audio stream present but no container duration (e.g. some webm)


def _decode(path: str) -> np.ndarray | None:
    """Decode anything ffmpeg understands to 16 kHz mono float32."""
    p = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-vn", "-ac", "1",
         "-ar", str(SR), "-f", "f32le", "pipe:1"],
        capture_output=True, timeout=1800)
    if p.returncode != 0 or not p.stdout:
        return None
    return np.frombuffer(p.stdout, dtype=np.float32).copy()


def _transcribe_words(audio: np.ndarray, stats: dict) -> list[dict]:
    """Parakeet over overlapping chunks -> [{word, start, end}] in absolute seconds."""
    t0 = time.time()
    with _Lease(_stt_pool) as (dev, stt):
        stats["stt_wait_s"] = round(time.time() - t0, 2)
        stats["stt_device"] = dev
        words = _transcribe_chunks(stt, audio)
    stats["stt_s"] = round(time.time() - t0, 2)
    return words


def _transcribe_chunks(stt: Any, audio: np.ndarray) -> list[dict]:
    n = len(audio)
    chunk, step = int(CHUNK_S * SR), int((CHUNK_S - OVERLAP_S) * SR)
    half_ov = OVERLAP_S / 2
    words: list[dict] = []
    starts = list(range(0, max(n - int(OVERLAP_S * SR), 1), step)) or [0]
    for i, s in enumerate(starts):
        seg = audio[s:s + chunk]
        if len(seg) < SR // 10:          # < 0.1 s tail: nothing to transcribe
            continue
        off = s / SR
        core_lo = off + (half_ov if i > 0 else 0.0)
        core_hi = off + len(seg) / SR - (half_ov if i < len(starts) - 1 else 0.0)
        out = stt.transcribe([seg], timestamps=True, batch_size=1, verbose=False)
        hyp = out[0] if isinstance(out, list) else out
        hyp = hyp[0] if isinstance(hyp, list) else hyp
        for w in (getattr(hyp, "timestamp", None) or {}).get("word", []):
            ws, we = float(w["start"]) + off, float(w["end"]) + off
            mid = (ws + we) / 2
            if core_lo <= mid < core_hi or (i == len(starts) - 1 and mid >= core_lo):
                words.append({"word": w["word"], "start": round(ws, 3), "end": round(we, 3)})
    return words


def _diarize(audio: np.ndarray, num_speakers: int | None, min_speakers: int | None,
             max_speakers: int | None, stats: dict) -> list[tuple[float, float, str]]:
    import torch
    kw: dict[str, int] = {}
    if num_speakers:
        kw["num_speakers"] = num_speakers
    else:
        if min_speakers:
            kw["min_speakers"] = min_speakers
        if max_speakers:
            kw["max_speakers"] = max_speakers
    wav = torch.from_numpy(audio).unsqueeze(0)
    t0 = time.time()
    with _Lease(_diar_pool) as (dev, diar):
        stats["diar_wait_s"] = round(time.time() - t0, 2)
        stats["diar_device"] = dev
        out = diar({"waveform": wav, "sample_rate": SR}, **kw)
    stats["diar_s"] = round(time.time() - t0, 2)
    # community-1: exclusive diarization (one speaker at a time) aligns cleanly with
    # word timestamps; fall back to the regular one on older pipeline outputs.
    ann = getattr(out, "exclusive_speaker_diarization", None) \
        or getattr(out, "speaker_diarization", None) or out
    return [(float(t.start), float(t.end), str(spk))
            for t, _, spk in ann.itertracks(yield_label=True)]


def _assign(words: list[dict], turns: list[tuple[float, float, str]]) -> None:
    """Speaker whose turn contains the word's midpoint; else the nearest turn."""
    turns = sorted(turns)
    for w in words:
        mid = (w["start"] + w["end"]) / 2
        spk = next((s for a, b, s in turns if a <= mid < b), None)
        if spk is None and turns:
            spk = min(turns, key=lambda t: min(abs(mid - t[0]), abs(mid - t[1])))[2]
        w["speaker"] = spk


def _segments(words: list[dict]) -> list[dict]:
    segs: list[dict] = []
    for w in words:
        if segs and segs[-1]["speaker"] == w["speaker"] and w["start"] - segs[-1]["end"] < 1.5:
            s = segs[-1]
            s["end"] = w["end"]
            s["text"] += " " + w["word"]
        else:
            segs.append({"speaker": w["speaker"], "start": w["start"],
                         "end": w["end"], "text": w["word"]})
    return segs


def _run(path: str, duration_hint: float, diarize: bool, num_speakers: int | None,
         min_speakers: int | None, max_speakers: int | None) -> dict:
    audio = _decode(path)
    if audio is None or len(audio) == 0:
        raise Undecodable()
    duration = len(audio) / SR
    if duration > MAX_SECONDS:
        raise OverflowError(duration)
    # STT and diarization only read `audio`: run them concurrently on their own
    # pooled instances. The diarization future is always awaited, so an error in
    # either one (including a CUDA fault) surfaces here.
    stats: dict[str, Any] = {}
    fut = _diar_exec.submit(_diarize, audio, num_speakers, min_speakers,
                            max_speakers, stats) if diarize else None
    try:
        words = _transcribe_words(audio, stats)
    finally:
        turns = fut.result() if fut is not None else None
    speakers: list[str] = []
    if diarize:
        _assign(words, turns)
        speakers = sorted({w["speaker"] for w in words if w["speaker"]})
    else:
        for w in words:
            w["speaker"] = None
    return {
        "model": {"stt": STT_MODEL.split("/")[-1],
                  "diarization": DIARIZE_MODEL if diarize else None},
        "duration_s": round(duration, 3),
        # Parakeet v3 auto-detects among 25 European languages but does not report
        # which; "auto" says so honestly rather than guessing "en".
        "language": "auto",
        "text": " ".join(w["word"] for w in words),
        "speakers": speakers,
        "segments": _segments(words),
        "words": words,
        "_stats": stats,   # popped by the route: goes to the log, not the response
    }


# ---------------------------------------------------------------- routes
@app.get("/health")
def health() -> JSONResponse:
    if state["ready"]:
        return JSONResponse({"status": "ok",
                             "models": {"stt": STT_MODEL, "diarization": DIARIZE_MODEL}})
    body = {"status": "error" if state["error"] else "loading"}
    if state["error"]:
        body["error"] = state["error"]
    return JSONResponse(body, status_code=503)


@app.post("/v1/transcribe")
async def transcribe(
    request: Request,
    diarize: bool = Query(True),
    num_speakers: int | None = Query(None, ge=1, le=50),
    min_speakers: int | None = Query(None, ge=1, le=50),
    max_speakers: int | None = Query(None, ge=1, le=50),
) -> JSONResponse:
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
    t0 = time.time()

    if not _authorized(request):
        logj("request", request_id=rid, status=401)
        return _err(401, "missing or invalid bearer token", rid)
    if not state["ready"]:
        return _err(503, "models loading", rid, {"Retry-After": RETRY_AFTER_S})

    cl = request.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > MAX_BYTES:
        logj("request", request_id=rid, status=413, bytes=int(cl), reason="body too large")
        return _err(413, f"body exceeds {MAX_BYTES} bytes", rid)

    if not _slots.acquire(blocking=False):
        logj("request", request_id=rid, status=503, reason="busy")
        return _err(503, "busy: max concurrent jobs reached", rid, {"Retry-After": RETRY_AFTER_S})

    tmp = tempfile.NamedTemporaryFile(prefix="asr-", delete=False)
    try:
        size = 0
        async for part in request.stream():
            size += len(part)
            if size > MAX_BYTES:
                logj("request", request_id=rid, status=413, bytes=size, reason="body too large")
                return _err(413, f"body exceeds {MAX_BYTES} bytes", rid)
            tmp.write(part)
        tmp.close()
        if size == 0:
            return _err(422, "empty body", rid)

        loop = asyncio.get_running_loop()
        dur = await loop.run_in_executor(None, _probe_duration, tmp.name)
        if dur is None:
            logj("request", request_id=rid, status=422, bytes=size, reason="undecodable")
            return _err(422, "could not decode audio", rid)
        if dur > MAX_SECONDS:
            logj("request", request_id=rid, status=413, bytes=size, audio_s=round(dur, 1),
                 reason="too long")
            return _err(413, f"audio exceeds {int(MAX_SECONDS)} seconds", rid)

        try:
            result = await loop.run_in_executor(
                None, _run, tmp.name, dur, diarize, num_speakers, min_speakers, max_speakers)
        except Undecodable:
            logj("request", request_id=rid, status=422, bytes=size, reason="undecodable")
            return _err(422, "could not decode audio", rid)
        except OverflowError as e:
            logj("request", request_id=rid, status=413, bytes=size,
                 audio_s=round(e.args[0], 1), reason="too long")
            return _err(413, f"audio exceeds {int(MAX_SECONDS)} seconds ({e.args[0]:.0f}s)", rid)

        took = time.time() - t0
        stats = result.pop("_stats", {})
        logj("request", request_id=rid, status=200, bytes=size,
             audio_s=result["duration_s"], proc_s=round(took, 2),
             rtf=round(took / result["duration_s"], 4) if result["duration_s"] else None,
             diarize=diarize, words=len(result["words"]), speakers=len(result["speakers"]),
             **stats)
        return JSONResponse(result, headers={"X-Request-Id": rid})
    except Exception as e:  # noqa: BLE001
        log.exception("transcribe failed", extra={"extra_fields": {"request_id": rid}})
        if "CUDA error" in str(e) or type(e).__name__ == "AcceleratorError":
            # A CUDA fault poisons the context for the life of the process: go unhealthy
            # and exit so Docker's restart policy brings up a clean process.
            state.update(ready=False, error=f"fatal CUDA error: {type(e).__name__}")
            logj("fatal CUDA error; exiting for restart", request_id=rid)
            threading.Timer(1.0, os._exit, args=(1,)).start()
        return _err(500, "internal error", rid)
    finally:
        _slots.release()
        # GPUs are shared with vLLM / llama-server: once idle, hand cached blocks back
        # so the container's footprint returns to just the resident weights.
        if _slots._value == MAX_JOBS:   # noqa: SLF001 -- no other job in flight
            try:
                import torch
                torch.cuda.empty_cache()
            except Exception:  # noqa: BLE001
                pass
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
