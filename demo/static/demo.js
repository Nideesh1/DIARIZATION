// Browser side of the demo: mic recorder + transcript/playback sync. No framework.

// ---- recorder: MediaRecorder -> one Blob -> POST /api/recordings (raw body)
window.demoRec = (() => {
  let rec = null, stream = null, ctx = null, iv = null, chunks = [], mime = "", t0 = 0;
  const types = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];
  const ext = (m) => (m.includes("ogg") ? "ogg" : m.includes("mp4") ? "m4a" : "webm");
  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const $ = (id) => document.getElementById(id);

  function cleanup() {
    clearInterval(iv); iv = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close();
    stream = ctx = null;
    if ($("rec-level")) $("rec-level").style.width = "0";
  }

  async function start() {
    if (!navigator.mediaDevices || !window.MediaRecorder) return "not available (open via http://localhost)";
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const want = types.find((t) => MediaRecorder.isTypeSupported(t));
      rec = new MediaRecorder(stream, want ? { mimeType: want, audioBitsPerSecond: 96000 } : undefined);
      mime = rec.mimeType || want || "audio/webm";
      chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.start(1000);   // 1 s timeslices: memory stays chunked, nothing lost on stop
      t0 = performance.now();
      if ($("rec-time")) $("rec-time").textContent = "00:00";
      ctx = new AudioContext();
      const an = ctx.createAnalyser(); an.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      iv = setInterval(() => {
        if ($("rec-time")) $("rec-time").textContent = fmt((performance.now() - t0) / 1000);
        an.getFloatTimeDomainData(buf);
        let s = 0; for (const v of buf) s += v * v;
        if ($("rec-level")) $("rec-level").style.width = Math.min(100, Math.sqrt(s / buf.length) * 400) + "%";
      }, 80);
      return "ok";
    } catch (e) { cleanup(); rec = null; return `${e.name}: ${e.message}`; }
  }

  async function stop(numSpeakers) {
    if (!rec) return { error: "not recording" };
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.stop(); await stopped; cleanup();
    const blob = new Blob(chunks, { type: mime }); chunks = []; rec = null;
    if (!blob.size) return { error: "empty recording" };
    const q = new URLSearchParams({ ext: ext(mime) });
    if (numSpeakers > 0) q.set("num_speakers", numSpeakers);
    try {
      const r = await fetch("/api/recordings?" + q, { method: "POST", body: blob, headers: { "Content-Type": mime } });
      return r.ok ? await r.json() : { error: `HTTP ${r.status}` };
    } catch (e) { return { error: String(e) }; }
  }
  return { start, stop };
})();

// ---- transcript: highlight the word under the playhead, click a word to seek
(() => {
  let words = [], cur = -1, turn = null, raf = 0;
  const audio = () => document.querySelector("audio");
  function collect() {
    words = [...document.querySelectorAll(".transcript .w")].map((el) => ({ el, s: +el.dataset.s, e: +el.dataset.e }));
    cur = -1;
  }
  function find(t) {             // last word starting at or before t, if we're still inside it
    let lo = 0, hi = words.length - 1, i = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (words[m].s <= t) { i = m; lo = m + 1; } else hi = m - 1; }
    return i >= 0 && t <= words[i].e + 0.3 ? i : -1;  // keep it lit across short gaps
  }
  function follow(el) {
    const r = el.getBoundingClientRect(), top = 170;
    if (r.top < top || r.bottom > innerHeight - 80) window.scrollBy({ top: r.top - (innerHeight + top) / 2 + 40, behavior: "smooth" });
  }
  function tick() {
    raf = 0;
    const a = audio();
    if (!a) return;
    if (!words.length || !words[0].el.isConnected) collect();
    const i = find(a.currentTime);
    if (i !== cur) {
      if (cur >= 0 && words[cur]) words[cur].el.classList.remove("hl");
      cur = i;
      if (i >= 0) {
        const el = words[i].el; el.classList.add("hl");
        const t = el.closest(".turn");
        if (t !== turn) { if (turn) turn.classList.remove("active"); turn = t; t.classList.add("active"); }
        if (!a.paused) follow(el);
      }
    }
    if (!a.paused) raf = requestAnimationFrame(tick);
  }
  const kick = (e) => { if (e.target.tagName === "AUDIO" && !raf) raf = requestAnimationFrame(tick); };
  ["play", "seeked", "timeupdate", "loadedmetadata"].forEach((ev) => document.addEventListener(ev, kick, true));
  document.addEventListener("click", (e) => {
    const w = e.target.closest(".transcript .w, .transcript .ts");
    const a = audio();
    if (!w || !a) return;
    a.currentTime = +w.dataset.s + 0.01;
    a.play();
  });
  window.demoRename = (spk, name) =>
    document.querySelectorAll(`.spk-name[data-spk="${CSS.escape(spk)}"]`).forEach((el) => (el.textContent = name));
})();
