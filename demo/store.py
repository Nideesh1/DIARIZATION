"""Shared plumbing for the ui and the worker: Postgres rows, MinIO objects, Redis messages.

  Postgres  recordings table (sql/schema.sql): status + stats, what the list shows
  MinIO     bucket `recordings`: <id>/audio.<ext> and <id>/result.json (the ASR response)
  Redis     stream `asr-jobs` (ui -> worker, consumer group) and
            channel `recordings.events` (worker/ui -> every ui process, live updates)
"""
from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack
from pathlib import Path

import asyncpg
from aiobotocore.config import AioConfig
from aiobotocore.session import get_session
from faststream.redis import RedisBroker

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://demo:demo@localhost:5432/demo")
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "http://localhost:9000")            # used by the containers
S3_PUBLIC_ENDPOINT = os.environ.get("S3_PUBLIC_ENDPOINT", "http://localhost:9000")  # reachable by the browser
S3_ACCESS_KEY = os.environ.get("S3_ACCESS_KEY", "")
S3_SECRET_KEY = os.environ.get("S3_SECRET_KEY", "")
BUCKET = os.environ.get("S3_BUCKET", "recordings")

JOBS = "asr-jobs"                 # Redis stream: one message {"id": ...} per job
EVENTS = "recordings.events"      # Redis pub/sub: {"id", "status", "note"} on every change
MAX_UPLOAD = 500 * 1024 * 1024
PART = 8 * 1024 * 1024            # multipart upload part size (S3 minimum is 5 MB)

broker = RedisBroker(REDIS_URL, graceful_timeout=30)   # on stop, let running jobs finish
_stack = AsyncExitStack()
db: asyncpg.Pool
s3 = s3_public = None             # aiobotocore clients: internal endpoint / public one (signing only)


class UploadError(Exception):
    """Empty or too large upload."""


# ------------------------------------------------------------------ lifecycle
async def _init_conn(conn: asyncpg.Connection) -> None:
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def connect() -> None:
    global db, s3, s3_public
    db = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=5, init=_init_conn)
    async with db.acquire() as conn, conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock(4242)")   # ui and worker may start together
        await conn.execute((Path(__file__).parent / "sql" / "schema.sql").read_text())
    session = get_session()
    cfg = AioConfig(signature_version="s3v4", s3={"addressing_style": "path"})

    def client(endpoint: str):
        return session.create_client("s3", endpoint_url=endpoint, region_name="us-east-1", config=cfg,
                                     aws_access_key_id=S3_ACCESS_KEY, aws_secret_access_key=S3_SECRET_KEY)
    s3 = await _stack.enter_async_context(client(S3_ENDPOINT))
    # Presigned URLs embed the host they were signed for, so sign with the browser-facing
    # endpoint. Signing is local: this client never has to reach localhost:9000 itself.
    s3_public = await _stack.enter_async_context(client(S3_PUBLIC_ENDPOINT))


async def close() -> None:
    await _stack.aclose()
    await db.close()


# ------------------------------------------------------------------ Postgres
def _row(r: asyncpg.Record | None) -> dict | None:
    return dict(r) if r else None


async def list_recordings() -> list[dict]:
    return [dict(r) for r in await db.fetch("SELECT * FROM recordings ORDER BY created_at DESC")]


async def get(rid: str) -> dict | None:
    return _row(await db.fetchrow("SELECT * FROM recordings WHERE id = $1", rid))


def audio_key(rid: str, ext: str) -> str:
    return f"{rid}/audio.{ext}"


async def insert(rid: str, name: str, ext: str, num_speakers: int | None) -> None:
    await db.execute("INSERT INTO recordings (id, name, ext, audio_key, num_speakers_hint) "
                     "VALUES ($1, $2, $3, $4, $5)", rid, name, ext, audio_key(rid, ext), num_speakers)


async def claim(rid: str) -> dict | None:
    """queued -> processing. Only one caller wins; anyone else gets None (idempotency)."""
    return _row(await db.fetchrow(
        "UPDATE recordings SET status = 'processing', note = 'preparing audio', error = NULL, "
        "updated_at = now() WHERE id = $1 AND status = 'queued' RETURNING *", rid))


async def update(rid: str, **fields) -> bool:
    """Set columns on a row; False if the row is gone (deleted meanwhile)."""
    cols = ", ".join(f"{k} = ${i}" for i, k in enumerate(fields, start=2))
    res = await db.execute(f"UPDATE recordings SET {cols}, updated_at = now() WHERE id = $1",
                           rid, *fields.values())
    return res != "UPDATE 0"


async def requeue(rid: str) -> bool:
    """failed -> queued (the retry button)."""
    res = await db.execute("UPDATE recordings SET status = 'queued', error = NULL, note = NULL, "
                           "updated_at = now() WHERE id = $1 AND status = 'failed'", rid)
    return res == "UPDATE 1"


async def requeue_interrupted() -> list[str]:
    """processing -> queued for jobs a stopped worker left behind (single-worker setup)."""
    rows = await db.fetch("UPDATE recordings SET status = 'queued', note = NULL, updated_at = now() "
                          "WHERE status = 'processing' RETURNING id")
    return [r["id"] for r in rows]


async def rename_speaker(rid: str, speaker: str, name: str) -> None:
    await db.execute("UPDATE recordings SET speaker_names = speaker_names || jsonb_build_object($2::text, $3::text) "
                     "WHERE id = $1", rid, speaker, name)


async def rename(rid: str, name: str) -> None:
    await db.execute("UPDATE recordings SET name = $2 WHERE id = $1", rid, name)


async def delete(rid: str) -> None:
    await db.execute("DELETE FROM recordings WHERE id = $1", rid)
    await delete_objects(rid)


# ------------------------------------------------------------------ MinIO (S3 API)
async def put_stream(key: str, chunks: AsyncIterator[bytes], content_type: str) -> int:
    """Stream an upload into MinIO without holding it in memory: small bodies go up in one
    PUT, bigger ones as a multipart upload in 8 MB parts. Returns the size in bytes."""
    buf, parts, upload_id, size = bytearray(), [], None, 0

    async def flush() -> None:
        r = await s3.upload_part(Bucket=BUCKET, Key=key, UploadId=upload_id,
                                 PartNumber=len(parts) + 1, Body=bytes(buf))
        parts.append({"ETag": r["ETag"], "PartNumber": len(parts) + 1})
        buf.clear()
    try:
        async for chunk in chunks:
            size += len(chunk)
            if size > MAX_UPLOAD:
                raise UploadError("too large")
            buf += chunk
            if len(buf) >= PART:
                if upload_id is None:
                    upload_id = (await s3.create_multipart_upload(
                        Bucket=BUCKET, Key=key, ContentType=content_type))["UploadId"]
                await flush()
        if size == 0:
            raise UploadError("empty")
        if upload_id is None:
            await s3.put_object(Bucket=BUCKET, Key=key, Body=bytes(buf), ContentType=content_type)
        else:
            if buf:
                await flush()
            await s3.complete_multipart_upload(Bucket=BUCKET, Key=key, UploadId=upload_id,
                                               MultipartUpload={"Parts": parts})
    except BaseException:
        if upload_id:
            await s3.abort_multipart_upload(Bucket=BUCKET, Key=key, UploadId=upload_id)
        raise
    return size


async def put_bytes(key: str, data: bytes, content_type: str) -> None:
    await s3.put_object(Bucket=BUCKET, Key=key, Body=data, ContentType=content_type)


async def get_bytes(key: str) -> bytes:
    r = await s3.get_object(Bucket=BUCKET, Key=key)
    async with r["Body"] as body:
        return await body.read()


async def download(key: str, path: Path) -> None:
    r = await s3.get_object(Bucket=BUCKET, Key=key)
    async with r["Body"] as body:
        with open(path, "wb") as f:
            async for chunk in body.iter_chunks(1024 * 1024):
                f.write(chunk)


async def presigned_url(key: str, seconds: int = 3600) -> str:
    """A short-lived GET URL the browser can play directly from MinIO."""
    return await s3_public.generate_presigned_url(
        "get_object", Params={"Bucket": BUCKET, "Key": key}, ExpiresIn=seconds)


async def delete_objects(rid: str) -> None:
    r = await s3.list_objects_v2(Bucket=BUCKET, Prefix=f"{rid}/")
    if keys := [{"Key": o["Key"]} for o in r.get("Contents", [])]:
        await s3.delete_objects(Bucket=BUCKET, Delete={"Objects": keys})


# ------------------------------------------------------------------ Redis
async def enqueue(rid: str) -> None:
    await broker.publish({"id": rid}, stream=JOBS)


async def announce(rid: str, status: str, note: str | None = None) -> None:
    await broker.publish({"id": rid, "status": status, "note": note}, channel=EVENTS)
