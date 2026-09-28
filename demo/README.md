# Demo UI: "Who said what"

A small [NiceGUI](https://nicegui.io) web app for showing off the ASR + diarization
service: record from the microphone (or drop in a file) and browse the results — a speaker-coloured
waveform, the transcript split into speaker turns, the current word highlighted as the
audio plays, click any word to jump there.

It is built like a small production pipeline: the web app never calls the GPU service
itself. It stores the audio in object storage, writes a row to Postgres and puts a job on a
queue; a separate worker does the transcription and reports back, and every open browser
updates live.

The recorder has two modes (a `LIVE | RECORD` switch, remembered in the browser; see
[Two modes](#two-modes-live-and-record)):

- **LIVE**: a focused live view while you talk: a sticky recording bar and the transcript as
  speaker-coloured chat turns, about 0.2–0.3 s behind the voice, from a separate streaming service
  (Nemotron). On stop that live transcript is saved as the recording's result (no batch job) and
  you land on its page; **Upgrade to accurate transcript** runs the batch pass on it later.
- **RECORD** (and every upload): record, then the queue → worker → batch service (Parakeet +
  pyannote) builds the accurate, word-timed transcript. No live connection is opened.

## Architecture

```
browser (mic / upload)
   │  POST audio
   ▼
 ui (NiceGUI) ──► MinIO     recordings/<id>/audio.<ext>
   │          ──► Postgres  recordings row, status = queued
   │          ──► Redis stream "asr-jobs"  {"id": <id>}
   │                              │
   │                              ▼
   │                  worker (FastStream, consumer group, 2 at a time)
   │                     1. claim: UPDATE ... SET status='processing' WHERE status='queued'
   │                     2. download audio from MinIO (remux browser webm, probe length)
   │                     3. POST /v1/transcribe to the GPU ASR service (503 → wait Retry-After, retry)
   │                     4. result JSON → MinIO recordings/<id>/result.json
   │                        stats/status → Postgres (done, or failed + reason), ACK
   │                     5. PUBLISH "recordings.events" {"id", "status", "note"}
   │                              │
   ◄──────── Redis pub/sub ───────┘
 ui pushes the change over its websocket to every open page (queued → processing → done/failed)
 browser plays audio straight from MinIO with a presigned URL (1 h)
```

| Service | What it does |
|---------|--------------|
| `ui` | NiceGUI pages + `/api/recordings` upload route; streams uploads into MinIO, inserts the row, enqueues the job, pushes live updates. Port `127.0.0.1:8080`. |
| `worker` | FastStream consumer of the `asr-jobs` Redis stream (consumer group `asr-workers`, 2 consumers = 2 jobs in flight, matching the service's `MAX_JOBS`). Same image as `ui`. |
| `postgres` | `recordings` table (`sql/schema.sql`, applied on startup): status, error, stats, model names, speaker names. Not published. |
| `redis` | The job stream and the pub/sub event channel. Not published. |
| `minio` | S3-compatible object storage, bucket `recordings`. API on `127.0.0.1:9000` (the browser fetches audio here), console on `127.0.0.1:9001`. |
| `minio-init` | One-shot: creates the bucket, then exits. |

## Two modes: LIVE and RECORD

Every recording row has a `source`: `live` (saved from the live service) or `batch` (the batch
pass). Cards and the detail page show it as **LIVE · NEMOTRON** or **BATCH · PARAKEET + PYANNOTE**.

```
LIVE mode, while recording:
                  browser mic ─┬─ MediaRecorder ─► the file (kept in memory until stop)
                               └─ AudioWorklet (16 kHz PCM, ~80 ms batches)
                                      │  WebSocket /ws/live            (same origin, no token)
                                      ▼
                                  ui proxy (live.py) ── adds Authorization: Bearer <ASR_TOKEN>
                                      │  ASR_STREAM_URL  ws://<gpu-box>:9101/v1/stream
                                      ▼
                                  streaming ASR + speaker labels (../stream, Nemotron)
                                      │  {"type":"update","from":i,"segments":[…]}
                                      ▼
                                  the live view: chat turns (speaker 0 → "Speaker 1", …)
LIVE, on stop:    {"type":"stop"} → the service sends "final" (every segment) →
                  POST /api/recordings/live  (multipart: audio + {"segments", "latency_s"})
                  → ui: remux webm, audio → MinIO, result.json → MinIO, then INSERT the row
                    already done (source = live). No job.
RECORD / upload:  the file → POST /api/recordings → queue → worker → batch service :9100
                  (Parakeet + pyannote), source = batch
Upgrade:          a live recording's "Upgrade to accurate transcript" (or Re-run) = the batch
                  re-run path; it becomes source = batch, with word timings
```

- **Live**: [`nvidia/nemotron-3.5-asr-streaming-0.6b`](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b)
  with [`nvidia/Nemotron-3-Diarization`](https://huggingface.co/nvidia/Nemotron-3-Diarization), up to 4
  speakers and 4 sessions at once. The recorder's **Speakers** choice is sent as `max_speakers`
  (Auto → 4). Words arrive about 0.2 s after they are spoken (service p50) and are revised in
  place; the pill on the captions shows the measured lag. Measured in this demo with Chromium's
  fake mic playing a two-speaker clip: p50 ≈ 0.3 s, p95 ≈ 0.5 s from capture to caption.
- **Saving a live recording** is one request, so a row can never be `done` without its
  transcript: the audio and `result.json` are written to MinIO first and the row is inserted last
  (already done); any failure removes what was written. `result.json` has the batch shape as far as
  it goes (`segments` with `speaker`/`start`/`end`/`text`, `speakers`, `model`, plus `source`,
  `latency_s`) but `words` is empty: the live service has no word timings, so the detail page
  highlights and seeks by **segment** (click a turn to jump to it). Segment times are shifted by
  the small gap between MediaRecorder starting and the PCM tap starting, so they match the file.
- **Fallback**: if the live service is unavailable (or drops, or saving the live result fails),
  the LIVE view says so ("Live captions unavailable — the full transcript will be ready after you
  stop"), keeps recording, and on stop the file takes the batch path: the bar shows saved →
  queued → preparing → transcribing and the page opens the recording when it is done.
- **The proxy** (`live.py`, route `/ws/live` on NiceGUI's FastAPI app) keeps the token server side:
  it rebuilds the start message from the known fields only (any `token` from the browser is
  dropped), refuses cross-origin pages, relays binary audio up (≤ 1 MiB, whole samples) and JSON
  down, and closes both sides together (browser gone → `stop` upstream; upstream error/close →
  forwarded to the browser). It is bounded: 5 s connect timeout, 8 MiB max upstream message,
  small socket queues, and a peer that does not accept a message within 5 s drops the session
  instead of buffering. It logs session open/end with the reason and audio length, never audio,
  text or the token.
- **Never in the way**: if the live service is down, busy, loading or refuses the token, recording
  carries on normally and the batch pass makes the transcript (see Fallback).
- The header shows two pills, **Batch** (`ASR_URL/health`) and **Live** (the `/health` next to
  `ASR_STREAM_URL`), checked every 10 s by the ui.
- Browser side: one 16 kHz `AudioContext` feeds the level meter and `static/pcm-worklet.js`
  (Float32 → Int16). Firefox can't connect a mic to a 16 kHz context, so there the context runs
  at the native rate and the worklet downsamples.

Guarantees, kept simple:

- **Idempotent**: a job only runs if its row is `queued`; the claim is one conditional
  `UPDATE`, so a duplicate or re-delivered message for a row that is processing or done is
  skipped and ACKed.
- **Retry**: the retry button on a failed row sets it back to `queued` and enqueues it again.
- **Worker restarts**: on stop the worker finishes the jobs in flight first (30 s grace), so
  `docker compose restart worker` mid-job just completes the job. If it is killed instead
  (crash, `docker compose kill`), the next start puts rows still `processing` back on the
  queue and ACKs the stale deliveries, so the job runs again from the start. This assumes
  one worker container; with several you would reclaim per consumer (`XAUTOCLAIM`) and hold
  a lease on the row.
- **Busy service**: the worker never sends more than 2 jobs at once, and a `503` (busy or
  models loading) is retried up to three times honouring `Retry-After`, shown live as
  "service busy, retry 1/3 in 15s".

## Run

Needs Docker (Docker Desktop on macOS) and the ASR service reachable from Docker.

```bash
cp demo/.env.example demo/.env      # fill in ASR_URL, ASR_STREAM_URL and ASR_TOKEN (the file is gitignored)
chmod 600 demo/.env
cd demo && docker compose up -d --build
# -> http://localhost:8080           (all services healthy in ~15 s from cold)
docker compose ps                   # status + health
docker compose logs -f worker       # watch jobs being picked up
docker compose down                 # stop (data is kept)
```

`demo/.env` is read by compose on the host (`env_file`) and passed to `ui` (health pills and the
live-captions proxy, which uses `ASR_STREAM_URL` + the token) and `worker` (the batch calls); it is excluded from the image. The token only ever goes into the
`Authorization` header and is never logged or shown. Optional `TZ=` in `.env` sets the time
zone of the timestamps in the list (default UTC).

Open it as **http://localhost:8080**: browsers only allow microphone access on `localhost`
or HTTPS. The ui and MinIO ports are bound to `127.0.0.1` only (the app has no login).

The credentials in `compose.yaml` (Postgres `demo` / `demo-dev-only`, MinIO `minio-dev-only`
/ `minio-dev-only-secret`) are **dev-only** defaults for a laptop demo: change them before
running this anywhere shared.

## Use

- **Record**: pick **LIVE** or **RECORD**, press the big red button (or Space), allow the
  microphone, talk, press again (or Space) to stop. Pick **Speakers** (Auto / 1–4) first if you know
  how many people are talking; Auto lets the model decide (it is fixed while recording).
  - LIVE: the page switches to the live view: a sticky bar (REC, timer, level meter, speakers,
    live latency pill, Stop) over the transcript as it is spoken. It follows the newest line while
    you are at the bottom; scroll up to read and it stops following ("Jump to live" resumes). On
    stop the live transcript is saved and its page opens.
  - RECORD: a level waveform and timer run in the card; on stop the recording (webm/opus in Chrome
    and Firefox, mp4 in Safari) is uploaded and queued for the batch pass.
- **Upload**: drop audio or video files anywhere on the page, or click the drop zone to browse
  (anything ffmpeg can decode: wav, mp3, m4a, flac, ogg, webm, …).
- **Recordings**: cards, newest first, with a live status (queued → preparing audio →
  transcribing → done / failed), length, speakers and speed (`N×` real time = audio seconds
  per second of processing, measured by the worker, so it includes the LAN upload). Failed
  jobs show the reason and a retry button. The ⋯ menu renames, downloads the JSON or deletes.
- **Detail** (click a card): waveform player coloured by speaker (sticky at the top; click to
  seek, 1× / 1.5× / 2×, Space = play/pause, ←/→ = 5 s), speakers with talk-time share (rename
  them inline), stats, **Download JSON** (the raw service response) and the collapsible
  transcript by speaker turn: the current word is highlighted while playing, click any word
  to seek. The page follows playback until you scroll yourself ("Jump to current" brings it
  back). Opened while a job runs, it shows live progress and swaps in the result when done.
  A live recording highlights whole segments instead of words and offers **Upgrade to accurate
  transcript** (the batch pass; the Re-run control does the same with a speaker count).

## Where the data lives

- **Audio and results**: MinIO bucket `recordings`, one prefix per recording:
  `<id>/audio.<ext>` and `<id>/result.json`. Stored in the named volume `demo_minio-data`.
  Browse it in the MinIO console at http://localhost:9001 (user `minio-dev-only`, password
  `minio-dev-only-secret`).
- **Rows**: Postgres table `recordings` in the named volume `demo_postgres-data`.

```bash
docker compose exec postgres psql -U demo -d demo -c "select id, name, status, source, duration_s, rtf, speakers from recordings"
docker compose exec redis redis-cli XINFO GROUPS asr-jobs     # consumer group, pending jobs
docker compose down -v                                        # stop AND wipe all recordings (both volumes)
```

Deleting a recording in the UI removes its objects and its row. Recordings from the older
file-based version (`demo/data/` or the `demo_demo-data` volume) are not migrated; remove
them with `rm -rf demo/data` and `docker volume rm demo_demo-data` if you no longer need them.

## Consent and credits

Only record or publish audio you have the right to use, and get consent from everyone
who is recorded before putting their voice in a video.

Models behind the batch service: [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
(CC-BY-4.0: credit NVIDIA if you show its output) and
[pyannote speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1)
(use is subject to its model terms on Hugging Face). Live captions: NVIDIA Nemotron 3.5 ASR streaming 0.6B
and Nemotron 3 Diarization (see `../stream/README.md`). Built with NiceGUI (MIT), wavesurfer.js (BSD-3-Clause), Alumni Sans and Albert Sans (OFL) and Lucide icons (ISC).

## Files

| File | Purpose |
|------|---------|
| `app.py` | NiceGUI pages (data + live pushes), `/api/recordings` upload, `/api/recordings/live` (LIVE-mode save) and result download routes, submit/retry/delete/rename, live updates from Redis pub/sub |
| `worker.py` | FastStream worker: claim, download, transcribe, store result + stats, publish events, recovery on start |
| `store.py` | Shared plumbing: Postgres (asyncpg), MinIO (aiobotocore, presigned URLs, streamed multipart upload), Redis broker |
| `live.py` | The `/ws/live` WebSocket proxy to the streaming service (token added server side) and its health check |
| `client.py` | ASR config and the async HTTP client for `/health` and `/v1/transcribe` (503 / Retry-After handling) |
| `sql/schema.sql` | The `recordings` table |
| `static/pcm-worklet.js` | AudioWorklet: mic → 16 kHz Int16 PCM batches for LIVE mode |
| `static/demo.js` | The whole front end in plain DOM: pages, recorder (LIVE / RECORD), the live session view, uploads, waveform player, transcript/playback sync |
| `static/demo.css` | Dark theme and layout (no Quasar widgets are used) |
| `static/vendor/`, `static/fonts/` | wavesurfer.js 7 (BSD-3-Clause) and the Alumni Sans + Albert Sans fonts (OFL), vendored with their licenses; Lucide icon paths (ISC) |
| `Dockerfile`, `compose.yaml`, `.dockerignore` | One image for `ui` and `worker`; the whole stack |

## Troubleshooting: "service unreachable" on macOS (running outside Docker)

Mostly irrelevant now that `ui` and `worker` run in Docker (Docker Desktop's VM reaches the
LAN on its own). It applies if you run `python app.py` / `python worker.py` directly on macOS
(you would also have to publish the Postgres and Redis ports and point `DATABASE_URL`,
`REDIS_URL` and `S3_*` at them):

macOS blocks local-network (LAN) access per program ("Local Network" privacy). If
`curl http://<gpu-box>:9100/health` works but the app says the service is unreachable
(`No route to host` / `ConnectError`), the Python binary the app runs on has no LAN access:

- Allow your terminal under System Settings → Privacy & Security → Local Network, then
  restart the app; or
- build the venv on a Python that already has access, e.g. the python.org installer:
  `uv venv --python /usr/local/bin/python3 && uv run python worker.py`.
