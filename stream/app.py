"""Live speech-to-text with speaker labels over WebSocket.

    GET  /health      200 once models are loaded and warmed up, 503 before
    WS   /v1/stream   one live session per connection (protocol in README.md)

Models (loaded ONCE, shared by all sessions; weights ~3 GB on one GPU):
  ASR          nvidia/nemotron-3.5-asr-streaming-0.6b  (cache-aware, 32+ locales, language prompt)
  diarization  nvidia/Nemotron-3-Diarization           (streaming, up to 8 speakers)
coupled through NeMo Speech's SpeakerTaggedASR (masked ASR: one ASR stream per active
speaker, gated by the diarizer). Each session has its own SpeakerTaggedASR, audio
buffer and speaker cache; nothing is shared between sessions except the weights.

Every GPU step runs on ONE worker thread, so sessions take turns per step (~60-150 ms
of GPU per 0.56 s of audio each); the per-session language prompt is set right before
that session's step. MAX_SESSIONS bounds admission (extra connections get "busy").

Latency: words appear after one hop (ATT_CONTEXT right context, 0.56 s by default)
plus the step time. Speaker labels are session-local discovery order (0, 1, ...).
Never logs audio, text or tokens.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import re
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

# ---------------------------------------------------------------- config
TOKEN = os.environ.get("ASR_TOKEN", "")
ASR_MODEL = os.environ.get("ASR_MODEL", "nvidia/nemotron-3.5-asr-streaming-0.6b")
DIAR_MODEL = os.environ.get("DIAR_MODEL", "nvidia/Nemotron-3-Diarization")
DEVICE = os.environ.get("DEVICE", "cuda:0")
# Encoder attention context [left, right] in 80 ms frames; right+1 frames = hop/latency.
#   [56,13] 1.12 s (most accurate)   [56,6] 0.56 s (default)   [56,3] 0.32 s   [56,1] 0.16 s
ATT_CONTEXT = [int(x) for x in os.environ.get("ATT_CONTEXT", "56,6").split(",")]
MAX_SPEAKERS = min(8, int(os.environ.get("MAX_SPEAKERS", "4")))
MAX_SESSIONS = max(1, int(os.environ.get("MAX_SESSIONS", "4")))
MAX_SESSION_S = float(os.environ.get("MAX_SESSION_S", "7200"))      # audio seconds per session
IDLE_TIMEOUT_S = float(os.environ.get("IDLE_TIMEOUT_S", "30"))      # no message for this long -> finish
START_TIMEOUT_S = float(os.environ.get("START_TIMEOUT_S", "10"))    # time to send the start message
MAX_MSG_BYTES = int(os.environ.get("MAX_MSG_BYTES", str(1 << 20)))  # one binary audio message
DEFAULT_LANGUAGE = os.environ.get("LANGUAGE", "auto")
WARMUP_WAV = os.environ.get("WARMUP_WAV", "/app/warmup.wav")
SR = 16000

# ---------------------------------------------------------------- logging (JSON lines)
log = logging.getLogger("asr-stream")


def logj(msg: str, **kw: Any) -> None:
    log.info(json.dumps({"ts": round(time.time(), 3), "msg": msg, **kw}))


logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)

# ---------------------------------------------------------------- model state
state: dict[str, Any] = {"ready": False, "error": None, "loaded_s": None}
M: dict[str, Any] = {}             # asr, diar, cfg, geometry
GPU = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gpu")
_sessions_lock = threading.Lock()
_active_sessions = 0
LANG_TAG = re.compile(r"\s*<[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,4})?>\s*")


def _base_cfg(max_spks: int):
    from omegaconf import OmegaConf
    # Values from nvidia/Nemotron-3-Diarization ASR_INTEGRATION_GUIDE.md (option 2: masked ASR).
    return OmegaConf.create({
        "device": DEVICE, "sample_rate": SR, "deploy_mode": True, "streaming_mode": True,
        "max_num_of_spks": max_spks, "batch_size": 32, "parallel_speaker_strategy": True,
        "masked_asr": True, "mask_preencode": False, "single_speaker_mode": False,
        "cache_gating": True, "cache_gating_buffer_size": 2, "binary_diar_preds": True,
        "spkcache_len": None, "spkcache_update_period": 222, "fifo_len": 264,
        "diar_right_context": 0, "att_context_size": ATT_CONTEXT, "use_amp": True,
        "precision": "bf16", "online_normalization": False, "pad_and_drop_preencoded": False,
        "feat_len_sec": 0.01, "discarded_frames": 8, "word_window": 50, "sent_break_sec": 1.0,
        "fix_prev_words_count": 5, "update_prev_words_sentence": 5, "left_frame_shift": -1,
        "right_frame_shift": 0, "min_sigmoid_val": 1e-2, "ignored_initial_frame_steps": 5,
        "generate_realtime_scripts": False, "print_sample_indices": [0], "colored_text": False,
        "verbose": False, "print_time": False, "log": False,
    })


def _load_models() -> None:
    """Runs on the GPU thread: load, configure streaming geometry, warm up."""
    try:
        import torch
        import nemo.collections.asr as nemo_asr
        from nemo.collections.asr.models.sortformer_diar_models import SortformerEncLabelModel
        from nemo.collections.asr.parts.utils.multispk_transcribe_utils import (
            configure_diar_streaming, validate_feature_frame_strides)
        logging.getLogger("nemo_logger").setLevel(logging.WARNING)
        t0 = time.time()
        torch.cuda.set_device(torch.device(DEVICE))
        asr = nemo_asr.models.ASRModel.from_pretrained(ASR_MODEL)
        diar = SortformerEncLabelModel.from_pretrained(DIAR_MODEL)
        asr.eval().to(DEVICE)
        diar.eval().to(DEVICE)
        asr.encoder.set_default_att_context_size(ATT_CONTEXT)
        validate_feature_frame_strides(asr_model=asr, diar_model=diar)
        prompts = dict(asr.cfg.model_defaults.get("prompt_dictionary", {})) if hasattr(
            asr, "set_inference_prompt") else {}
        sc = asr.encoder.streaming_cfg
        cfg = _base_cfg(MAX_SPEAKERS)
        configure_diar_streaming(diar_model=diar, cfg=cfg,
                                 output_subsampling_factor=asr.encoder.subsampling_factor,
                                 diar_chunk_len=sc.valid_out_len + sc.cache_drop_size)
        stride = float(asr.cfg.preprocessor.window_stride)
        hop = round(sc.valid_out_len * asr.encoder.subsampling_factor * stride * SR)
        cache = sc.pre_encode_cache_size
        cache = cache[-1] if isinstance(cache, (list, tuple)) else cache
        cache = round(cache * stride * SR)
        M.update(asr=asr, diar=diar, cfg=cfg, hop=hop, cache=cache, frame=hop + cache,
                 prompts=prompts, spkcache_len=int(diar.sortformer_modules.spkcache_len),
                 cur_lang=None)
        state["loaded_s"] = round(time.time() - t0, 1)
        logj("models loaded", seconds=state["loaded_s"], asr=ASR_MODEL, diar=DIAR_MODEL,
             device=DEVICE, att_context=ATT_CONTEXT, hop_s=hop / SR,
             languages=len(prompts), max_speakers=MAX_SPEAKERS, max_sessions=MAX_SESSIONS)
        _warmup()
        state["ready"] = True
        logj("ready", total_seconds=round(time.time() - t0, 1),
             gpu_mem_gb=round(torch.cuda.memory_reserved() / 2**30, 2))
    except Exception as e:  # noqa: BLE001 -- surfaced via /health
        state["error"] = f"{type(e).__name__}: {e}"
        log.exception("model load failed")


def _warmup() -> None:
    """The first steps with each active-speaker count compile/autotune kernels (~10 s each
    time). Run real speech through a session at startup so users never pay that."""
    import soundfile as sf
    t0 = time.time()
    if not os.path.exists(WARMUP_WAV):
        logj("warmup skipped: no wav", path=WARMUP_WAV)
        return
    audio, sr = sf.read(WARMUP_WAV, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != SR:
        logj("warmup skipped: wav is not 16 kHz", sr=sr)
        return
    for _ in range(2):   # second pass confirms steady-state step times
        s = Session(language=DEFAULT_LANGUAGE, max_speakers=MAX_SPEAKERS)
        s.append(audio)
        s.step_all()
        s.finish()
    logj("warmup done", seconds=round(time.time() - t0, 1), audio_s=round(len(audio) / SR, 1))


# ---------------------------------------------------------------- session
class Session:
    """One live stream. append() may be called from the event loop; step_all() and
    finish() only on the GPU thread."""

    def __init__(self, language: str, max_speakers: int):
        from nemo.collections.asr.parts.utils.multispk_transcribe_utils import SpeakerTaggedASR
        from nemo.collections.asr.parts.utils.streaming_utils import CacheAwareStreamingAudioBuffer
        cfg = _base_cfg(max_speakers)
        cfg.spkcache_len = M["spkcache_len"]
        self.language = language
        self.streamer = SpeakerTaggedASR(cfg, M["asr"], M["diar"])
        self.abuf = CacheAwareStreamingAudioBuffer(model=M["asr"], online_normalization=False)
        self._lock = threading.Lock()
        self._pending = np.zeros(M["cache"], dtype=np.float32)
        self.step_num = 0
        self.received_samples = 0
        self.step_ms: list[float] = []

    # -- event-loop side
    def append(self, pcm: np.ndarray) -> None:
        with self._lock:
            self._pending = np.concatenate([self._pending, pcm])
        self.received_samples += len(pcm)

    def has_frame(self) -> bool:
        with self._lock:
            return len(self._pending) >= M["frame"]

    # -- GPU-thread side
    def _set_language(self) -> None:
        if M["prompts"] and M["cur_lang"] != self.language:
            M["asr"]._inference_prompt_index = M["prompts"][self.language]   # what set_inference_prompt does, minus its log line
            M["cur_lang"] = self.language

    def _step(self, frame: np.ndarray, last: bool) -> None:
        import torch
        t = time.perf_counter()
        self._set_language()
        with torch.inference_mode():
            ca, cl = self.abuf.preprocess_audio(frame)
            ca = ca[:, :, :cl[0]]
            drop = 0 if self.step_num == 0 else M["asr"].encoder.streaming_cfg.drop_extra_pre_encoded
            self.streamer.perform_parallel_streaming_stt_spk(
                step_num=self.step_num, chunk_audio=ca, chunk_lengths=cl,
                is_buffer_empty=last, drop_extra_pre_encoded=drop)
        torch.cuda.synchronize()
        self.step_num += 1
        self.step_ms.append((time.perf_counter() - t) * 1000)

    def step_all(self) -> list[dict]:
        """Process every complete frame; return the current segment list."""
        while True:
            with self._lock:
                if len(self._pending) < M["frame"]:
                    break
                frame = self._pending[:M["frame"]]
                self._pending = self._pending[M["hop"]:]
            self._step(frame, last=False)
        return self.segments()

    def finish(self) -> list[dict]:
        """Flush: pad with silence so the tail (and its look-ahead) is decoded."""
        with self._lock:
            pad = M["frame"] * 2 - (len(self._pending) % M["hop"])
            self._pending = np.concatenate([self._pending, np.zeros(pad, dtype=np.float32)])
        frames = []
        with self._lock:
            while len(self._pending) >= M["frame"]:
                frames.append(self._pending[:M["frame"]])
                self._pending = self._pending[M["hop"]:]
        for i, f in enumerate(frames):
            self._step(f, last=(i == len(frames) - 1))
        return self.segments()

    def segments(self) -> list[dict]:
        states = self.streamer.instance_manager.batch_asr_states
        if not states:
            return []
        out = []
        audio_end = self.received_samples / SR
        for s in states[0].seglsts:
            text = LANG_TAG.sub(" ", s.get("words", "")).strip()
            if not text:
                continue
            spk = str(s.get("speaker", "speaker_0")).rsplit("_", 1)[-1]
            out.append({
                "speaker": int(spk) if spk.isdigit() else spk,
                "start": round(min(float(s["start_time"]), audio_end), 2),
                "end": round(min(float(s["end_time"]), audio_end), 2),
                "text": text,
            })
        return out


# ---------------------------------------------------------------- app
app = FastAPI(title="asr-stream", docs_url=None, redoc_url=None, openapi_url=None)


@app.on_event("startup")
async def _startup() -> None:
    asyncio.get_running_loop().run_in_executor(GPU, _load_models)


@app.get("/health")
async def health() -> JSONResponse:
    body = {
        "status": "ok" if state["ready"] else ("error" if state["error"] else "loading"),
        "models": {"asr": ASR_MODEL, "diarization": DIAR_MODEL},
        "latency_s": round(M["hop"] / SR, 2) if "hop" in M else None,
        "sessions": _active_sessions, "max_sessions": MAX_SESSIONS,
        "max_speakers": MAX_SPEAKERS,
    }
    if state["error"]:
        body["error"] = state["error"]
    return JSONResponse(body, status_code=200 if state["ready"] else 503)


def _authorized(value: str | None) -> bool:
    if not TOKEN or not value:
        return False
    v = value[7:] if value.startswith("Bearer ") else value
    return hmac.compare_digest(v.encode(), TOKEN.encode())


async def _send(ws: WebSocket, obj: dict) -> None:
    await ws.send_text(json.dumps(obj, separators=(",", ":")))


async def _fail(ws: WebSocket, code: str, message: str, close_code: int, **extra: Any) -> None:
    try:
        await _send(ws, {"type": "error", "code": code, "message": message, **extra})
        await ws.close(code=close_code)
    except Exception:  # noqa: BLE001 -- client already gone
        pass


def _diff(prev: list[dict], cur: list[dict]) -> int | None:
    """Index of the first segment that changed (None if nothing changed)."""
    n = min(len(prev), len(cur))
    for i in range(n):
        if prev[i] != cur[i]:
            return i
    return None if len(prev) == len(cur) else n


@app.websocket("/v1/stream")
async def stream(ws: WebSocket) -> None:
    global _active_sessions
    await ws.accept()
    sid = uuid.uuid4().hex[:12]
    if not state["ready"]:
        await _fail(ws, "loading", "models are still loading; retry shortly", 1013, retry_after_s=15)
        return
    header_ok = _authorized(ws.headers.get("authorization"))

    # 1) start message
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=START_TIMEOUT_S)
        start = json.loads(raw)
        assert isinstance(start, dict) and start.get("type") == "start"
    except (asyncio.TimeoutError, AssertionError, json.JSONDecodeError, KeyError, RuntimeError):
        await _fail(ws, "bad_request", 'first message must be JSON {"type":"start",...}', 1008)
        return
    except WebSocketDisconnect:
        return
    if not (header_ok or _authorized(start.get("token"))):
        logj("unauthorized", session=sid)
        await _fail(ws, "unauthorized", "missing or invalid token", 1008)
        return
    if int(start.get("sample_rate", SR)) != SR or start.get("encoding", "pcm_s16le") != "pcm_s16le":
        await _fail(ws, "bad_request", "audio must be pcm_s16le, mono, 16000 Hz", 1003)
        return
    language = str(start.get("language", DEFAULT_LANGUAGE))
    if M["prompts"] and language not in M["prompts"]:
        await _fail(ws, "bad_request", f"unknown language {language!r}",
                    1003, languages=sorted(M["prompts"]))
        return
    try:
        max_spk = int(start.get("max_speakers", MAX_SPEAKERS))
    except (TypeError, ValueError):
        max_spk = -1
    if not 1 <= max_spk <= MAX_SPEAKERS:
        await _fail(ws, "bad_request", f"max_speakers must be 1..{MAX_SPEAKERS}", 1003)
        return

    # 2) admission
    with _sessions_lock:
        if _active_sessions >= MAX_SESSIONS:
            busy = True
        else:
            busy = False
            _active_sessions += 1
    if busy:
        logj("busy", session=sid, active=MAX_SESSIONS)
        await _fail(ws, "busy", "all live sessions are in use", 1013, retry_after_s=15)
        return

    loop = asyncio.get_running_loop()
    t0 = time.time()
    session: Session | None = None
    sent: list[dict] = []
    end_reason = "client_stop"
    try:
        session = await loop.run_in_executor(GPU, Session, language, max_spk)
        await _send(ws, {"type": "ready", "session_id": sid, "sample_rate": SR,
                         "encoding": "pcm_s16le", "latency_s": round(M["hop"] / SR, 2),
                         "language": language, "max_speakers": max_spk})
        logj("session start", session=sid, language=language, max_speakers=max_spk)

        pump: asyncio.Task | None = None

        async def run_pump() -> None:
            nonlocal sent
            while session.has_frame():
                segs = await loop.run_in_executor(GPU, session.step_all)
                i = _diff(sent, segs)
                if i is not None:
                    await _send(ws, {"type": "update", "from": i, "segments": segs[i:],
                                     "audio_s": round(session.received_samples / SR, 2)})
                    sent = segs

        # 3) audio loop
        while True:
            try:
                msg = await asyncio.wait_for(ws.receive(), timeout=IDLE_TIMEOUT_S)
            except asyncio.TimeoutError:
                end_reason = "idle_timeout"
                break
            if msg["type"] == "websocket.disconnect":
                end_reason = "client_disconnect"
                break
            if msg.get("bytes") is not None:
                b = msg["bytes"]
                if len(b) > MAX_MSG_BYTES or len(b) % 2:
                    await _fail(ws, "bad_request", "binary messages must be whole pcm_s16le "
                                f"samples, at most {MAX_MSG_BYTES} bytes", 1009)
                    end_reason = "bad_audio"
                    return
                session.append(np.frombuffer(b, dtype="<i2").astype(np.float32) / 32768.0)
                if session.received_samples / SR > MAX_SESSION_S:
                    end_reason = "max_session_length"
                    break
                if pump is None or pump.done():
                    if pump is not None and pump.exception():
                        raise pump.exception()
                    pump = asyncio.create_task(run_pump())
            elif msg.get("text") is not None:
                try:
                    ctl = json.loads(msg["text"])
                except json.JSONDecodeError:
                    ctl = {}
                if ctl.get("type") == "stop":
                    break
                # anything else is ignored (forward compatible)

        # 4) finish: drain queued audio, flush the tail, send the full transcript
        if pump is not None:
            await pump
        final = await loop.run_in_executor(GPU, session.finish)
        if end_reason != "client_disconnect":
            await _send(ws, {"type": "final", "segments": final,
                             "audio_s": round(session.received_samples / SR, 2),
                             "reason": end_reason})
            await ws.close(code=1000)
    except WebSocketDisconnect:
        end_reason = "client_disconnect"
    except Exception as e:  # noqa: BLE001
        end_reason = "error"
        log.exception("session failed")
        if "CUDA" in str(e):
            logj("fatal CUDA error; exiting for restart", session=sid)
            threading.Timer(1.0, os._exit, args=(1,)).start()
        await _fail(ws, "internal", "internal error", 1011)
    finally:
        with _sessions_lock:
            _active_sessions -= 1
        if session is not None:
            st = session.step_ms or [0.0]
            logj("session end", session=sid, reason=end_reason,
                 audio_s=round(session.received_samples / SR, 2),
                 wall_s=round(time.time() - t0, 2), steps=session.step_num,
                 step_ms_p50=round(float(np.percentile(st, 50)), 1),
                 step_ms_p95=round(float(np.percentile(st, 95)), 1),
                 step_ms_max=round(float(max(st)), 1))
