"""ASR + diarization demo UI (NiceGUI).

Record from the mic or upload a file, send it to the ASR service, browse the results.
Run:  cd demo && uv run python app.py   ->  http://localhost:8080
"""
from __future__ import annotations

import asyncio
import html
import json
import os
import re
import secrets
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse
from nicegui import app, background_tasks, ui

import client

HERE = Path(__file__).parent
DATA = Path(os.environ.get("DEMO_DATA_DIR") or HERE / "data")
DATA.mkdir(parents=True, exist_ok=True)
MAX_UPLOAD = 500 * 1024 * 1024
PALETTE = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#fb7185", "#22d3ee", "#a3e635"]

RECORDS: dict[str, dict] = {}      # id -> meta (mirrors data/<id>/meta.json)
STATE = {"version": 0, "health_ok": None, "health": "checking"}


# ------------------------------------------------------------------ records
def save(rid: str) -> None:
    if rid not in RECORDS or not (DATA / rid).is_dir():
        return                              # deleted meanwhile
    tmp = DATA / rid / "meta.json.tmp"
    tmp.write_text(json.dumps(RECORDS[rid], indent=2))
    tmp.replace(DATA / rid / "meta.json")
    STATE["version"] += 1


def load_all() -> None:
    for meta in DATA.glob("*/meta.json"):
        try:
            m = json.loads(meta.read_text())
        except (OSError, ValueError):
            continue
        RECORDS[m["id"]] = m
        if m["status"] == "processing":     # the app stopped mid-call
            m.update(status="failed", error="interrupted (demo app restarted)", note=None)
            save(m["id"])


def new_record(name: str, ext: str, num_speakers: int | None) -> str:
    rid = datetime.now().strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(2)
    (DATA / rid).mkdir()
    RECORDS[rid] = {"id": rid, "name": name, "created_at": datetime.now().isoformat(timespec="seconds"),
                    "audio": f"audio.{ext}", "num_speakers": num_speakers, "status": "processing",
                    "note": "queued", "error": None, "duration_s": None, "processing_s": None,
                    "rtf": None, "speakers": None, "speaker_names": {}}
    return rid


def _ffmpeg_prepare(path: Path) -> float | None:
    """Remux browser webm (no duration/cues, so it can't seek) and probe the duration."""
    if not shutil.which("ffmpeg"):
        return None
    if path.suffix == ".webm":
        fixed = path.with_name("remux.webm")
        p = subprocess.run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-i", str(path),
                            "-c", "copy", str(fixed)], capture_output=True, timeout=300)
        if p.returncode == 0 and fixed.stat().st_size > 0:
            fixed.replace(path)
        else:
            fixed.unlink(missing_ok=True)
    p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", str(path)], capture_output=True, text=True, timeout=60)
    try:
        return round(float(p.stdout.strip()), 2)
    except ValueError:
        return None


async def process(rid: str) -> None:
    m = RECORDS[rid]
    m.update(status="processing", error=None, note="preparing audio")
    save(rid)
    audio = DATA / rid / m["audio"]
    dur = await asyncio.to_thread(_ffmpeg_prepare, audio)
    if dur:
        m["duration_s"] = dur

    def note(text: str) -> None:
        m["note"] = text
        save(rid)

    note("transcribing")
    try:
        res, took = await client.transcribe(audio, m.get("num_speakers"), on_status=note)
    except client.ASRError as e:
        m.update(status="failed", error=str(e), note=None)
    except Exception as e:  # noqa: BLE001 -- show anything unexpected in the list
        m.update(status="failed", error=f"{type(e).__name__}: {e}", note=None)
    else:
        if rid not in RECORDS:
            return
        (DATA / rid / "response.json").write_text(json.dumps(res, indent=1))
        d = res.get("duration_s") or m["duration_s"] or 0
        m.update(status="done", note=None, duration_s=d, processing_s=round(took, 2),
                 rtf=round(d / took, 1) if took else None,   # x real time (audio s per wall s)
                 speakers=len(res.get("speakers") or []), model=res.get("model"),
                 words=len(res.get("words") or []))
    save(rid)


def start(rid: str) -> None:
    save(rid)
    background_tasks.create(process(rid), name=f"asr-{rid}")


def delete(rid: str) -> None:
    RECORDS.pop(rid, None)
    shutil.rmtree(DATA / rid, ignore_errors=True)
    STATE["version"] += 1


# ------------------------------------------------------------------ backend routes
@app.post("/api/recordings")
async def post_recording(request: Request, ext: str = "webm", num_speakers: int | None = None):
    """The browser recorder POSTs the whole Blob here as the raw body (streamed to disk)."""
    ext = ext if re.fullmatch(r"[a-z0-9]{1,5}", ext) else "webm"
    rid = new_record(f"Recording {datetime.now():%H:%M}", ext,
                     num_speakers if num_speakers and 0 < num_speakers <= 20 else None)
    size = 0
    with open(DATA / rid / f"audio.{ext}", "wb") as f:
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_UPLOAD:
                break
            f.write(chunk)
    if size == 0 or size > MAX_UPLOAD:
        delete(rid)
        return JSONResponse({"error": "empty or too large"}, status_code=413 if size else 422)
    start(rid)
    return {"id": rid, "bytes": size}


async def health_loop() -> None:
    while True:
        ok, text = await client.health()
        STATE.update(health_ok=ok, health=text)
        await asyncio.sleep(10)


app.on_startup(load_all)
app.on_startup(lambda: background_tasks.create(health_loop(), name="health"))
app.add_media_files("/media", DATA)
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
        ui.label({"processing": m.get("note") or "processing", "done": "done",
                  "failed": "failed"}[st])
    if st == "failed":
        ui.label(m.get("error") or "").classes("err")


def metric(value: str, label: str) -> None:
    with ui.column().classes("metric"):
        ui.label(value).classes("metric-v")
        ui.label(label).classes("metric-l")


# ------------------------------------------------------------------ pages
@ui.page("/", title="ASR demo")
def index() -> None:
    frame()
    ui.dark_mode(True)
    with ui.dialog() as dlg, ui.card().classes("p-6"):
        dlg_msg = ui.label().classes("text-xl")
        with ui.row().classes("w-full justify-end mt-4"):
            ui.button("Cancel", on_click=lambda: dlg.submit(False)).props("flat")
            ui.button("Delete", color="negative", on_click=lambda: dlg.submit(True))

    async def confirm_delete(rid: str) -> None:
        dlg_msg.text = f"Delete “{RECORDS[rid]['name']}” and its audio?"
        if await dlg:
            delete(rid)

    async def on_upload(e) -> None:
        name = e.file.name or "upload"
        ext = Path(name).suffix.lstrip(".").lower()
        rid = new_record(Path(name).stem[:60], ext if re.fullmatch(r"[a-z0-9]{1,5}", ext) else "bin",
                         int(spk.value) if spk.value else None)
        await e.file.save(DATA / rid / RECORDS[rid]["audio"])
        start(rid)
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
                up = ui.upload(auto_upload=True, on_upload=on_upload, max_file_size=MAX_UPLOAD
                               ).props('accept="audio/*,video/*"').classes("hidden")

        ui.label("Recordings").classes("section")

        @ui.refreshable
        def listing() -> None:
            if not RECORDS:
                ui.label("Nothing yet: record something or upload a file.").classes("muted")
            for m in sorted(RECORDS.values(), key=lambda m: m["created_at"], reverse=True):
                rid = m["id"]
                with ui.card().classes("row-card").on("click", lambda rid=rid: ui.navigate.to(f"/r/{rid}")):
                    with ui.element("div").classes("row-grid"):
                        with ui.column().classes("row-name gap-0 min-w-0"):
                            ui.label(m["name"]).classes("row-title")
                            ui.label(datetime.fromisoformat(m["created_at"]).strftime("%b %d, %H:%M")
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
                                    "click.stop", lambda rid=rid: start(rid))
                            ui.button(icon="delete_outline").props("flat round").tooltip("Delete").on(
                                "click.stop", lambda rid=rid: confirm_delete(rid))

        listing()
        seen = {"v": STATE["version"]}

        def poll() -> None:
            if seen["v"] != STATE["version"]:
                seen["v"] = STATE["version"]
                listing.refresh()
        ui.timer(1, poll)


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
def detail(rid: str) -> None:
    frame()
    ui.dark_mode(True)
    m = RECORDS.get(rid)
    with ui.column().classes("page"):
        ui.link("← All recordings", "/").classes("back")
        if not m:
            ui.label("Not found.").classes("text-2xl")
            return
        ui.label(m["name"]).classes("title")
        if m["status"] != "done":
            with ui.row().classes("items-center gap-4"):
                status_chip(m)
            v0 = m["status"], m.get("note")
            ui.timer(1, lambda: ui.navigate.reload() if (m["status"], m.get("note")) != v0 else None)
            ui.audio(f"/media/{rid}/{m['audio']}").classes("w-full")
            return
        res = json.loads((DATA / rid / "response.json").read_text())
        # Number speakers by who talks first: pyannote's labels (SPEAKER_00, ...) are not
        # in order of appearance, and "Speaker 2" opening the recording reads wrong.
        first = {}
        for seg in res.get("segments") or []:
            first.setdefault(seg.get("speaker"), seg.get("start", 0))
        speakers = sorted(res.get("speakers") or [], key=lambda s: first.get(s, float("inf")))
        colors = {s: PALETTE[i % len(PALETTE)] for i, s in enumerate(speakers)}
        names = {s: m.get("speaker_names", {}).get(s) or f"Speaker {i + 1}" for i, s in enumerate(speakers)}

        with ui.element("div").classes("player-bar"):
            ui.audio(f"/media/{rid}/{m['audio']}").classes("w-full")
        with ui.element("div").classes("top-row"):
            with ui.card().classes("side-card"):
                ui.label("Speakers").classes("side-h")
                with ui.element("div").classes("spk-grid"):
                    for s in speakers:
                        with ui.row().classes("items-center no-wrap gap-3"):
                            ui.element("span").classes("swatch").style(f"background:{colors[s]}")

                            def rename(e, s=s) -> None:
                                m.setdefault("speaker_names", {})[s] = e.value
                                save(rid)
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
