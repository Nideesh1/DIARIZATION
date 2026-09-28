"""Tiny async client for the ASR + diarization service (see ../README.md, "API").

Config comes from the environment, or from demo/.env (real env vars override it):
  ASR_URL         e.g. http://192.168.1.50:9100
  ASR_TOKEN       bearer token, or
  ASR_TOKEN_FILE  path to a file holding the token (a bare token or an asr.env line ASR_TOKEN=...)
The token is only ever placed in the Authorization header: never logged or shown.
"""
from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
from typing import Awaitable, Callable

import httpx



def _load_dotenv(path: Path) -> None:
    """KEY=VALUE lines from demo/.env; variables already in the environment win."""
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.removeprefix("export ").strip()
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "'\"":
            val = val[1:-1]
        os.environ.setdefault(key, val)


_load_dotenv(Path(__file__).parent / ".env")
ASR_URL = os.environ.get("ASR_URL", "").strip().rstrip("/")


def _load_token() -> str:
    tok = os.environ.get("ASR_TOKEN", "").strip()
    path = os.environ.get("ASR_TOKEN_FILE", "").strip()
    if tok or not path:
        return tok
    try:
        text = Path(path).expanduser().read_text()
    except OSError:
        return ""
    for line in text.splitlines():          # asr.env style
        if line.startswith("ASR_TOKEN="):
            return line.split("=", 1)[1].strip()
    return text.strip()


_TOKEN = _load_token()
CONFIGURED = bool(ASR_URL and _TOKEN)
MAX_RETRIES = 3          # on 503 (busy / models loading)


class ASRError(Exception):
    """A failed call, with a short human-readable reason."""


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {_TOKEN}"}


async def health() -> tuple[bool, str]:
    """(ok, short status text) from GET /health."""
    if not ASR_URL:
        return False, "ASR_URL not set"
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(f"{ASR_URL}/health")
        status = r.json().get("status", str(r.status_code))
        return r.status_code == 200, status
    except (httpx.HTTPError, ValueError) as e:
        return False, f"unreachable ({type(e).__name__})"


def _reason(r: httpx.Response) -> str:
    try:
        detail = r.json().get("error", "")
    except ValueError:
        detail = ""
    base = {401: "unauthorized: check ASR_TOKEN", 413: "too large / too long",
            422: "could not decode audio", 500: "service internal error"}.get(r.status_code, "")
    extra = f" ({detail})" if detail and detail not in base else ""
    return f"HTTP {r.status_code}" + (f" {base}" if base else "") + extra


async def transcribe(audio: Path, num_speakers: int | None,
                     on_status: Callable[[str], Awaitable[None] | None] | None = None,
                     ) -> tuple[dict, float]:
    """POST the file to /v1/transcribe?diarize=true; retry politely on 503 + Retry-After.

    Returns (response, seconds): the wall time of the successful request, so waiting
    out a busy service does not count as processing time."""
    if not CONFIGURED:
        raise ASRError("set ASR_URL / ASR_TOKEN")
    params = {"diarize": "true"}
    if num_speakers:
        params["num_speakers"] = str(num_speakers)
    body = await asyncio.to_thread(audio.read_bytes)
    timeout = httpx.Timeout(600, connect=10)
    async with httpx.AsyncClient(timeout=timeout) as c:
        for attempt in range(MAX_RETRIES + 1):
            t0 = time.monotonic()
            try:
                r = await c.post(f"{ASR_URL}/v1/transcribe", params=params,
                                 content=body, headers=_headers())
            except httpx.TimeoutException:
                raise ASRError("timed out waiting for the service") from None
            except httpx.HTTPError as e:
                raise ASRError(f"service unreachable ({type(e).__name__})") from None
            if r.status_code == 200:
                return r.json(), time.monotonic() - t0
            if r.status_code == 503 and attempt < MAX_RETRIES:
                try:
                    wait = min(max(int(r.headers.get("Retry-After", "15")), 1), 60)
                except ValueError:
                    wait = 15
                if on_status:
                    res = on_status(f"service busy, retry {attempt + 1}/{MAX_RETRIES} in {wait}s")
                    if asyncio.iscoroutine(res):
                        await res
                await asyncio.sleep(wait)
                continue
            raise ASRError(_reason(r))
    raise ASRError("service busy, gave up")
