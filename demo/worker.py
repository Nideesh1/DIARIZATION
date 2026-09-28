"""ASR worker: Redis Streams consumer group -> MinIO -> GPU ASR service -> MinIO + Postgres.

Run:  python worker.py   (in compose: the `worker` service)

Each job message is {"id": <recording id>}. The steps:
  1. claim the row (queued -> processing; a job already processing/done is skipped: idempotent)
  2. download the audio from MinIO; remux browser webm so it can be seeked; probe the length
  3. POST it to the ASR service (client.py: 503 + Retry-After is waited out and retried)
  4. result.json -> MinIO, stats -> Postgres (done, or failed + reason), ACK the message
  5. publish an event on Redis pub/sub so every open browser updates live
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path

from faststream import AckPolicy, FastStream
from faststream.redis import StreamSub
from redis.asyncio import Redis
from redis.exceptions import ResponseError

import client
import store

CONCURRENCY = int(os.environ.get("WORKER_CONCURRENCY", "2"))   # match the service's MAX_JOBS
GROUP = "asr-workers"
log = logging.getLogger("worker")
app = FastStream(store.broker)


def prepare_audio(path: Path) -> tuple[float | None, bool]:
    """Remux browser webm (it has no duration/cues, so players can't seek) and probe the
    duration. Returns (seconds, remuxed)."""
    remuxed = False
    if path.suffix == ".webm" and shutil.which("ffmpeg"):
        fixed = path.with_name("remux.webm")
        p = subprocess.run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-i", str(path), "-c", "copy",
                            str(fixed)], capture_output=True, timeout=300)
        if p.returncode == 0 and fixed.stat().st_size > 0:
            fixed.replace(path)
            remuxed = True
    p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                        str(path)], capture_output=True, text=True, timeout=60)
    try:
        return round(float(p.stdout.strip()), 2), remuxed
    except ValueError:
        return None, remuxed


async def set_note(rid: str, note: str) -> None:
    await store.update(rid, note=note)
    await store.announce(rid, "processing", note)


async def run_job(m: dict) -> dict:
    """Steps 2-4 for a claimed row; returns the columns to set."""
    rid = m["id"]
    with tempfile.TemporaryDirectory() as tmp:
        audio = Path(tmp) / f"audio.{m['ext']}"
        await store.download(m["audio_key"], audio)
        duration, remuxed = await asyncio.to_thread(prepare_audio, audio)
        if remuxed:
            await store.put_bytes(m["audio_key"], audio.read_bytes(), "audio/webm")
        if duration:
            await store.update(rid, duration_s=duration)
        await set_note(rid, "transcribing")
        res, took = await client.transcribe(audio, m["num_speakers_hint"],
                                            on_status=lambda text: set_note(rid, text))
    result_key = f"{rid}/result.json"
    await store.put_bytes(result_key, json.dumps(res, indent=1).encode(), "application/json")
    d = res.get("duration_s") or duration or 0
    model = res.get("model") or {}
    return dict(status="done", note=None, result_key=result_key, duration_s=d,
                processing_s=round(took, 2), rtf=round(d / took, 1) if took else None,
                speakers=len(res.get("speakers") or []), words=len(res.get("words") or []),
                speaker_stats=store.speaker_stats(res),
                stt_model=model.get("stt"), diar_model=model.get("diarization"))


async def handle(job: dict) -> None:
    rid = job["id"]
    m = await store.claim(rid)
    if m is None:
        log.info("skip %s: not queued (already processing, done, or deleted)", rid)
        return                                   # acked: nothing to do
    await store.announce(rid, "processing", m["note"])
    t0 = time.monotonic()
    try:
        fields = await run_job(m)
    except client.ASRError as e:
        fields = dict(status="failed", note=None, error=str(e))
    except Exception as e:  # noqa: BLE001 -- anything unexpected is shown in the list
        log.exception("job %s crashed", rid)
        fields = dict(status="failed", note=None, error=f"{type(e).__name__}: {e}")
    if not await store.update(rid, **fields):   # deleted while we worked: drop the leftovers
        await store.delete_objects(rid)
        return
    await store.announce(rid, fields["status"])
    log.info("%s %s in %.1fs %s", rid, fields["status"], time.monotonic() - t0, fields.get("error") or "")


# CONCURRENCY consumers in one consumer group: each takes ONE job at a time (max_records=1, so
# a busy consumer never sits on a second job), Redis hands every message to exactly one of
# them, and it is ACKed after `handle` returns.
for i in range(CONCURRENCY):
    store.broker.subscriber(
        stream=StreamSub(store.JOBS, group=GROUP, consumer=f"{socket.gethostname()}-{i + 1}", max_records=1),
        ack_policy=AckPolicy.ACK,
    )(handle)


INTERRUPTED: list[str] = []


@app.on_startup
async def startup() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    await store.connect()
    # Recovery after an unclean stop (crash, SIGKILL, restart past the grace period), done
    # before our consumers start reading: rows still `processing` go back to `queued`, and the
    # stream deliveries that were never ACKed are ACKed now (after_startup re-publishes the jobs).
    # This assumes one worker container; with several you would reclaim per consumer instead
    # (XAUTOCLAIM: StreamSub(min_idle_time=...)) plus a lease on the row.
    INTERRUPTED[:] = await store.requeue_interrupted()
    async with Redis.from_url(store.REDIS_URL) as r:
        try:
            stale = await r.xpending_range(store.JOBS, GROUP, "-", "+", 10_000)
        except ResponseError:                    # first start: no consumer group yet
            stale = []
        if stale:
            await r.xack(store.JOBS, GROUP, *[e["message_id"] for e in stale])


@app.after_startup
async def recover() -> None:
    for rid in INTERRUPTED:
        log.info("re-queue interrupted job %s", rid)
        await store.enqueue(rid)
        await store.announce(rid, "queued")


@app.after_shutdown
async def shutdown() -> None:
    await store.close()


if __name__ == "__main__":
    asyncio.run(app.run())
