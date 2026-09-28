"""ASR + diarization demo UI (NiceGUI).

Record from the mic or upload a file; the audio goes to MinIO, a row to Postgres and a job
onto a Redis stream for the worker (worker.py). Worker events arrive over Redis pub/sub and
are pushed to every open page, so statuses update live.
Run:  cd demo && docker compose up -d --build   ->  http://localhost:8080
"""
from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import re
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import datetime
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse, Response
from nicegui import Client, app, background_tasks, ui

import client
import store

HERE = Path(__file__).parent
STATE = {"health_ok": None, "health": "checking"}
LISTENERS: set[Callable[[dict], Awaitable[None]]] = set()   # one per open page


# ------------------------------------------------------------------ jobs
async def submit(name: str, ext: str, num_speakers: int | None, chunks: AsyncIterator[bytes],
                 content_type: str | None = None) -> str:
    """Audio -> MinIO, row -> Postgres (queued), job -> Redis stream."""
    ext = ext if re.fullmatch(r"[a-z0-9]{1,5}", ext) else "bin"
    rid = datetime.now().strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(2)
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
        rid = await submit(name, ext.lower(), num_speakers if num_speakers and 0 < num_speakers <= 20 else None,
                           request.stream(), request.headers.get("content-type", "").split(";")[0] or None)
    except store.UploadError as e:
        return JSONResponse({"error": str(e)}, status_code=413 if str(e) == "too large" else 422)
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


async def health_loop() -> None:
    while True:
        ok, text = await client.health()
        STATE.update(health_ok=ok, health=text)
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
ui.add_head_html(
    '<meta name="theme-color" content="#010101">'
    '<link rel="preload" href="/static/fonts/AlbertSans-latin.woff2" as="font" type="font/woff2" crossorigin>'
    '<link rel="preload" href="/static/fonts/AlumniSans-latin.woff2" as="font" type="font/woff2" crossorigin>'
    '<link rel="stylesheet" href="/static/demo.css">'
    '<script src="/static/demo.js"></script>', shared=True)

ROW_FIELDS = ("id", "name", "status", "note", "error", "duration_s", "processing_s", "rtf", "speakers",
              "words", "stt_model", "diar_model", "num_speakers_hint", "speaker_stats", "speaker_names")


def row_json(m: dict) -> dict:
    return {**{k: m[k] for k in ROW_FIELDS}, "created_at": m["created_at"].isoformat()}


def health_json() -> dict:
    return {"ok": STATE["health_ok"], "text": STATE["health"], "configured": client.CONFIGURED}


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
    else:
        return False
    return True


# ------------------------------------------------------------------ pages
@ui.page("/", title="Who said what")
async def index() -> None:
    c = ui.context.client
    mount("home", {"rows": [row_json(m) for m in await store.list_recordings()]})

    async def act(a: dict) -> None:
        await common_action(c, a)
    on_action(act)
    watch_health(c)
    await c.connected()

    async def on_change(_event: dict) -> None:     # pushed over the websocket: no reload
        push(c, "rows", [row_json(m) for m in await store.list_recordings()])
    listen(on_change)
    await on_change({})                            # anything that changed while connecting


def build_result(m: dict, res: dict) -> dict:
    """The service response shaped for the page: speakers in order of appearance (pyannote's
    labels are not, and "Speaker 2" opening the recording reads wrong), their talk time, and
    speaker turns (consecutive segments of one speaker) whose words carry [start, end]."""
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
    return {"speakers": speakers, "turns": turns, "words": len(words), "language": res.get("language"),
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

    mount("detail", await payload(m) if m else {"row": None})
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


if __name__ in {"__main__", "__mp_main__"}:
    ui.run(host=os.environ.get("DEMO_HOST", "127.0.0.1"), port=int(os.environ.get("DEMO_PORT", "8080")),
           title="Who said what", dark=True, reload=False, show=False, tailwind=False,
           favicon=HERE / "static" / "favicon.svg")
