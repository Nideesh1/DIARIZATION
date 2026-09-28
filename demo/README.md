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
- **Detail** (click a row): player, transcript by speaker turn, click a word or timestamp
  to seek, rename speakers in the side panel, stats, and **Download JSON** (the raw service
  response).

## Data

Everything lives in `demo/data/<id>/` (gitignored): `audio.<ext>`, `response.json` (the
service's response) and `meta.json` (name, created_at, status/error, duration_s,
processing_s, rtf, speaker count, speaker names). Delete a recording from the list, or
remove its folder.

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

## Troubleshooting: "service unreachable" on macOS

macOS blocks local-network (LAN) access per program ("Local Network" privacy). If
`curl http://<gpu-box>:9100/health` works but the app says the service is unreachable
(`No route to host` / `ConnectError`), the Python binary the app runs on has no LAN access:

- Allow your terminal under System Settings → Privacy & Security → Local Network, then
  restart the app; or
- build the venv on a Python that already has access, e.g. the python.org installer:
  `uv venv --python /usr/local/bin/python3 && uv run python app.py`.
