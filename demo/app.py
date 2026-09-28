"""ASR + diarization demo UI (NiceGUI).

Record from the mic or upload a file; the audio goes to MinIO, a row to Postgres and a job
onto a Redis stream for the worker (worker.py). Worker events arrive over Redis pub/sub and
are pushed to every open page, so statuses update live.
Run:  cd demo && docker compose up -d --build   ->  http://localhost:8080
"""
from __future__ import annotations

import asyncio
import html
import json
import mimetypes
import os
import re
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import datetime
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse
from nicegui import app, background_tasks, ui

import client
import store

HERE = Path(__file__).parent
PALETTE = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#fb7185", "#22d3ee", "#a3e635"]
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
async def post_recording(request: Request, ext: str = "webm", num_speakers: int | None = None):
    """The browser recorder POSTs the whole Blob here as the raw body (streamed to MinIO)."""
    try:
        rid = await submit(f"Recording {datetime.now():%H:%M}", ext,
                           num_speakers if num_speakers and 0 < num_speakers <= 20 else None,
                           request.stream(), request.headers.get("content-type", "").split(";")[0] or None)
    except store.UploadError as e:
        return JSONResponse({"error": str(e)}, status_code=413 if str(e) == "too large" else 422)
    return {"id": rid}


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


async def shutdown() -> None:
    await store.broker.stop()
    await store.close()


app.on_startup(startup)
app.on_shutdown(shutdown)
app.add_static_files("/static", HERE / "static")
ui.add_head_html('<link rel="stylesheet" href="/static/demo.css">'
                 '<script src="/static/demo.js"></script>', shared=True)


# ------------------------------------------------------------------ UI helpers
def fmt_dur(s: float | None) -> str:
    if s is None:
        return "–"
    s = int(round(s))
    return f"{s // 60}:{s % 60:02d}"


def fmt_secs(s: float | None) -> str:
    return "–" if s is None else f"{s:.1f} s"


def frame() -> None:
    with ui.header().classes("app-header"):
        with ui.link(target="/").classes("brand"):
            ui.icon("graphic_eq").classes("text-3xl")
            ui.label("Who said what")
        ui.space()
        dot = ui.element("span").classes("dot")
        status = ui.label().classes("muted")

        def refresh_health() -> None:
            ok = STATE["health_ok"]
            dot.classes(replace="dot " + ("ok" if ok else "bad" if ok is False else ""))
            status.text = f"ASR service: {STATE['health']}"
        refresh_health()
        ui.timer(2, refresh_health)
    if not client.CONFIGURED:
        ui.label("Set ASR_URL / ASR_TOKEN (or ASR_TOKEN_FILE) and restart: "
                 "recordings will be saved but cannot be transcribed.").classes("banner")


def status_chip(m: dict) -> None:
    st = m["status"]
    with ui.element("div").classes(f"chip {st}"):
        if st == "processing":
            ui.spinner(size="1em")
        elif st == "queued":
            ui.icon("schedule", size="1.1em")
        ui.label({"queued": "queued", "processing": m.get("note") or "processing", "done": "done",
                  "failed": "failed"}[st])
    if st == "failed":
        ui.label(m.get("error") or "").classes("err")


def metric(value: str, label: str) -> None:
    with ui.column().classes("metric"):
        ui.label(value).classes("metric-v")
        ui.label(label).classes("metric-l")


# ------------------------------------------------------------------ pages
@ui.page("/", title="ASR demo")
async def index() -> None:
    frame()
    ui.dark_mode(True)
    with ui.dialog() as dlg, ui.card().classes("p-6"):
        dlg_msg = ui.label().classes("text-xl")
        with ui.row().classes("w-full justify-end mt-4"):
            ui.button("Cancel", on_click=lambda: dlg.submit(False)).props("flat")
            ui.button("Delete", color="negative", on_click=lambda: dlg.submit(True))

    async def confirm_delete(m: dict) -> None:
        dlg_msg.text = f"Delete “{m['name']}” and its audio?"
        if await dlg:
            await delete(m["id"])

    async def on_upload(e) -> None:
        name = e.file.name or "upload"
        try:
            await submit(Path(name).stem[:60], Path(name).suffix.lstrip(".").lower(),
                         int(spk.value) if spk.value else None, e.file.iterate(), e.file.content_type or None)
        except store.UploadError as err:
            ui.notify(f"Upload failed: {err}", type="negative")
            return
        finally:
            up.run_method("reset")
        ui.notify(f"Uploaded {name}", type="positive")

    rec = {"on": False}

    async def toggle() -> None:
        btn.disable()
        try:
            if not rec["on"]:
                r = await ui.run_javascript("demoRec.start()", timeout=60)
                if r != "ok":
                    ui.notify(f"Microphone: {r}", type="negative")
                    return
                rec["on"] = True
                btn.props("icon=stop").classes(add="recording")
                hint.text = "Recording… press to stop"
            else:
                rec["on"] = False
                btn.props("icon=mic").classes(remove="recording")
                hint.text = "Uploading…"
                n = int(spk.value) if spk.value else 0
                r = await ui.run_javascript(f"demoRec.stop({n})", timeout=600)
                if not isinstance(r, dict) or r.get("error"):
                    ui.notify(f"Upload failed: {r.get('error') if isinstance(r, dict) else r}",
                              type="negative")
                hint.text = "Press to record"
        finally:
            btn.enable()

    with ui.column().classes("page"):
        with ui.card().classes("rec-card"):
            with ui.row().classes("rec-row items-center w-full gap-8 no-wrap"):
                btn = ui.button(icon="mic", on_click=toggle).props("round unelevated color=red-6").classes("rec-btn")
                with ui.column().classes("gap-1"):
                    ui.html('<span id="rec-time" class="rec-time">00:00</span>', sanitize=False)
                    ui.html('<div class="meter"><div id="rec-level"></div></div>', sanitize=False)
                    hint = ui.label("Press to record").classes("muted")
                ui.space()
                with ui.column().classes("items-stretch gap-3"):
                    spk = ui.number("Speakers (blank = auto)", min=1, max=20, step=1,
                                    format="%d").props("outlined clearable").classes("w-60")
                    ui.button("Upload file", icon="upload_file",
                              on_click=lambda: up.run_method("pickFiles")).props("outline")
                up = ui.upload(auto_upload=True, on_upload=on_upload, max_file_size=store.MAX_UPLOAD
                               ).props('accept="audio/*,video/*"').classes("hidden")

        ui.label("Recordings").classes("section")

        @ui.refreshable
        def listing(rows: list[dict]) -> None:
            if not rows:
                ui.label("Nothing yet: record something or upload a file.").classes("muted")
            for m in rows:
                rid = m["id"]
                with ui.card().classes("row-card").on("click", lambda rid=rid: ui.navigate.to(f"/r/{rid}")):
                    with ui.element("div").classes("row-grid"):
                        with ui.column().classes("row-name gap-0 min-w-0"):
                            ui.label(m["name"]).classes("row-title")
                            ui.label(m["created_at"].astimezone().strftime("%b %d, %H:%M")
                                     ).classes("muted whitespace-nowrap")
                        with ui.column().classes("row-status gap-1 items-start min-w-0"):
                            status_chip(m)
                        metric(fmt_dur(m["duration_s"]), "audio")
                        metric(fmt_secs(m["processing_s"]), "processing")
                        metric(f"{m['rtf']:g}×" if m["rtf"] else "–", "real time")
                        metric(str(m["speakers"]) if m["speakers"] is not None else "–", "speakers")
                        with ui.row().classes("actions no-wrap gap-0 justify-end"):
                            if m["status"] == "failed":
                                ui.button(icon="refresh").props("flat round").tooltip("Retry").on(
                                    "click.stop", lambda rid=rid: retry(rid))
                            ui.button(icon="delete_outline").props("flat round").tooltip("Delete").on(
                                "click.stop", lambda m=m: confirm_delete(m))

        listing(await store.list_recordings())

        async def on_change(_event: dict) -> None:     # pushed over the websocket: no reload
            listing.refresh(await store.list_recordings())
        listen(on_change)


def transcript_html(res: dict, colors: dict, names: dict) -> str:
    """Speaker turns from `segments`, each word a span carrying its [start, end]."""
    words, wi, prev, out = res.get("words") or [], 0, object(), []
    segs = res.get("segments") or []
    for n, seg in enumerate(segs):
        spk = seg["speaker"]
        mine = []
        while wi < len(words) and (words[wi]["end"] <= seg["end"] + 1e-3 or n == len(segs) - 1):
            mine.append(words[wi])
            wi += 1
        body = " ".join(f'<span class="w" data-s="{w["start"]}" data-e="{w["end"]}">'
                        f'{html.escape(w["word"])}</span>' for w in mine) or html.escape(seg["text"])
        head = ""
        if spk != prev:
            head = (f'<div class="who"><span class="spk-name" data-spk="{html.escape(str(spk))}">'
                    f'{html.escape(names.get(spk, str(spk)))}</span>'
                    f'<span class="ts" data-s="{seg["start"]}">{fmt_dur(seg["start"])}</span></div>')
        out.append(f'<div class="turn{"" if head else " cont"}" style="--c:{colors.get(spk, "#9ca3af")}">'
                   f'{head}<p>{body}</p></div>')
        prev = spk
    return f'<div class="transcript">{"".join(out)}</div>'


@ui.page("/r/{rid}", title="ASR demo")
async def detail(rid: str) -> None:
    frame()
    ui.dark_mode(True)
    m = await store.get(rid)
    with ui.column().classes("page"):
        ui.link("← All recordings", "/").classes("back")
        if not m:
            ui.label("Not found.").classes("text-2xl")
            return
        ui.label(m["name"]).classes("title")
        shown = {}

        async def load(m: dict) -> tuple[dict, dict | None, str]:
            """Row + transcript JSON (from MinIO, server side) + a presigned audio URL."""
            res = json.loads(await store.get_bytes(m["result_key"])) if m["status"] == "done" else None
            return m, res, await store.presigned_url(m["audio_key"])

        @ui.refreshable
        def view(m: dict, res: dict | None, audio_url: str) -> None:
            shown.update(status=m["status"], note=m["note"])
            if res is None:
                with ui.row().classes("items-center gap-4"):
                    status_chip(m)
                ui.audio(audio_url).classes("w-full")
                return
            render_result(m, res, audio_url)

        view(*await load(m))

        async def on_change(event: dict) -> None:    # live: queued -> processing -> done
            if event["id"] != rid or shown["status"] == "done":
                return
            if (event["status"], event.get("note")) == (shown["status"], shown["note"]):
                return
            if m := await store.get(rid):
                view.refresh(*await load(m))
        listen(on_change)


def render_result(m: dict, res: dict, audio_url: str) -> None:
    rid = m["id"]
    # Number speakers by who talks first: pyannote's labels (SPEAKER_00, ...) are not
    # in order of appearance, and "Speaker 2" opening the recording reads wrong.
    first = {}
    for seg in res.get("segments") or []:
        first.setdefault(seg.get("speaker"), seg.get("start", 0))
    speakers = sorted(res.get("speakers") or [], key=lambda s: first.get(s, float("inf")))
    colors = {s: PALETTE[i % len(PALETTE)] for i, s in enumerate(speakers)}
    names = {s: m["speaker_names"].get(s) or f"Speaker {i + 1}" for i, s in enumerate(speakers)}

    with ui.element("div").classes("player-bar"):
        ui.audio(audio_url).classes("w-full")
    with ui.element("div").classes("top-row"):
        with ui.card().classes("side-card"):
            ui.label("Speakers").classes("side-h")
            with ui.element("div").classes("spk-grid"):
                for s in speakers:
                    with ui.row().classes("items-center no-wrap gap-3"):
                        ui.element("span").classes("swatch").style(f"background:{colors[s]}")

                        async def rename(e, s=s) -> None:
                            await store.rename_speaker(rid, s, e.value)
                            ui.run_javascript(f"demoRename({json.dumps(s)}, {json.dumps(e.value or s)})")
                        ui.input(value=names[s], on_change=rename).props("dense borderless").classes("spk-input")
        with ui.card().classes("side-card"):
            with ui.row().classes("w-full items-center no-wrap"):
                ui.label("Stats").classes("side-h")
                ui.space()
                ui.button("Download JSON", icon="download", on_click=lambda: ui.download.content(
                    json.dumps(res, indent=1), f"{rid}.json", "application/json")).props("outline dense no-caps").classes("px-3")
            model = res.get("model") or {}
            rows = [("Audio", fmt_dur(m["duration_s"])), ("Processing", fmt_secs(m["processing_s"])),
                    ("Speed", f"{m['rtf']:g}× real time" if m["rtf"] else "–"),
                    ("Speakers", str(len(speakers))), ("Words", str(len(res.get("words") or []))),
                    ("STT", model.get("stt") or "–"),
                    ("Diarization", (model.get("diarization") or "–").split("/")[-1])]
            with ui.element("div").classes("stats"):
                for k, v in rows:
                    with ui.element("div").classes("stat wide" if k in ("STT", "Diarization") else "stat"):
                        ui.label(k).classes("stat-l")
                        ui.label(v).classes("stat-v")
    segs = res.get("segments") or []
    n_turns = sum(1 for i, g in enumerate(segs) if i == 0 or g.get("speaker") != segs[i - 1].get("speaker"))
    n_words = len(res.get("words") or [])
    with ui.expansion(f"Transcript · {n_turns} turn{'s' * (n_turns != 1)} · {n_words} word{'s' * (n_words != 1)}",
                      value=True).classes("transcript-exp w-full"):
        ui.html(transcript_html(res, colors, names), sanitize=False).classes("w-full")


if __name__ in {"__main__", "__mp_main__"}:
    ui.run(host=os.environ.get("DEMO_HOST", "127.0.0.1"), port=int(os.environ.get("DEMO_PORT", "8080")), title="ASR demo", dark=True, reload=False,
           show=False, favicon="🎙️")
