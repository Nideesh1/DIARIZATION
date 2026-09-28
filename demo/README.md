# Demo UI

A small [NiceGUI](https://nicegui.io) web app for showing off the ASR + diarization
service: record from the microphone (or upload a file), send it to the service over the
LAN, and browse the results — transcript split into colour-coded speaker turns, the
current word highlighted as the audio plays, click any word to jump there.

It runs on your laptop and talks to the GPU box; it is a separate uv project, so the
service's Docker image and requirements are untouched.

## Run

Needs [uv](https://docs.astral.sh/uv/) and Python 3.11+. `ffmpeg` on the PATH is optional
but recommended (browser recordings are remuxed so they can be seeked, and the audio
length shows while a job is still running).

```bash
cp demo/.env.example demo/.env      # then fill in ASR_URL and ASR_TOKEN (the file is gitignored)
chmod 600 demo/.env
cd demo && uv run python app.py     # -> http://localhost:8080
```

Configuration is read from the environment, then from `demo/.env` (real environment
variables win). Instead of the file you can also:

```bash
export ASR_URL=http://<gpu-box-lan-ip>:9100
export ASR_TOKEN_FILE=/path/to/asr.env        # a bare token, or asr.env's ASR_TOKEN=... line
# or: read -s ASR_TOKEN; export ASR_TOKEN
```

The token is only sent in the `Authorization` header; the app never logs or displays it.
If `ASR_URL` / `ASR_TOKEN` are missing the app still starts, shows a banner, and saves
recordings (use the retry button once configured). The dot in the header is the
service's `/health`, polled every 10 s.

Open it as **http://localhost:8080**: browsers only allow microphone access on
`localhost` or HTTPS. `DEMO_DATA_DIR` moves the data folder (default `demo/data`).

## Run with Docker Compose

Needs Docker (Docker Desktop on macOS). The image has ffmpeg built in; the ASR settings
come from the same `demo/.env` (read by compose on the host via `env_file`, never copied
into the image).

```bash
cp demo/.env.example demo/.env      # fill in ASR_URL and ASR_TOKEN, as above
cd demo && docker compose up -d --build
# -> http://localhost:8080
docker compose logs -f              # follow the logs
docker compose down                 # stop (recordings are kept)
```

The port is published on `127.0.0.1` only (the microphone needs `localhost`, and the app
has no login, so it is not exposed to the LAN). Inside the container the app listens on
`0.0.0.0`; `DEMO_HOST` / `DEMO_PORT` (default `127.0.0.1` / `8080`) set this for local runs
too. Docker Desktop's VM reaches the LAN on its own, so the macOS "Local Network" issue
below usually does not apply. Stop a local copy first if it already holds port 8080.

## Use

- **Record**: press the red button, allow the microphone, talk, press again to stop. The
  recording (webm/opus in Chrome and Firefox, mp4 in Safari) is uploaded to the app and
  sent to the service. Set **Speakers** if you know how many people are talking; blank
  lets the model decide.
- **Upload file**: any audio/video file ffmpeg can decode (wav, mp3, m4a, flac, ogg, webm, …).
- **List**: newest first, with status, audio length, processing time and speed
  (`N×` real time = audio seconds per second of processing, measured on this machine, so it
  includes the LAN upload). Failed jobs show the reason and a retry button. A 503 (service
  busy) is retried up to three times, honouring `Retry-After`.
- **Detail** (click a row): player (stays at the top while scrolling), speakers (rename
  them inline) and stats side by side with **Download JSON** (the raw service response),
  then the collapsible transcript by speaker turn: click a word or timestamp to seek.

## Where recordings are stored

Each recording is a folder `<id>/` (e.g. `20260928-113926-8ad5/`) holding `audio.<ext>`,
`response.json` (the service's response) and `meta.json` (name, created_at, status/error,
duration_s, processing_s, rtf, speaker count, speaker names). Delete a recording from the
list, or remove its folder.

- **Local run** (`uv run python app.py`): `demo/data/<id>/` (gitignored), or wherever
  `DEMO_DATA_DIR` points.
- **Docker Compose**: the named volume `demo-data` (full name `demo_demo-data`), mounted
  at `/data` in the container. It survives `down`, rebuilds and image updates.

```bash
docker volume inspect demo_demo-data                 # where Docker keeps it (inside Docker Desktop's VM on macOS)
docker compose exec demo ls -l /data                 # list recordings (while running)
docker compose cp demo:/data ./data-backup           # back up to the host (while running)
docker run --rm -v demo_demo-data:/data -v "$PWD":/out alpine \
  tar czf /out/demo-data.tgz -C /data .              # back up as a tarball (running or not)
docker compose down -v                               # stop AND delete all recordings
```

The two stores are separate: recordings made in the container do not show up in a local
run and vice versa (copy folders across with `docker compose cp` if needed).

## Consent and credits

Only record or publish audio you have the right to use, and get consent from everyone
who is recorded before putting their voice in a video.

Models behind the service: [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
(CC-BY-4.0: credit NVIDIA if you show its output) and
[pyannote speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1)
(use is subject to its model terms on Hugging Face). Built with NiceGUI (MIT).

## Files

| File | Purpose |
|------|---------|
| `app.py` | NiceGUI pages, record/upload handling, job runner, `/api/recordings` upload route |
| `client.py` | Config (`.env`, env vars, token file) and the async HTTP client for `/health` and `/v1/transcribe` |
| `static/demo.js` | Browser recorder (MediaRecorder) and transcript/playback sync |
| `static/demo.css` | Dark theme |
| `Dockerfile`, `compose.yaml`, `.dockerignore` | Container build and run (localhost-only port, `demo-data` volume) |

## Troubleshooting: "service unreachable" on macOS

macOS blocks local-network (LAN) access per program ("Local Network" privacy). If
`curl http://<gpu-box>:9100/health` works but the app says the service is unreachable
(`No route to host` / `ConnectError`), the Python binary the app runs on has no LAN access:

- Allow your terminal under System Settings → Privacy & Security → Local Network, then
  restart the app; or
- build the venv on a Python that already has access, e.g. the python.org installer:
  `uv venv --python /usr/local/bin/python3 && uv run python app.py`.
