"""ASR + diarization demo UI (NiceGUI).

Two ways in. RECORD / upload: the audio goes to MinIO, a row to Postgres and a job onto a Redis
stream for the worker (worker.py, the batch Parakeet + pyannote pass). LIVE: the browser streams
the mic to the live service through /ws/live (live.py) and, on stop, POSTs the audio together
with the live service's final segments; that is saved as a finished recording (source = live),
no job. Events arrive over Redis pub/sub and are pushed to every open page, so statuses update live.
Run:  cd demo && docker compose up -d --build   ->  http://localhost:8080
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import mimetypes
import os
import re
import secrets
import shutil
import tempfile
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import datetime
from pathlib import Path

from fastapi import Request, WebSocket
from fastapi.responses import JSONResponse, Response
from nicegui import Client, app, background_tasks, ui
from starlette.datastructures import UploadFile

import client
import live
import store

HERE = Path(__file__).parent
STATE = {"health_ok": None, "health": "checking", "live_ok": None, "live": "checking"}
LISTENERS: set[Callable[[dict], Awaitable[None]]] = set()   # one per open page


# ------------------------------------------------------------------ jobs
def new_id() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(2)


def safe_ext(ext: str) -> str:
    return ext if re.fullmatch(r"[a-z0-9]{1,5}", ext) else "bin"


async def submit(name: str, ext: str, num_speakers: int | None, chunks: AsyncIterator[bytes],
                 content_type: str | None = None) -> str:
    """Audio -> MinIO, row -> Postgres (queued), job -> Redis stream."""
    ext = safe_ext(ext)
    rid = new_id()
    ctype = content_type or mimetypes.guess_type(f"x.{ext}")[0] or "application/octet-stream"
    await store.put_stream(store.audio_key(rid, ext), chunks, ctype)
    await store.insert(rid, name, ext, num_speakers)
    await store.enqueue(rid)
    await store.announce(rid, "queued")
    return rid


async def retry(rid: str) -> None:
    if await store.requeue(rid):
        await store.enqueue(rid)
        await store.announce(rid, "queued")


async def rerun(rid: str, num_speakers: int | None) -> bool:
    """Transcribe a finished (or failed) recording again, e.g. with a different speaker count.
    False when it is already queued/processing (or gone): nothing is enqueued."""
    if not await store.rerun(rid, num_speakers):
        return False
    await store.enqueue(rid)
    await store.announce(rid, "queued")
    return True


def speakers_hint(v) -> int | None:
    """A speaker-count hint from the browser: 1..20, anything else (Auto, junk) -> None."""
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if 0 < n <= 20 else None


async def delete(rid: str) -> None:
    await store.delete(rid)
    await store.announce(rid, "deleted")


@store.broker.subscriber(channel=store.EVENTS)
async def on_event(event: dict) -> None:
    """Every status change (from the worker or another ui process) -> every open page."""
    for fn in list(LISTENERS):
        background_tasks.create(fn(event), name="page-update")


def listen(fn: Callable[[dict], Awaitable[None]]) -> None:
    LISTENERS.add(fn)
    ui.context.client.on_delete(lambda: LISTENERS.discard(fn))


# ------------------------------------------------------------------ backend routes
@app.post("/api/recordings")
async def post_recording(request: Request, ext: str = "webm", num_speakers: int | None = None,
                         name: str | None = None):
    """The browser (recorder or drag-and-drop upload) POSTs the file as the raw body (streamed to MinIO)."""
    name = (name or "").strip()[:80] or f"Recording {datetime.now():%H:%M}"
    try:
        rid = await submit(name, ext.lower(), speakers_hint(num_speakers),
                           request.stream(), request.headers.get("content-type", "").split(";")[0] or None)
    except store.UploadError as e:
        return JSONResponse({"error": str(e)}, status_code=413 if str(e) == "too large" else 422)
    return {"id": rid}


# LIVE mode: what the live service (../stream) runs. The same names its GET /health reports.
LIVE_MODELS = {"stt": os.environ.get("LIVE_ASR_MODEL", "nvidia/nemotron-3.5-asr-streaming-0.6b"),
               "diarization": os.environ.get("LIVE_DIAR_MODEL", "nvidia/Nemotron-3-Diarization")}
MAX_LIVE_RESULT = 8 << 20          # the segments JSON of a long session


def live_result(raw: str, fallback_s: float | None) -> dict:
    """The browser's copy of the live service's `final` segments, validated and shaped like the
    batch service's result.json: segments + speakers + model. The live service has no word
    timings, so `words` is empty and the detail page highlights whole segments instead.
    ValueError on anything malformed."""
    data = json.loads(raw)
    if not isinstance(data, dict) or not isinstance(data.get("segments"), list) or len(data["segments"]) > 50_000:
        raise ValueError("segments must be a list")
    segs = []
    for g in data["segments"]:
        spk, s, e, text = int(g["speaker"]), float(g["start"]), float(g["end"]), str(g.get("text") or "").strip()
        if not (0 <= spk < 32 and math.isfinite(s) and math.isfinite(e)):
            raise ValueError("bad segment")
        if text:
            s = max(0.0, s)
            segs.append({"speaker": f"SPEAKER_{spk:02d}", "start": round(s, 2), "end": round(max(s, e), 2), "text": text[:10_000]})
    segs.sort(key=lambda g: g["start"])
    lat = data.get("latency_s")
    return {"segments": segs, "words": [], "speakers": sorted({g["speaker"] for g in segs}),
            "duration_s": fallback_s, "language": None, "source": "live",
            "latency_s": round(float(lat), 2) if isinstance(lat, (int, float)) and 0 <= lat < 60 else None,
            "model": dict(LIVE_MODELS)}


@app.post("/api/recordings/live")
async def post_live_recording(request: Request, ext: str = "webm", num_speakers: int | None = None,
                              name: str | None = None):
    """LIVE mode, on stop: one multipart POST with the recording (`audio`) and the live service's
    final segments (`result`, JSON). Audio and result.json go to MinIO first, then the row is
    inserted already done (source = live), so it can never be done without its transcript; any
    failure on the way removes what was written. No job is queued."""
    if int(request.headers.get("content-length") or 0) > store.MAX_UPLOAD + MAX_LIVE_RESULT:
        return JSONResponse({"error": "too large"}, status_code=413)
    form = await request.form(max_files=1, max_fields=1, max_part_size=MAX_LIVE_RESULT)
    try:
        audio, raw = form.get("audio"), form.get("result")
        if not isinstance(audio, UploadFile) or not isinstance(raw, str):
            return JSONResponse({"error": "expected multipart fields audio + result"}, status_code=422)
        try:
            res = live_result(raw, None)
        except (ValueError, KeyError, TypeError) as e:
            return JSONResponse({"error": f"bad result: {e}"}, status_code=422)
        ext, rid = safe_ext(ext.lower()), new_id()
        name = (name or "").strip()[:80] or f"Recording {datetime.now():%H:%M}"
        ctype = (audio.content_type or "").split(";")[0] or mimetypes.guess_type(f"x.{ext}")[0] or "application/octet-stream"
        try:
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / f"audio.{ext}"
                with open(path, "wb") as f:
                    await asyncio.to_thread(shutil.copyfileobj, audio.file, f, 1 << 20)
                size = path.stat().st_size
                if not size or size > store.MAX_UPLOAD:
                    raise store.UploadError("empty" if not size else "too large")
                duration, _ = await asyncio.to_thread(store.prepare_audio, path)   # webm: remux so it seeks

                async def chunks() -> AsyncIterator[bytes]:
                    with open(path, "rb") as f:
                        while b := f.read(1 << 20):
                            yield b
                await store.put_stream(store.audio_key(rid, ext), chunks(), ctype)
            segs = res["segments"]
            res["duration_s"] = duration or (segs[-1]["end"] if segs else None)
            result_key = f"{rid}/result.json"
            await store.put_bytes(result_key, json.dumps(res, indent=1).encode(), "application/json")
            stats = store.speaker_stats(res)
            await store.insert_live(rid, name, ext, speakers_hint(num_speakers), result_key=result_key,
                                    duration_s=res["duration_s"], speakers=len(stats),
                                    words=sum(len(g["text"].split()) for g in segs), speaker_stats=stats,
                                    stt_model=LIVE_MODELS["stt"], diar_model=LIVE_MODELS["diarization"])
        except store.UploadError as e:
            await store.delete_objects(rid)
            return JSONResponse({"error": str(e)}, status_code=413 if str(e) == "too large" else 422)
        except BaseException:
            await store.delete_objects(rid)
            raise
    finally:
        await form.close()
    await store.announce(rid, "done")
    return {"id": rid}


@app.get("/api/recordings/{rid}/result.json")
async def get_result(rid: str):
    """The raw service response, as a download."""
    m = await store.get(rid)
    if not m or not m["result_key"]:
        return JSONResponse({"error": "not found"}, status_code=404)
    return Response(await store.get_bytes(m["result_key"]), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{rid}.json"'})


@app.get("/api/health")
async def api_health():
    await store.db.fetchval("SELECT 1")
    return {"ok": True}


@app.websocket("/ws/live")
async def ws_live(ws: WebSocket):
    """Live captions while recording: proxied to the streaming ASR service (live.py)."""
    await live.proxy(ws)


async def health_loop() -> None:
    while True:
        (ok, text), (lok, ltext) = await asyncio.gather(client.health(), live.health())
        STATE.update(health_ok=ok, health=text, live_ok=lok, live=ltext)
        await asyncio.sleep(10)


async def startup() -> None:
    await store.connect()
    await store.broker.start()
    background_tasks.create(health_loop(), name="health")
    background_tasks.create(backfill(), name="backfill")


async def backfill() -> None:
    """Rows finished before speaker_stats existed get their talk-time split once."""
    for rid in await store.backfill_speaker_stats():
        await store.announce(rid, "updated")


async def shutdown() -> None:
    await store.broker.stop()
    await store.close()


app.on_startup(startup)
app.on_shutdown(shutdown)
app.add_static_files("/static", HERE / "static")

# The pages are rendered by static/demo.js into #wsw (plain DOM, no Quasar widgets); NiceGUI
# serves them and carries the live updates (server -> WSW.* calls) and the user's actions
# (emitEvent("wsw", {...}) -> the page's handler) over its websocket.
def _v(*names: str) -> str:
    """Cache-busting version: a short hash of the static files' contents, so a normal reload
    picks up a rebuilt demo.css / demo.js instead of the browser's cached copy."""
    h = hashlib.sha1()
    for n in names:
        h.update((HERE / "static" / n).read_bytes())
    return h.hexdigest()[:10]


# The font preloads keep the exact URLs the @font-face rules in demo.css use (a query string
# would make the preload miss and the font download twice); fonts are never edited in place.
ui.add_head_html(
    '<meta name="theme-color" content="#010101">'
    '<link rel="preload" href="/static/fonts/AlbertSans-latin.woff2" as="font" type="font/woff2" crossorigin>'
    '<link rel="preload" href="/static/fonts/AlumniSans-latin.woff2" as="font" type="font/woff2" crossorigin>'
    f'<link rel="stylesheet" href="/static/demo.css?v={_v("demo.css")}">'
    f'<script>window.WSW_WORKLET = "/static/pcm-worklet.js?v={_v("pcm-worklet.js")}";</script>'
    f'<script src="/static/demo.js?v={_v("demo.js")}"></script>', shared=True)

ROW_FIELDS = ("id", "name", "status", "note", "error", "duration_s", "processing_s", "rtf", "speakers",
              "words", "stt_model", "diar_model", "num_speakers_hint", "speaker_stats", "speaker_names", "source")


def row_json(m: dict) -> dict:
    return {**{k: m[k] for k in ROW_FIELDS}, "created_at": m["created_at"].isoformat()}


def health_json() -> dict:
    return {"ok": STATE["health_ok"], "text": STATE["health"], "configured": client.CONFIGURED,
            "live": {"ok": STATE["live_ok"], "text": STATE["live"], "configured": live.CONFIGURED}}


def mount(view: str, data: dict) -> None:
    """The page skeleton: an empty root plus its initial data, rendered by demo.js on load."""
    blob = json.dumps({"view": view, "health": health_json(), **data}).replace("</", "<\\/")
    ui.add_body_html(f'<div id="wsw"></div><script>window.__WSW = {blob};</script>')


def push(c: Client, fn: str, *args) -> None:
    """Call WSW.<fn>(*args) in one browser tab (fire and forget)."""
    if not c.is_deleted and c.has_socket_connection:
        c.run_javascript(f"WSW.{fn}({', '.join(json.dumps(a) for a in args)})")


def watch_health(c: Client) -> None:
    last = {"v": health_json()}

    def tick() -> None:
        if (v := health_json()) != last["v"]:
            last["v"] = v
            push(c, "health", v)
    ui.timer(3, tick)


def on_action(handler: Callable[[dict], Awaitable[None]]) -> None:
    """emitEvent("wsw", {op: ..., ...}) from the page -> handler(dict)."""
    async def run(e) -> None:
        a = e.args[0] if isinstance(e.args, list) and e.args else e.args
        if isinstance(a, dict):
            await handler(a)
    ui.on("wsw", run)


async def common_action(c: Client, a: dict) -> bool:
    """Actions both pages share; True if handled."""
    rid = str(a.get("id", ""))
    if a.get("op") == "rename" and (name := str(a.get("name", "")).strip()[:80]):
        await store.rename(rid, name)
        await store.announce(rid, "renamed")
    elif a.get("op") == "delete":
        await delete(rid)
    elif a.get("op") == "retry":
        await retry(rid)
    elif a.get("op") == "rerun":
        if not await rerun(rid, speakers_hint(a.get("num_speakers"))):
            push(c, "toast", "Already transcribing: wait for it to finish, then re-run", "err")
    else:
        return False
    return True


async def all_rows() -> list[dict]:
    return [row_json(m) for m in await store.list_recordings()]


async def watch_count(c: Client) -> None:
    """Keep the header's recordings count live on pages that don't get the full row list."""
    async def on_change(event: dict) -> None:
        if event.get("status") in ("queued", "deleted", None):
            push(c, "count", len(await store.list_recordings()))
    listen(on_change)
    await on_change({})


# ------------------------------------------------------------------ pages
async def library_page(view: str) -> None:
    """/ (record + upload + the latest few) and /recordings (everything): both get every row, live."""
    c = ui.context.client
    mount(view, {"rows": await all_rows()})

    async def act(a: dict) -> None:
        await common_action(c, a)
    on_action(act)
    watch_health(c)
    await c.connected()

    async def on_change(_event: dict) -> None:     # pushed over the websocket: no reload
        push(c, "rows", await all_rows())
    listen(on_change)
    await on_change({})                            # anything that changed while connecting


@ui.page("/", title="Who said what")
async def index() -> None:
    await library_page("home")


@ui.page("/recordings", title="Recordings · Who said what")
async def recordings() -> None:
    await library_page("recordings")


@ui.page("/architecture", title="Architecture · Who said what")
async def architecture() -> None:
    c = ui.context.client
    mount("architecture", {"count": len(await store.list_recordings())})
    watch_health(c)
    await c.connected()
    await watch_count(c)


def build_result(m: dict, res: dict) -> dict:
    """The service response shaped for the page: speakers in order of appearance (pyannote's
    labels are not, and "Speaker 2" opening the recording reads wrong), their talk time, and
    speaker turns (consecutive segments of one speaker) whose words carry [start, end]. A live
    recording has no word timings: each segment is then one "word" spanning the segment, so the
    page highlights and seeks by segment (granularity "segment")."""
    segs, words = res.get("segments") or [], res.get("words") or []
    speakers = [{"id": x["speaker"], "name": m["speaker_names"].get(x["speaker"]) or f"Speaker {i + 1}",
                 "talk": x["seconds"]} for i, x in enumerate(store.speaker_stats(res))]
    turns, wi = [], 0
    for n, seg in enumerate(segs):
        mine = []
        while wi < len(words) and (words[wi]["end"] <= seg["end"] + 1e-3 or n == len(segs) - 1):
            w = words[wi]
            mine.append([w["word"], w["start"], w["end"]])
            wi += 1
        if not mine:
            mine = [[seg.get("text", ""), seg["start"], seg["end"]]]
        if turns and turns[-1]["speaker"] == seg["speaker"]:
            turns[-1]["end"] = seg["end"]
            turns[-1]["words"] += mine
        else:
            turns.append({"speaker": seg["speaker"], "start": seg["start"], "end": seg["end"], "words": mine})
    model = res.get("model") or {}
    return {"speakers": speakers, "turns": turns, "language": res.get("language"),
            "words": len(words) or sum(len(str(g.get("text", "")).split()) for g in segs),
            "granularity": "word" if words else "segment", "source": m.get("source") or "batch",
            "latency_s": res.get("latency_s"),
            "segments": [[g["speaker"], g["start"], g["end"]] for g in segs],
            "stt": model.get("stt"), "diar": model.get("diarization")}


@ui.page("/r/{rid}", title="Who said what")
async def detail(rid: str) -> None:
    c = ui.context.client
    ui.add_head_html('<script defer src="/static/vendor/wavesurfer-7.12.12.min.js"></script>')
    m = await store.get(rid)

    async def payload(m: dict) -> dict:
        """Row + transcript (from MinIO, server side) + a presigned audio URL."""
        res = json.loads(await store.get_bytes(m["result_key"])) if m["status"] == "done" else None
        return {"row": row_json(m), "audio": await store.presigned_url(m["audio_key"]),
                "result": build_result(m, res) if res else None}

    count = len(await store.list_recordings())
    mount("detail", {**(await payload(m) if m else {"row": None}), "count": count})
    if not m:
        return
    shown = {"status": m["status"], "note": m["note"], "name": m["name"]}

    async def act(a: dict) -> None:
        if a.get("op") == "rename_speaker" and (spk := str(a.get("speaker", ""))):
            await store.rename_speaker(rid, spk, str(a.get("name", "")).strip()[:60])
        elif a.get("id") == rid:
            await common_action(c, a)
    on_action(act)
    watch_health(c)
    await c.connected()

    async def on_change(event: dict) -> None:    # live: queued -> processing -> done, renames, delete
        if event.get("id") not in (rid, None):
            return
        m = await store.get(rid)
        if m is None:
            push(c, "gone")
            return
        now = {"status": m["status"], "note": m["note"], "name": m["name"]}
        if now == shown:
            return
        became_done = m["status"] == "done" and shown["status"] != "done"
        shown.update(now)
        push(c, "detail", await payload(m) if became_done else {"row": row_json(m)})
    listen(on_change)
    await on_change({"id": None})
    await watch_count(c)


if __name__ in {"__main__", "__mp_main__"}:
    ui.run(host=os.environ.get("DEMO_HOST", "127.0.0.1"), port=int(os.environ.get("DEMO_PORT", "8080")),
           title="Who said what", dark=True, reload=False, show=False, tailwind=False,
           favicon=HERE / "static" / "favicon.svg")
