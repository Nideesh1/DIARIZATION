# asr-stream: live transcription with speaker labels (WebSocket)

Live speech-to-text with speaker diarization for up to 4 speakers per session.
Words appear about 0.2 s (p50) to 0.55 s (p95) after they are spoken.

- ASR: [`nvidia/nemotron-3.5-asr-streaming-0.6b`](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b), cache-aware streaming, 121 language prompts incl. `auto`
- Diarization: [`nvidia/Nemotron-3-Diarization`](https://huggingface.co/nvidia/Nemotron-3-Diarization), streaming, up to 8 speakers (capped at 4 here)
- The two are coupled through NeMo Speech's `SpeakerTaggedASR` (masked ASR: one ASR stream per active speaker).
- It runs as a Docker container on kamd1, GPU 0, next to the batch service (`asr`, port 9100). It uses the **same bearer token**.

| From | URL |
|------|-----|
| LAN | `ws://192.168.0.247:9101/v1/stream`, health `http://192.168.0.247:9101/health` |

The batch service on :9100 is still the accurate final pass. It is multilingual Parakeet v3 plus
pyannote, handles unlimited speakers, and gives consistent labels across hours. Use this service
for live captions.

## Protocol

1. **Connect** to `ws://192.168.0.247:9101/v1/stream`.
   - Server-side clients can send `Authorization: Bearer <ASR_TOKEN>` as a header.
   - Browsers cannot set WebSocket headers, so they put the token in the start message instead.
2. **Send the start message** (text, JSON) within 10 s:
   ```json
   {"type": "start", "sample_rate": 16000, "encoding": "pcm_s16le",
    "language": "auto", "max_speakers": 4, "token": "<ASR_TOKEN, only if no header>"}
   ```
   - `sample_rate` must be 16000 and `encoding` must be `pcm_s16le` (mono). Both fields are optional.
   - `language` is optional (default `auto`). It is a locale such as `en-US` or `de-DE`, or `auto`.
     An unknown value returns the full list in the error.
   - `max_speakers` is 1..4 (default 4). Set it to the expected speaker count for best labels.
3. **The server replies** `{"type":"ready","session_id":"…","latency_s":0.56,"sample_rate":16000,"encoding":"pcm_s16le","language":"auto","max_speakers":4}`.
4. **Stream audio** as **binary** messages: raw PCM, signed 16-bit little-endian, mono, 16 kHz.
   - Any size works (20–100 ms is typical), up to 1 MiB each.
   - Send at real-time pace from a mic. Sending faster (e.g. a file) is fine and is processed as fast as the GPU allows.
5. **Receive updates** (text, JSON), about every 0.56 s while there is speech:
   ```json
   {"type": "update", "from": 3, "audio_s": 12.4,
    "segments": [{"speaker": 0, "start": 10.2, "end": 12.1, "text": "Hello there, how are"}]}
   ```
   Keep a list `segs` and apply `segs = segs[:from] + segments`. Segments at and after `from`
   were revised or added. The last segment grows word by word, and earlier ones can be
   corrected. `speaker` is a session-local number (0, 1, …) in order of first appearance.
   `start` and `end` are seconds from the start of the stream.
6. **Stop** by sending `{"type":"stop"}` as text. The server flushes the tail, then sends
   `{"type":"final","segments":[…all…],"audio_s":…,"reason":"client_stop"}` and closes with code 1000.
   If no message arrives for 30 s, the session ends with `"reason":"idle_timeout"`. Sessions are capped at 2 h of audio.

### Errors

The server sends `{"type":"error","code":…,"message":…}` and then closes.

| code | close | when |
|------|-------|------|
| `unauthorized` | 1008 | missing or wrong token |
| `bad_request` | 1003/1008/1009 | bad start message, wrong format or rate, unknown language, bad `max_speakers`, oversized or odd-length audio message |
| `busy` | 1013 | all `MAX_SESSIONS` (4) sessions in use; includes `retry_after_s: 15` |
| `loading` | 1013 | models still loading after a restart (about 3 min); includes `retry_after_s` |
| `internal` | 1011 | server error. A CUDA fault also restarts the container. |

`GET /health` returns 200 `{"status":"ok","latency_s":0.56,"sessions":n,"max_sessions":4,…}` when
ready, and 503 while loading.

### Browser example (mic → captions)

```js
const ws = new WebSocket("ws://192.168.0.247:9101/v1/stream");
const ctx = new AudioContext({ sampleRate: 16000 });          // browser resamples the mic to 16 kHz
let segs = [];
ws.onopen = () => ws.send(JSON.stringify({ type: "start", token: ASR_TOKEN, language: "auto", max_speakers: 4 }));
ws.onmessage = async (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === "ready") {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([`
      class P extends AudioWorkletProcessor { process(i) { const x = i[0][0];
        if (x) { const b = new Int16Array(x.length);
          for (let k = 0; k < x.length; k++) b[k] = Math.max(-1, Math.min(1, x[k])) * 0x7fff;
          this.port.postMessage(b.buffer, [b.buffer]); } return true; } }
      registerProcessor("pcm", P);`], { type: "text/javascript" })));
    const node = new AudioWorkletNode(ctx, "pcm");
    node.port.onmessage = (e) => ws.readyState === 1 && ws.send(e.data);   // ~8 ms chunks; batch them if you like
    ctx.createMediaStreamSource(mic).connect(node);
  } else if (m.type === "update") {
    segs = segs.slice(0, m.from).concat(m.segments);
    render(segs);                                               // [{speaker,start,end,text}, …]
  } else if (m.type === "final") { render(m.segments); }
  else if (m.type === "error") { console.error(m); }
};
// stop: ws.send(JSON.stringify({ type: "stop" }));
```

Notes:
- `getUserMedia` needs a secure context: `http://localhost` counts, but a plain `http://<LAN-IP>` page does not.
- Keep the token out of shipped front-end code for anything beyond a LAN demo. Proxy the WebSocket through your backend instead.

### Python test client

`client/stream_wav.py FILE.wav [--sessions N] [--fast] [--auth header|message] [--language en-US]`
streams a 16 kHz mono WAV in 100 ms pieces at real-time pace. It prints the live captions and
word latency. The token comes from `$ASR_TOKEN` or the repo's `asr.env`.

## Measured (kamd1, RTX 3090 GPU 0 at 300 W, next to the batch service)

- **One stream, real time:** word latency p50 0.21 s, p95 0.55 s. The final transcript arrives 0.2 s after the audio ends.
- **4 concurrent real-time streams:** the same latency for every stream (p50 0.19–0.22 s, p95 0.51–0.59 s).
  - GPU about 20% busy.
  - Steps take p50 ~85 ms and p95 ~155 ms per 560 ms hop.
  - That leaves room for roughly 8+ streams. Raise `MAX_SESSIONS` after measuring.
- **VRAM:** ~3 GB of weights, and ~3.6 GB for the whole container with 4 sessions.
- **Fast (file) mode:** 40 s of audio in about 6 s.
- **Startup:** models load in about 90 s, then warm-up takes about 80 s. Warm-up compiles the kernels
  that otherwise made the first live step take about 12 s.

## Run

```bash
docker build -t asr-stream:0.1.0 .      # NeMo Speech pinned by commit (NEMO_COMMIT) in the Dockerfile
./run.sh                                # GPU 0, port 9101, token from ../asr.env (same as the batch service)
docker logs -f asr-stream               # JSON lines: session start/end, step timings; never audio or text
```

| Env | Default | Meaning |
|-----|---------|---------|
| `ATT_CONTEXT` | `56,6` | Right context sets the latency: `56,13` 1.12 s (most accurate), `56,6` 0.56 s, `56,3` 0.32 s, `56,1` 0.16 s |
| `MAX_SPEAKERS` | `4` | Upper bound per session (the model supports 8) |
| `MAX_SESSIONS` | `4` | Concurrent live sessions |
| `LANGUAGE` | `auto` | Default language prompt |
| `IDLE_TIMEOUT_S`, `MAX_SESSION_S`, `START_TIMEOUT_S` | 30, 7200, 10 | Session limits |

The models download from Hugging Face on first start into the `asr-stream-models` volume. They are
not gated, so no HF token is needed.

## Files

| File | Purpose |
|------|---------|
| `app.py` | FastAPI WebSocket service |
| `Dockerfile`, `.dockerignore` | Image: python 3.13, NeMo Speech @ pinned commit, torch cu13, FastAPI |
| `run.sh` | (Re)start the container and wait for `/health` |
| `warmup.wav` | 40 s of NASA STS-41C air-to-ground audio (public domain), used for the startup warm-up |
| `client/stream_wav.py`, `client/edge-tests.sh` | Test client and error-path tests |
| `live_test.py`, `run-test.sh` | The original offline feasibility test |

## Known behaviour

- Speaker numbers are per session and in order of appearance. They are not identities, and they
  can differ from the batch service's labels for the same audio.
- The ASR sometimes emits a language tag such as `<en-US>`. The service strips it.
- Heavy crosstalk can put the same words under two speakers. Masked ASR only partly separates overlapping speech.
- `language` is fixed per session. `auto` works for most audio, and a fixed locale can be more accurate.
