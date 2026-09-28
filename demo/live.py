"""Live captions: a WebSocket proxy from the browser to the streaming ASR service (../stream).

    browser ──/ws/live──► ui (this) ──ASR_STREAM_URL + Authorization: Bearer──► GPU box :9101

The browser sends the start message and 16 kHz PCM; the token is added here, server side,
and never reaches the page. Anything the browser puts in the start message besides the known
fields (a "token" included) is dropped. Bounded on purpose: a short connect timeout, a cap on
message sizes, and no buffering beyond the socket's own small queues: if either side stops
reading for SEND_TIMEOUT_S the session is dropped instead of piling up audio. Logs session
start / end and why, never audio, text or the token.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from urllib.parse import urlsplit

import httpx
from fastapi import WebSocket, WebSocketDisconnect
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus

import client   # loads demo/.env and the token

STREAM_URL = os.environ.get("ASR_STREAM_URL", "").strip()
CONFIGURED = bool(STREAM_URL and client._TOKEN)
MAX_AUDIO_BYTES = 1 << 20          # the service's own per-message limit
MAX_TEXT_BYTES = 4096              # start / stop control messages from the browser
MAX_UPSTREAM_BYTES = 8 << 20       # a "final" of a long session is the biggest message
CONNECT_TIMEOUT_S = 5
START_TIMEOUT_S = 10
SEND_TIMEOUT_S = 5                 # a peer that does not take a message within this is dropped
SR = 16000

log = logging.getLogger("live")
if not log.handlers:               # NiceGUI/uvicorn don't configure app loggers
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    log.addHandler(_h)
    log.setLevel(logging.INFO)
    log.propagate = False


def health_url() -> str:
    u = urlsplit(STREAM_URL)
    scheme = {"ws": "http", "wss": "https"}.get(u.scheme, u.scheme)
    return f"{scheme}://{u.netloc}/health"


async def health() -> tuple[bool, str]:
    """(ok, short status text) from the streaming service's GET /health (no auth needed)."""
    if not STREAM_URL:
        return False, "ASR_STREAM_URL not set"
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(health_url())
        body = r.json()
        if r.status_code == 200:
            return True, f"{body.get('sessions', 0)}/{body.get('max_sessions', '?')} sessions"
        return False, str(body.get("status") or r.status_code)
    except (httpx.HTTPError, ValueError) as e:
        return False, f"unreachable ({type(e).__name__})"


def clean_start(msg: dict) -> dict:
    """Only the fields the service knows, validated; never a browser-supplied token."""
    try:
        spk = int(msg.get("max_speakers", 4))
    except (TypeError, ValueError):
        spk = 4
    lang = str(msg.get("language") or "auto")
    if len(lang) > 16 or not all(ch.isalnum() or ch == "-" for ch in lang):
        lang = "auto"
    return {"type": "start", "sample_rate": SR, "encoding": "pcm_s16le",
            "language": lang, "max_speakers": min(max(spk, 1), 4)}


def same_origin(ws: WebSocket) -> bool:
    """Refuse cross-site pages (they could otherwise use the GPU through this proxy)."""
    origin = ws.headers.get("origin")
    return not origin or urlsplit(origin).netloc == ws.headers.get("host", "")


async def fail(ws: WebSocket, code: str, message: str, close_code: int = 1011) -> None:
    try:
        await ws.send_text(json.dumps({"type": "error", "code": code, "message": message}))
        await ws.close(close_code)
    except Exception:   # noqa: BLE001 -- browser already gone
        pass


async def proxy(browser: WebSocket) -> None:
    if not same_origin(browser):
        await browser.close(1008)
        return
    await browser.accept()
    if not CONFIGURED:
        await fail(browser, "unavailable", "live captions are not configured (ASR_STREAM_URL)", 1011)
        return
    try:
        raw = await asyncio.wait_for(browser.receive_text(), START_TIMEOUT_S)
        first = json.loads(raw) if len(raw) <= MAX_TEXT_BYTES else None
        assert isinstance(first, dict) and first.get("type") == "start"
    except WebSocketDisconnect:
        return
    except (asyncio.TimeoutError, AssertionError, ValueError, KeyError, RuntimeError):
        await fail(browser, "bad_request", 'first message must be {"type":"start",...}', 1008)
        return
    start = clean_start(first)

    try:
        upstream = await connect(STREAM_URL, additional_headers={"Authorization": f"Bearer {client._TOKEN}"},
                                 open_timeout=CONNECT_TIMEOUT_S, max_size=MAX_UPSTREAM_BYTES,
                                 max_queue=16, ping_interval=20, ping_timeout=20, close_timeout=3)
    except InvalidStatus as e:
        code = {401: "unauthorized", 403: "unauthorized", 503: "loading"}.get(e.response.status_code, "unavailable")
        log.info("live upstream refused: HTTP %s", e.response.status_code)
        await fail(browser, code, f"live service refused the connection (HTTP {e.response.status_code})")
        return
    except (OSError, asyncio.TimeoutError, InvalidHandshake) as e:
        log.info("live upstream unreachable: %s", type(e).__name__)
        await fail(browser, "unavailable", f"live service unreachable ({type(e).__name__})")
        return

    t0, sid, sent = time.monotonic(), "-", 0
    reason = "client_stop"
    log.info("live session open max_speakers=%d language=%s", start["max_speakers"], start["language"])

    async def up() -> str:
        """browser -> service: audio as-is (size-checked), a stop, nothing else."""
        nonlocal sent
        while True:
            msg = await browser.receive()
            if msg["type"] == "websocket.disconnect":
                return "browser_disconnect"
            if (b := msg.get("bytes")) is not None:
                if len(b) > MAX_AUDIO_BYTES or len(b) % 2:
                    await fail(browser, "bad_request", "audio messages must be whole pcm_s16le samples, at most 1 MiB", 1009)
                    return "bad_audio"
                await asyncio.wait_for(upstream.send(b), SEND_TIMEOUT_S)
                sent += len(b)
            elif (t := msg.get("text")) is not None and len(t) <= MAX_TEXT_BYTES:
                try:
                    ctl = json.loads(t)
                except ValueError:
                    continue
                if isinstance(ctl, dict) and ctl.get("type") == "stop":
                    await asyncio.wait_for(upstream.send('{"type":"stop"}'), SEND_TIMEOUT_S)

    async def down() -> str:
        """service -> browser: every JSON message; its close ends the session."""
        nonlocal sid
        try:
            async for m in upstream:
                if isinstance(m, bytes):
                    continue
                if sid == "-" and '"ready"' in m[:40]:
                    sid = json.loads(m).get("session_id", "-")
                await asyncio.wait_for(browser.send_text(m), SEND_TIMEOUT_S)
        except ConnectionClosed:
            pass
        rc = upstream.close_code or 1000
        if rc != 1000:
            reason_text = upstream.close_reason or ""
            return f"upstream_closed_{rc}" + (f" ({reason_text})" if reason_text else "")
        return "final"

    try:
        await upstream.send(json.dumps(start))
        tasks = {asyncio.create_task(up(), name="live-up"), asyncio.create_task(down(), name="live-down")}
        finished, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        task = finished.pop()
        try:
            reason = task.result()
        except asyncio.TimeoutError:
            reason = "slow_peer"
        except (WebSocketDisconnect, ConnectionClosed):
            reason = "disconnect"
        except Exception as e:   # noqa: BLE001
            reason = f"error ({type(e).__name__})"
        for p in pending:
            p.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
    finally:
        if reason in ("browser_disconnect", "disconnect", "slow_peer", "bad_audio") or reason.startswith("error"):
            try:        # let the service end the session cleanly instead of by timeout
                await asyncio.wait_for(upstream.send('{"type":"stop"}'), 1)
            except Exception:   # noqa: BLE001
                pass
        await upstream.close()
        if reason == "slow_peer":
            await fail(browser, "slow", "live captions fell behind; stopped", 1011)
        else:
            code = upstream.close_code if upstream.close_code in (1000, 1003, 1008, 1009, 1011, 1013) else 1000
            try:
                await browser.close(code)
            except Exception:   # noqa: BLE001
                pass
        log.info("live session end session=%s reason=%s audio_s=%.1f wall_s=%.1f",
                 sid, reason, sent / 2 / SR, time.monotonic() - t0)
