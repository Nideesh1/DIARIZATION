"""Test client for asr-stream: stream a 16 kHz mono WAV like a microphone.

    uv run --with websockets --with soundfile --with numpy python client/stream_wav.py FILE.wav \
        [--url ws://192.168.0.247:9101/v1/stream] [--sessions N] [--fast] [--auth header|message]
        [--language auto] [--max-speakers 4] [--quiet]

Token: $ASR_TOKEN, else the repo's asr.env (../../asr.env) or ~/asr-service/asr.env (never printed).
Word latency = arrival time of an update - time the audio at that segment's end was sent.
"""
import argparse
import asyncio
import json
import os
import statistics
import time

import numpy as np
import soundfile as sf
import websockets


def token() -> str:
    if os.environ.get("ASR_TOKEN"):
        return os.environ["ASR_TOKEN"]
    here = os.path.dirname(os.path.abspath(__file__))
    for path in (os.path.join(here, "..", "..", "asr.env"), os.path.expanduser("~/asr-service/asr.env")):
        if os.path.exists(path):
            with open(path) as f:
                for line in f:
                    if line.startswith("ASR_TOKEN="):
                        return line.split("=", 1)[1].strip()
    raise SystemExit("set ASR_TOKEN (or create asr.env with ./gen_token.sh)")


async def one(idx: int, a, pcm: bytes, audio_s: float) -> dict:
    headers = {"Authorization": f"Bearer {token()}"} if a.auth == "header" else {}
    start = {"type": "start", "sample_rate": 16000, "language": a.language,
             "max_speakers": a.max_speakers}
    if a.auth == "message":
        start["token"] = token()
    lat, segs, info = [], [], {}
    async with websockets.connect(a.url, additional_headers=headers, max_size=1 << 24) as ws:
        await ws.send(json.dumps(start))
        ready = json.loads(await ws.recv())
        if ready.get("type") != "ready":
            return {"session": idx, "error": ready}
        info["ready"] = ready
        t0 = time.monotonic()

        async def sender():
            step = 3200  # 100 ms of s16le
            for i in range(0, len(pcm), step):
                await ws.send(pcm[i:i + step])
                if not a.fast:
                    # pace to real time relative to t0
                    target = t0 + (i + step) / 32000
                    d = target - time.monotonic()
                    if d > 0:
                        await asyncio.sleep(d)
            await ws.send(json.dumps({"type": "stop"}))

        st = asyncio.create_task(sender())
        final = None
        async for raw in ws:
            m = json.loads(raw)
            now = time.monotonic() - t0
            if m["type"] == "update":
                segs[m["from"]:] = m["segments"]
                if m["segments"] and not a.fast:
                    newest_end = max(s["end"] for s in m["segments"])
                    lat.append(now - newest_end)
                if not a.quiet and idx == 0:
                    last = segs[-1] if segs else {}
                    print(f"  [{now:6.2f}s] S{last.get('speaker')}: {last.get('text', '')[:90]}")
            elif m["type"] in ("final", "error"):
                final = m
                break
        await st
    wall = time.monotonic() - t0
    out = {"session": idx, "audio_s": audio_s, "wall_s": round(wall, 2),
           "final_segments": len(final.get("segments", [])) if final else None,
           "final_type": final.get("type") if final else None,
           "speakers": sorted({s["speaker"] for s in (final or {}).get("segments", [])})}
    if final and final.get("type") == "error":
        out["error"] = final
    if lat:
        out["word_latency_p50_s"] = round(statistics.median(lat), 2)
        out["word_latency_p95_s"] = round(sorted(lat)[int(len(lat) * 0.95) - 1], 2)
    if idx == 0 and final and final.get("segments"):
        out["transcript"] = [f"S{s['speaker']} [{s['start']:.1f}-{s['end']:.1f}] {s['text']}"
                             for s in final["segments"]]
    return out


async def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("wav")
    p.add_argument("--url", default="ws://192.168.0.247:9101/v1/stream")
    p.add_argument("--sessions", type=int, default=1)
    p.add_argument("--fast", action="store_true", help="send as fast as possible")
    p.add_argument("--auth", choices=["header", "message", "none"], default="header")
    p.add_argument("--language", default="auto")
    p.add_argument("--max-speakers", type=int, default=4)
    p.add_argument("--quiet", action="store_true")
    a = p.parse_args()
    audio, sr = sf.read(a.wav, dtype="int16")
    assert sr == 16000 and audio.ndim == 1, "need 16 kHz mono"
    pcm = audio.astype("<i2").tobytes()
    res = await asyncio.gather(*(one(i, a, pcm, len(audio) / sr) for i in range(a.sessions)),
                               return_exceptions=True)
    for r in res:
        print(json.dumps(r if isinstance(r, dict) else {"exception": repr(r)}, indent=1))


asyncio.run(main())
