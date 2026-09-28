// "Who said what": the browser side. Plain DOM, no framework.
//
// app.py puts the initial data in window.__WSW and then calls WSW.rows / WSW.detail /
// WSW.health / WSW.gone over NiceGUI's websocket when something changes. User actions go
// back with emitEvent("wsw", {op, ...}). Audio is POSTed straight to /api/recordings.
// Icons: Lucide (ISC, see static/vendor/lucide.LICENSE).

window.WSW = (() => {
  "use strict";

  // ------------------------------------------------------------ helpers
  // speaker colours: the kinpaku / patina / vermilion family first, then softer hues of the same
  // lightness (oklch ~70-88 %) so every one reads on lacquer black
  const PALETTE = ["#f4b93c", "#20bcb2", "#e97558", "#76ace4", "#8ec67a", "#dd7ead", "#b49ce1", "#ead5ab"];
  const NEUTRAL = "#393833";
  const ICONS = {
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
    more: '<circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/><circle cx="5" cy="12" r="1.2" fill="currentColor"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    retry: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    play: '<path d="M6 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L7.5 3.64A1 1 0 0 0 6 4.5Z" fill="currentColor"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1.2" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1.2" fill="currentColor" stroke="none"/>',
    back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    wave: '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  };

  function icon(name, cls = "") {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("class", `ico i-${name} ${cls}`);
    s.setAttribute("aria-hidden", "true");
    s.innerHTML = ICONS[name];
    return s;
  }

  // h("div.a.b", {attrs, on: {click}}, ...children): children are nodes or text
  function h(sel, props, ...kids) {
    const [tag, ...cls] = sel.split(".");
    const el = document.createElement(tag || "div");
    if (cls.length) el.className = cls.join(" ");
    if (props && (typeof props !== "object" || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === "style") Object.assign(el.style, v);
      else if (k === "vars") for (const [n, val] of Object.entries(v)) el.style.setProperty(n, val);
      else if (k === "text") el.textContent = v;
      else if (k === "cls") el.className += " " + v;
      else if (k in el && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
    return el;
  }

  const clock = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, "0");
    return hh ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
  };
  const timer = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const secs = (s) => (s == null ? "–" : s < 10 ? `${s.toFixed(1)} s` : clock(s));
  const speed = (r) => (r ? `${r >= 100 ? Math.round(r) : +r.toFixed(1)}× real time` : null);
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  function ago(iso) {
    const d = (Date.now() - new Date(iso)) / 1000;
    if (d < 45) return "just now";
    if (d < 3600) return plural(Math.round(d / 60), "min") + " ago";
    if (d < 86400) return plural(Math.round(d / 3600), "hour") + " ago";
    if (d < 7 * 86400) return plural(Math.round(d / 86400), "day") + " ago";
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  const longDate = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  function send(op, data = {}) {
    if (typeof window.emitEvent === "function") window.emitEvent("wsw", { op, ...data });
    else setTimeout(() => send(op, data), 200);   // NiceGUI still connecting
  }

  // ------------------------------------------------------------ toasts, menus, dialogs
  let toastBox;
  function toast(msg, kind = "ok") {
    toastBox = toastBox || document.body.appendChild(h("div.toasts"));
    const t = toastBox.appendChild(h("div.toast", { cls: kind }, msg));
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 220); }, kind === "err" ? 6000 : 3200);
  }

  let openMenu = null;
  function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
  function menu(anchor, items) {
    closeMenu();
    const m = h("div.menu", { role: "menu" }, items.map((it) => it === "-" ? h("hr") :
      h("button", { cls: it.danger ? "danger" : "", role: "menuitem", on: { click: (e) => { e.stopPropagation(); closeMenu(); it.run(); } } },
        icon(it.icon), it.label)));
    document.body.append(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = `${Math.min(r.bottom + 6, innerHeight - m.offsetHeight - 8)}px`;
    m.style.left = `${Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8))}px`;
    openMenu = m; menuY = scrollY;
  }
  document.addEventListener("click", (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
  let menuY = 0;     // close on a real scroll, not on the small jumps of a mobile address bar
  addEventListener("scroll", () => openMenu && Math.abs(scrollY - menuY) > 40 && closeMenu(), { passive: true });

  function confirmDialog({ title, body, ok = "Delete", danger = true }) {
    return new Promise((resolve) => {
      const done = (v) => {
        scrim.classList.add("out");
        document.removeEventListener("keydown", key, true);
        setTimeout(() => scrim.remove(), 150);
        resolve(v);
      };
      const key = (e) => {
        if (e.key === "Escape") { e.stopPropagation(); done(false); }
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done(true); }
      };
      const okBtn = h("button.btn", { cls: danger ? "danger" : "primary", on: { click: () => done(true) } }, ok);
      const scrim = h("div.scrim", { on: { click: (e) => e.target === scrim && done(false) } },
        h("div.dialog", { role: "dialog", "aria-modal": "true" }, h("h3", title), h("p", body),
          h("div.dlg-row", h("button.btn.ghost", { on: { click: () => done(false) } }, "Cancel"), okBtn)));
      document.body.append(scrim);
      document.addEventListener("keydown", key, true);
      okBtn.focus();
    });
  }

  // an input that looks like text until hovered/focused; commit on Enter/blur, Esc reverts
  function inlineInput(value, onCommit, { cls = "", placeholder = "", maxLength = 80, label = "" } = {}) {
    let committed = value;
    const inp = h("input.inline-input", { cls, value, placeholder, maxLength, spellcheck: "false", "aria-label": label });
    const commit = () => {
      const v = inp.value.trim();
      if (v === committed) return;
      const next = onCommit(v);
      committed = next != null ? next : v;
      inp.value = committed;
    };
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") inp.blur();
      if (e.key === "Escape") { inp.value = committed; inp.blur(); }
    });
    inp.addEventListener("blur", commit);
    inp.addEventListener("click", (e) => e.stopPropagation());
    inp.setValue = (v) => { committed = v; if (document.activeElement !== inp) inp.value = v; };
    return inp;
  }

  // ------------------------------------------------------------ shell
  let healthEl, bannerEl;
  function shell() {
    const root = document.getElementById("wsw");
    root.replaceChildren();
    healthEl = h("div.health", { title: "GPU transcription service" }, h("span.dot"), h("span", "Checking…"));
    root.append(h("div.top-seam"), h("header.topbar",
      h("a.brand", { href: "/" }, h("img", { src: "/static/favicon.svg", alt: "" }), "Who said what"),
      h("div.spacer"), h("span.doc-ref", "Speech / Speakers / Transcript"), healthEl));
    bannerEl = root.appendChild(h("div", { hidden: true }));
    const main = root.appendChild(h("main.wrap"));
    root.append(h("footer.site-footer", h("span.f-note", "Who said what · self-hosted"), h("span.f-note", "Parakeet ASR / pyannote diarization")));
    return main;
  }

  function health(v) {
    if (!healthEl) return;
    healthEl.className = "health " + (v.ok ? "ok" : v.ok === false ? "bad" : "");
    healthEl.lastChild.textContent = v.ok ? "ASR online" : v.ok === false ? `ASR ${v.text}` : "Checking…";
    healthEl.title = `ASR service: ${v.text}`;
    bannerEl.hidden = v.configured !== false;
    bannerEl.className = "banner";
    bannerEl.textContent = "ASR_URL / ASR_TOKEN are not set: recordings are saved but cannot be transcribed. Set them in demo/.env and restart.";
  }

  // ------------------------------------------------------------ uploads (recorder + files)
  function postAudio(blob, { ext, name, speakers, onProgress }) {
    const q = new URLSearchParams({ ext });
    if (name) q.set("name", name);
    if (speakers) q.set("num_speakers", speakers);
    return new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open("POST", "/api/recordings?" + q);
      x.setRequestHeader("Content-Type", blob.type || "application/octet-stream");
      x.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
      x.onload = () => {
        let body = {};
        try { body = JSON.parse(x.responseText); } catch { /* not json */ }
        resolve(x.status < 300 ? body : { error: body.error || `HTTP ${x.status}` });
      };
      x.onerror = () => resolve({ error: "network error" });
      x.send(blob);
    });
  }

  // ------------------------------------------------------------ home
  const Home = (() => {
    let grid, countEl, cards = new Map(), rows = [];
    let speakersPref = localStorage.getItem("wsw.speakers") || "";

    function mount(data) {
      const main = shell();
      main.append(
        h("section.hero",
          h("div.page-head",
            h("div",
              h("div.eyebrow", h("span.eyebrow-rule"), "Parakeet ASR + pyannote diarization · self-hosted"),
              h("h1.page-title", "New recording")),
            h("p.page-lead", "Record a conversation or drop in a file. Get a word-timed transcript, split by speaker, in seconds.")),
          h("div.studio", Recorder.el(), dropZone())),
        h("section.library",
          h("div.list-head",
            h("div", h("div.split-label", "Library"), h("h2", "Recordings")),
            (countEl = h("span.count.tnum", "0"))),
          (grid = h("div.grid"))));
      pageDrop();
      setRows(data.rows, true);
      setInterval(() => document.querySelectorAll("[data-ago]").forEach((el) => (el.textContent = ago(el.dataset.ago))), 30000);
    }

    function speakersControl() {
      const opts = [["", "Auto"], ["2", "2"], ["3", "3"], ["4", "4"]];
      const seg = h("div.seg", { role: "radiogroup", "aria-label": "Number of speakers" });
      const paint = () => seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === speakersPref));
      for (const [v, label] of opts) {
        seg.append(h("button", { "data-v": v, role: "radio", on: { click: () => { speakersPref = v; localStorage.setItem("wsw.speakers", v); paint(); } } }, label));
      }
      paint();
      return h("div.field-label", "Speakers", seg);
    }

    // ---- recorder
    const Recorder = (() => {
      let panel, btn, timeEl, hintEl, canvas, rec = null, stream = null, ctx = null, an = null, raf = 0, t0 = 0, chunks = [], mime = "", state = "idle";
      const levels = [];
      const types = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];
      const extOf = (m) => (m.includes("ogg") ? "ogg" : m.includes("mp4") ? "m4a" : "webm");

      function el() {
        btn = h("button.rec-btn", { "aria-label": "Start recording", on: { click: toggle } }, icon("mic"));
        timeEl = h("div.rec-time", "00:00");
        hintEl = h("div.rec-hint", "Tap to record from your microphone");
        canvas = h("canvas.rec-wave", { height: 64 });
        panel = h("div.panel.rec-panel",
          h("div.stamp", "01 · Microphone"),
          h("div.rec-main", btn, h("div.rec-info", timeEl, hintEl)),
          canvas,
          h("div.rec-foot", speakersControl(), h("span.field-label.kbd-hint", "Space to start / stop")));
        requestAnimationFrame(draw);
        addEventListener("resize", () => draw());
        document.addEventListener("keydown", (e) => {
          if (e.code === "Space" && !e.target.closest("input, textarea, button, [contenteditable]") && !document.querySelector(".scrim")) {
            e.preventDefault(); toggle();
          }
        });
        return panel;
      }

      function draw() {          // scrolling level history, newest on the right
        raf = 0;
        if (!canvas) return;
        const dpr = devicePixelRatio || 1, W = canvas.clientWidth * dpr, H = canvas.clientHeight * dpr;
        if (canvas.width !== W) canvas.width = W;
        if (canvas.height !== H) canvas.height = H;
        const g = canvas.getContext("2d");
        g.clearRect(0, 0, W, H);
        if (an) {
          const buf = new Float32Array(an.fftSize);
          an.getFloatTimeDomainData(buf);
          let s = 0; for (const v of buf) s += v * v;
          levels.push(Math.min(1, Math.sqrt(s / buf.length) * 5));
          timeEl.textContent = timer((performance.now() - t0) / 1000);
        }
        const bw = 2 * dpr, gap = 3 * dpr, n = Math.floor(W / (bw + gap));
        if (levels.length > n) levels.splice(0, levels.length - n);
        for (let i = 0; i < n; i++) {
          const v = levels[levels.length - n + i];
          const x = i * (bw + gap);
          const hh = v == null ? 1 * dpr : Math.max(2 * dpr, v * H * 0.92);
          const fade = v == null ? 1 : Math.min(1, 0.3 + (i / n) * 0.9);
          g.fillStyle = v == null ? "rgba(200,200,200,0.14)" : `rgba(224, 104, 80, ${fade})`;
          g.fillRect(x, (H - hh) / 2, bw, hh);
        }
        if (an) raf = requestAnimationFrame(draw);
      }

      function setState(s) {
        state = s;
        panel.classList.toggle("live", s === "recording");
        btn.replaceChildren(icon(s === "recording" ? "stop" : "mic"));
        btn.disabled = s === "starting" || s === "uploading";
        btn.setAttribute("aria-label", s === "recording" ? "Stop recording" : "Start recording");
        hintEl.textContent = { idle: "Tap to record from your microphone", starting: "Waiting for the microphone…",
          recording: "Recording · tap to stop", uploading: "Uploading…" }[s];
      }

      async function toggle() {
        if (state === "idle") return start();
        if (state === "recording") return stop();
      }

      async function start() {
        if (!navigator.mediaDevices || !window.MediaRecorder) { toast("Microphone not available (open the app via http://localhost)", "err"); return; }
        setState("starting");
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
          const want = types.find((t) => MediaRecorder.isTypeSupported(t));
          rec = new MediaRecorder(stream, want ? { mimeType: want, audioBitsPerSecond: 96000 } : undefined);
          mime = rec.mimeType || want || "audio/webm";
          chunks = [];
          rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
          rec.start(1000);   // 1 s timeslices: nothing lost on stop
          ctx = new AudioContext();
          an = ctx.createAnalyser(); an.fftSize = 1024;
          ctx.createMediaStreamSource(stream).connect(an);
          t0 = performance.now(); levels.length = 0;
          setState("recording");
          if (!raf) raf = requestAnimationFrame(draw);
        } catch (e) {
          cleanup(); rec = null; setState("idle");
          toast(`Microphone: ${e.name === "NotAllowedError" ? "permission denied" : e.message || e.name}`, "err");
        }
      }

      function cleanup() {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        if (ctx) ctx.close();
        stream = ctx = an = null;
      }

      async function stop() {
        setState("uploading");
        const stopped = new Promise((r) => (rec.onstop = r));
        rec.stop(); await stopped; cleanup();
        const blob = new Blob(chunks, { type: mime.split(";")[0] }); chunks = []; rec = null;
        if (!blob.size) { setState("idle"); toast("Empty recording", "err"); return; }
        const r = await postAudio(blob, { ext: extOf(mime), speakers: speakersPref });
        setState("idle");
        timeEl.textContent = "00:00";
        levels.length = 0; draw();
        if (r.error) toast(`Upload failed: ${r.error}`, "err");
        else toast("Recording saved, transcribing now");
      }
      return { el };
    })();

    // ---- file upload (drop zone, page-wide drop, browse)
    let dropEl, dropBody, picker;
    const AUDIO_EXT = /\.(wav|mp3|m4a|aac|flac|ogg|oga|opus|webm|mp4|mov|mkv|wma|aiff?|amr|3gp)$/i;
    function dropZone() {
      picker = h("input", { type: "file", accept: "audio/*,video/*", multiple: true, hidden: true,
        on: { change: () => { uploadFiles([...picker.files]); picker.value = ""; } } });
      dropBody = h("div", { style: { display: "contents" } });
      dropEl = h("div.panel.drop", { role: "button", tabindex: 0, "aria-label": "Upload audio files",
        on: { click: () => picker.click(), keydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), picker.click()) } },
        h("div.stamp", "02 · Upload"), dropBody, picker);
      idleDrop();
      return dropEl;
    }
    function idleDrop() {
      dropBody.replaceChildren(h("div.drop-ico", icon("upload")), h("div.drop-title", "Drop an audio file"),
        h("div.drop-sub", "or ", h("u", "browse your files")), h("div.drop-fmt", ["wav", "mp3", "m4a", "flac", "ogg", "webm", "video"].map((f) => h("span.tag", f))));
    }
    function pageDrop() {
      const veil = document.body.appendChild(h("div.drag-veil", h("div", icon("upload"), "Drop to transcribe")));
      let depth = 0;
      const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
      addEventListener("dragenter", (e) => { if (hasFiles(e)) { depth++; veil.classList.add("on"); dropEl.classList.add("over"); } });
      addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; veil.classList.remove("on"); dropEl.classList.remove("over"); } });
      addEventListener("dragover", (e) => hasFiles(e) && e.preventDefault());
      addEventListener("drop", (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault(); depth = 0; veil.classList.remove("on"); dropEl.classList.remove("over");
        uploadFiles([...e.dataTransfer.files]);
      });
    }
    let uploading = false;
    async function uploadFiles(files) {
      if (uploading) { toast("An upload is already running", "err"); return; }
      const ok = files.filter((f) => /^(audio|video)\//.test(f.type) || AUDIO_EXT.test(f.name));
      if (ok.length < files.length) toast(`Skipped ${plural(files.length - ok.length, "file")} that are not audio`, "err");
      uploading = true;
      for (const [i, f] of ok.entries()) {
        const bar = h("i", { style: { width: "0%" } });
        const pct = h("span.tnum", "0%");
        dropBody.replaceChildren(h("div.drop-ico", h("div.spin")),
          h("div.drop-title", ok.length > 1 ? `Uploading ${i + 1} of ${ok.length}` : "Uploading"),
          h("div.drop-sub", `${f.name} · `, pct), h("div.bar.accent.upbar", bar));
        const stem = f.name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim().slice(0, 80);  // the display font draws "_" very wide
        const ext = (f.name.match(/\.([a-z0-9]{1,5})$/i) || [, "bin"])[1].toLowerCase();
        const r = await postAudio(f, { ext, name: stem, speakers: speakersPref,
          onProgress: (p) => { bar.style.width = `${p * 100}%`; pct.textContent = `${Math.round(p * 100)}%`; } });
        if (r.error) toast(`${f.name}: upload failed (${r.error})`, "err");
        else toast(`${f.name} uploaded, transcribing now`);
      }
      uploading = false;
      idleDrop();
    }

    // ---- cards
    function setRows(list, first = false) {
      rows = list;
      countEl.textContent = list.length;
      const seen = new Set();
      let prev = null;
      for (const m of list) {
        seen.add(m.id);
        let c = cards.get(m.id);
        const key = JSON.stringify(m);
        if (!c) {
          c = card(m);
          if (!first) c.el.classList.add("enter");
          cards.set(m.id, c);
        } else if (c.key !== key && !c.editing) {
          fillCard(c, m);
        }
        c.key = key;
        const want = prev ? prev.nextSibling : grid.firstChild;
        if (want !== c.el) grid.insertBefore(c.el, want);
        prev = c.el;
      }
      for (const [id, c] of cards) {
        if (!seen.has(id)) {
          cards.delete(id);
          c.el.classList.add("leave");
          setTimeout(() => c.el.remove(), 220);
        }
      }
      let empty = grid.querySelector(".empty");
      if (!list.length && !empty) {
        grid.append(h("div.empty", h("div.empty-art", [18, 32, 24, 40, 20, 30, 14].map((v, i) => h("i", { style: { height: `${v}px`, animationDelay: `${i * 0.12}s` } }))),
          h("h3", "No recordings yet"), h("p", "Press the record button to capture a conversation, or drop an audio file anywhere on this page.")));
      } else if (list.length && empty) empty.remove();
    }

    function card(m) {
      const c = { el: h("div.card", { role: "link", tabindex: 0 }), id: m.id };
      c.el.addEventListener("click", (e) => { if (!c.editing && !e.target.closest("button, input")) location.href = `/r/${m.id}`; });
      c.el.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === c.el) location.href = `/r/${m.id}`; });
      fillCard(c, m);
      return c;
    }

    function fillCard(c, m) {
      c.m = m;
      const st = m.status;
      const badge = h("div.badge", { cls: st }, st === "processing" ? h("div.spin") : icon(st === "failed" ? "alert" : st === "queued" ? "clock" : "wave"));
      const sub = [h("span", { "data-ago": m.created_at }, ago(m.created_at))];
      if (m.duration_s) sub.push(" · ", h("span.tnum", clock(m.duration_s)));
      const nameEl = h("div.card-name", { title: m.name }, m.name);
      const more = h("button.icon-btn.menu-btn", { "aria-label": "More actions", on: { click: (e) => { e.stopPropagation(); cardMenu(c, more); } } }, icon("more"));
      c.nameEl = nameEl;
      c.el.replaceChildren(
        h("div.card-top", badge, h("div.card-title", h("div.stamp", { cls: st }, STAMP[st] || st), nameEl, h("div.card-sub", sub)), more),
        h("div.card-foot", footer(c, m)));
    }

    const STAMP = { done: "Transcribed", queued: "Queued", processing: "Processing", failed: "Failed" };
    function footer(c, m) {
      if (m.status === "done") {
        const st = Array.isArray(m.speaker_stats) && m.speaker_stats.length ? m.speaker_stats : null;
        const n = st ? st.length : m.speakers || 0;
        let label = n ? plural(n, "speaker") : "No speech", tip = null;
        if (st) {
          // same share as the detail page's Speakers card: talk / total, rounded per speaker
          const total = st.reduce((a, s) => a + s.seconds, 0) || 1;
          const pct = st.map((s) => Math.round((s.seconds / total) * 100));
          label += ` · ${pct.slice(0, 4).map((p) => `${p}%`).join(" / ")}${n > 4 ? ` +${n - 4}` : ""}`;
          const names = m.speaker_names || {};
          tip = st.map((s, i) => `${names[s.speaker] || `Speaker ${i + 1}`} ${pct[i]}%`).join(" · ");
        }
        return [h("span.dots-wrap", { title: tip }, h("span.dots", Array.from({ length: Math.min(n, 8) }, (_, i) => h("i", { style: { background: PALETTE[i % PALETTE.length] } }))),
                  h("span.dots-label.tnum", label)),
                speed(m.rtf) ? h("span.pill.speed", speed(m.rtf)) : null];
      }
      if (m.status === "queued") return [h("span.pill.queued", "Queued"), h("span.steps-count", "waiting for a worker")];
      if (m.status === "processing") {
        const step = /^preparing/.test(m.note || "") ? 1 : 2;
        return h("div.steps",
          h("div.steps-row", h("span.steps-note", m.note || "processing"), h("span.steps-count", `step ${step} of 2`)),
          h("div.bar.indet", h("i", { style: { width: step === 1 ? "35%" : "75%" } })));
      }
      return h("div.fail", h("div.fail-msg", { title: m.error || "" }, m.error || "Failed"),
        h("button.btn.btn-sm", { on: { click: (e) => { e.stopPropagation(); send("retry", { id: m.id }); } } }, icon("retry"), "Retry"));
    }

    function cardMenu(c, anchor) {
      const m = c.m, items = [{ icon: "pencil", label: "Rename", run: () => rename(c) }];
      if (m.status === "done") items.push({ icon: "download", label: "Download JSON", run: () => (location.href = `/api/recordings/${m.id}/result.json`) });
      if (m.status === "failed") items.push({ icon: "retry", label: "Retry", run: () => send("retry", { id: m.id }) });
      items.push("-", { icon: "trash", label: "Delete", danger: true, run: () => del(m) });
      menu(anchor, items);
    }

    function rename(c) {
      c.editing = true;
      const inp = inlineInput(c.m.name, (v) => {
        if (!v) return c.m.name;
        send("rename", { id: c.m.id, name: v });
        return v;
      }, { cls: "card-name", label: "Recording name" });
      inp.addEventListener("blur", () => setTimeout(() => {
        c.editing = false;
        fillCard(c, { ...c.m, name: inp.value || c.m.name });
      }));
      c.nameEl.replaceWith(inp);
      inp.focus(); inp.select();
    }

    async function del(m) {
      if (await confirmDialog({ title: "Delete recording?", body: `“${m.name}” and its audio and transcript will be removed. This can't be undone.` })) {
        send("delete", { id: m.id });
        toast("Recording deleted");
      }
    }

    return { mount, rows: setRows };
  })();

  // ------------------------------------------------------------ detail
  const Detail = (() => {
    let D = null;           // {row, audio, result}
    let ws = null, main, titleInp, metaEl, playBtn, timeEl, dimEl, bodySlot, colorOf = {}, nameEls = [], words = [], cur = -1, curTurn = null;
    let follow = true, jumpBtn, rafId = 0, elapsedIv = 0, lastUserScroll = 0;

    function mount(data) {
      D = data;
      if (ws) { ws.destroy(); ws = null; }
      main = shell();
      if (!D.row) {
        main.append(h("div.notfound", h("h1", "Recording not found"), h("p", "It may have been deleted."),
          h("a.btn", { href: "/" }, icon("back"), "All recordings")));
        return;
      }
      const r = D.row, res = D.result;
      colorOf = {};
      (res ? res.speakers : []).forEach((s, i) => (colorOf[s.id] = PALETTE[i % PALETTE.length]));

      titleInp = inlineInput(r.name, (v) => { if (!v) return D.row.name; D.row.name = v; send("rename", { id: r.id, name: v }); document.title = v; return v; }, { label: "Recording name" });
      document.title = r.name;
      metaEl = h("div.meta");
      const actions = h("div.dactions",
        res ? h("a.btn", { href: `/api/recordings/${r.id}/result.json`, download: `${r.id}.json` }, icon("download"), h("span", "Download JSON")) : null,
        h("button.icon-btn.danger", { "aria-label": "Delete recording", title: "Delete", on: { click: del } }, icon("trash")));
      main.append(h("div.dhead",
        h("div.dtitle", h("a.back", { href: "/" }, icon("back"), "All recordings"), titleInp, metaEl), actions));
      paintMeta();

      main.append(player());
      bodySlot = h("div");
      main.append(bodySlot);
      renderBody();
    }

    function paintMeta() {
      const r = D.row, res = D.result, parts = [h("span", icon("calendar"), longDate(r.created_at))];
      if (r.duration_s) parts.push(h("span.tnum", icon("clock"), clock(r.duration_s)));
      if (res) parts.push(h("span", icon("users"), plural(res.speakers.length, "speaker")));
      if (speed(r.rtf)) parts.push(h("span", icon("zap"), speed(r.rtf)));
      metaEl.replaceChildren(...parts);
    }

    // ---- player: wavesurfer with speaker-coloured bars, a speaker lane, dimmed unplayed part
    function player() {
      playBtn = h("button.play", { "aria-label": "Play", on: { click: () => ws && ws.playPause() } }, icon("play"));
      timeEl = h("div.ptime", h("b", "0:00"), ` / ${clock(D.row.duration_s)}`);
      const wave = h("div.wave", h("div.wave-loading", Array.from({ length: 48 }, (_, i) => h("i", { style: { animationDelay: `${(i % 12) * 0.08}s` } }))));
      dimEl = h("div.wave-dim", { style: { left: "0" } });
      const hover = h("div.wave-hover", h("span.tnum", "0:00"));
      wave.append(dimEl, hover);
      const lane = h("div.lane");
      const rate = h("div.seg", { "aria-label": "Playback speed" });
      for (const v of [1, 1.5, 2]) {
        rate.append(h("button", { cls: v === 1 ? "on" : "", on: { click: (e) => {
          ws && ws.setPlaybackRate(v, true);
          rate.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.currentTarget));
        } } }, `${v}×`));
      }
      wave.addEventListener("mousemove", (e) => {
        const b = wave.getBoundingClientRect(), p = Math.min(1, Math.max(0, (e.clientX - b.left) / b.width));
        hover.style.left = `${p * 100}%`;
        hover.firstChild.textContent = clock(p * (duration() || 0));
      });

      const segs = D.result ? D.result.segments : [];
      const speakerAt = (t) => {       // binary search over segments sorted by start
        let lo = 0, hi = segs.length - 1, i = -1;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (segs[m][1] <= t) { i = m; lo = m + 1; } else hi = m - 1; }
        return i >= 0 && t <= segs[i][2] + 0.15 ? segs[i][0] : null;
      };

      const create = () => {
        if (!window.WaveSurfer) return setTimeout(create, 50);
        ws = WaveSurfer.create({
          container: wave, url: D.audio, height: "auto", normalize: true, dragToSeek: true,
          waveColor: NEUTRAL, progressColor: "rgba(0,0,0,0)", cursorColor: "#f4b93c", cursorWidth: 1,
          renderFunction: (channels, g) => {
            const data = channels[0], W = g.canvas.width, H = g.canvas.height, dpr = devicePixelRatio || 1;
            const bw = 2 * dpr, gap = 2 * dpr, n = Math.max(1, Math.floor(W / (bw + gap))), step = data.length / n;
            const dur = duration() || 1, peaks = new Float32Array(n);
            let max = 0;
            for (let i = 0; i < n; i++) {
              let p = 0;
              for (let j = Math.floor(i * step), e = Math.floor((i + 1) * step); j < e; j++) { const v = Math.abs(data[j]); if (v > p) p = v; }
              peaks[i] = p; if (p > max) max = p;
            }
            for (let i = 0; i < n; i++) {
              const spk = speakerAt(((i + 0.5) / n) * dur);
              const hh = Math.max(1 * dpr, (peaks[i] / (max || 1)) * H * 0.96);
              g.fillStyle = spk ? colorOf[spk] || NEUTRAL : NEUTRAL;
              g.fillRect(i * (bw + gap), (H - hh) / 2, bw, hh);
            }
          },
        });
        ws.on("decode", () => wave.querySelector(".wave-loading")?.remove());
        ws.on("error", () => { const l = wave.querySelector(".wave-loading"); if (l) l.style.opacity = "0.3"; });
        ws.on("play", () => { playBtn.replaceChildren(icon("pause")); playBtn.setAttribute("aria-label", "Pause"); loop(); });
        ws.on("pause", () => { playBtn.replaceChildren(icon("play")); playBtn.setAttribute("aria-label", "Play"); tick(); });
        ws.on("timeupdate", () => { if (!ws.isPlaying()) tick(); });
        ws.on("ready", () => { timeEl.lastChild.textContent = ` / ${clock(duration())}`; tick(); });
      };
      create();

      if (segs.length) {
        const dur = D.row.duration_s || segs[segs.length - 1][2] || 1;
        const names = Object.fromEntries(D.result.speakers.map((s) => [s.id, s.name]));
        for (const [spk, s, e] of segs) {
          lane.append(h("i", { title: `${names[spk] || spk} · ${clock(s)}–${clock(e)}`,
            style: { left: `${(s / dur) * 100}%`, width: `max(2px, ${((e - s) / dur) * 100}%)`, background: colorOf[spk] || NEUTRAL } }));
        }
      }
      return h("div.player", playBtn, h("div.wave-col", wave, segs.length ? lane : null), h("div.pctrl", timeEl, rate));
    }
    const duration = () => (ws && ws.getDuration()) || D.row.duration_s || 0;

    function loop() { cancelAnimationFrame(rafId); const f = () => { tick(); if (ws && ws.isPlaying()) rafId = requestAnimationFrame(f); }; f(); }

    function tick() {
      if (!ws) return;
      const t = ws.getCurrentTime(), d = duration();
      timeEl.firstChild.textContent = clock(t);
      dimEl.style.left = `${d ? Math.min(100, (t / d) * 100) : 0}%`;
      highlight(t);
    }

    // ---- transcript highlight + follow
    function findWord(t) {        // last word starting at or before t, if we are still inside it
      let lo = 0, hi = words.length - 1, i = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (words[m].s <= t) { i = m; lo = m + 1; } else hi = m - 1; }
      return i >= 0 && t <= words[i].e + 0.3 ? i : -1;
    }
    function highlight(t) {
      if (!words.length) return;
      const i = t > 0 || (ws && ws.isPlaying()) ? findWord(t) : -1;
      if (i === cur) return;
      if (cur >= 0) words[cur].el.classList.remove("hl");
      cur = i;
      if (i < 0) return;   // between words: the turn stays active
      const el = words[i].el;
      el.classList.add("hl");
      const turn = el.closest(".turn");
      if (turn !== curTurn) { curTurn?.classList.remove("active"); curTurn = turn; turn.classList.add("active"); }
      if (ws && ws.isPlaying()) keepInView(el);
    }
    function viewTop() { const p = document.querySelector(".player"); return (p ? p.getBoundingClientRect().bottom : 0) + 12; }
    function inView(el) { const r = el.getBoundingClientRect(); return el.offsetParent && r.top >= viewTop() && r.bottom <= innerHeight - 70; }
    function keepInView(el) {
      if (!el.offsetParent) return;                          // transcript collapsed
      if (!follow) { jumpBtn.classList.toggle("on", !inView(el)); return; }
      if (!inView(el)) scrollToEl(el);
    }
    function scrollToEl(el) {
      const top = viewTop(), r = el.getBoundingClientRect();
      window.scrollBy({ top: r.top - (top + (innerHeight - top) * 0.3), behavior: "smooth" });
    }
    function userScrolled() {
      lastUserScroll = performance.now();
      if (ws && ws.isPlaying() && follow) { follow = false; if (cur >= 0) jumpBtn.classList.toggle("on", !inView(words[cur].el)); }
    }

    // ---- body: result (speakers, transcript, stats) or live progress
    function renderBody() {
      clearInterval(elapsedIv);
      words = []; cur = -1; curTurn = null;
      if (D.result) bodySlot.replaceChildren(resultView());
      else bodySlot.replaceChildren(h("div.box", progressView()));
    }

    function resultView() {
      const res = D.result, r = D.row;
      const total = res.speakers.reduce((a, s) => a + s.talk, 0) || 1;
      nameEls = [];
      const avatarText = (name, i) => (/^Speaker \d+$/.test(name) ? String(i + 1) : name.trim()[0]?.toUpperCase() || String(i + 1));
      const spkRows = res.speakers.map((s, i) => {
        const def = `Speaker ${i + 1}`;
        const av = h("div.avatar", { vars: { "--c": colorOf[s.id] } }, avatarText(s.name, i));
        const inp = inlineInput(s.name, (v) => {
          const name = v || def;
          send("rename_speaker", { speaker: s.id, name: v });
          s.name = name;
          av.textContent = avatarText(name, i);
          document.querySelectorAll(`[data-spk="${CSS.escape(s.id)}"]`).forEach((el) => {
            if (el.classList.contains("avatar")) el.textContent = avatarText(name, i); else el.textContent = name;
          });
          return name;
        }, { maxLength: 60, label: `Name of ${def}` });
        const pct = Math.round((s.talk / total) * 100);
        return h("div.spk", { vars: { "--c": colorOf[s.id] } }, av, inp,
          h("div.share", h("div.track", h("i", { style: { width: `${pct}%` } })), h("b.tnum", `${pct}%`), h("span.tnum", clock(s.talk))));
      });

      // transcript
      const idx = Object.fromEntries(res.speakers.map((s, i) => [s.id, i]));
      const turns = res.turns.map((t) => {
        const i = idx[t.speaker] ?? 0, s = res.speakers[i] || { name: t.speaker };
        const text = h("p.ttext");
        t.words.forEach(([w, a, b], k) => {
          const el = h("span.w", { "data-s": a }, w);
          words.push({ el, s: a, e: b });
          if (k) text.append(" ");
          text.append(el);
        });
        return h("div.turn", { vars: { "--c": colorOf[t.speaker] || NEUTRAL } },
          h("div.avatar", { "data-spk": t.speaker, vars: { "--c": colorOf[t.speaker] || NEUTRAL } }, avatarText(s.name, i)),
          h("div", h("div.tmeta", h("span.tname", { "data-spk": t.speaker }, s.name), h("button.ts", { "data-s": t.start }, clock(t.start))), text));
      });
      const tcard = h("section.box.tcard",
        h("button.thead", { "aria-expanded": "true", on: { click: (e) => {
          const closed = tcard.classList.toggle("closed");
          e.currentTarget.setAttribute("aria-expanded", String(!closed));
        } } }, icon("chevron"), h("span.thead-t", "Transcript"),
          h("span.sub", `${plural(res.turns.length, "turn")} · ${plural(res.words, "word")}`)),
        h("div.tbody", h("div", h("div.turns", turns))));
      tcard.addEventListener("click", (e) => {
        const w = e.target.closest(".w, .ts");
        if (!w || !ws) return;
        ws.setTime(+w.dataset.s + 0.01);
        follow = true; jumpBtn.classList.remove("on");
        ws.play();
      });

      const stat = (l, v, cls = "") => h("div.stat", { cls }, h("div.stat-l", l), h("div.stat-v", { cls: cls === "accent" ? "accent" : "", title: v }, v));
      const stats = h("div.stats",
        stat("Audio", clock(r.duration_s)), stat("Processing", secs(r.processing_s)),
        stat("Speed", r.rtf ? `${+r.rtf.toFixed(1)}×` : "–", "accent"), stat("Words", String(res.words)),
        h("div.stat.wide", h("div.stat-l", "Speech recognition"), h("div.stat-v", { title: res.stt || "" }, res.stt || "–")),
        h("div.stat.wide", h("div.stat-l", "Diarization"), h("div.stat-v", { title: res.diar || "" }, (res.diar || "–").split("/").pop())));

      return h("div.dgrid", tcard,
        h("aside.aside",
          h("section.box.spk-box", h("div.box-h", h("span", h("span.eyebrow-rule"), "Speakers"), h("span", `${res.speakers.length}`)), h("div.spk-list", spkRows)),
          h("section.box.stats-box", h("div.box-h", h("span", h("span.eyebrow-rule"), "Stats")), stats)));
    }

    function progressView() {
      const r = D.row, st = r.status;
      const step = st === "queued" ? 1 : st === "processing" ? (/^preparing/.test(r.note || "") ? 2 : 3) : 3;
      const labels = ["Uploaded", "Queued", "Preparing", "Transcribing", "Done"];
      const curIdx = st === "failed" ? -1 : step;
      const steps = h("div.pv-steps");
      labels.forEach((l, i) => {
        if (i) steps.append(h("div.pv-line", { cls: curIdx > i - 1 && i <= curIdx ? "done" : "" }));
        const state = st === "failed" ? (i === 0 ? "done" : "") : i < curIdx ? "done" : i === curIdx ? "cur" : "";
        steps.append(h("div.pv-step", { cls: state }, h("b", state === "done" ? icon("check") : String(i + 1)), l));
      });
      if (st === "failed") {
        return h("div.progress-view", h("div.pv-ico.failed", icon("alert")), h("h3", "Transcription failed"),
          h("p", r.error || "Unknown error"), h("div", { style: { marginTop: "22px" } },
            h("button.btn.primary", { on: { click: () => send("retry", { id: r.id }) } }, icon("retry"), "Retry")));
      }
      const elapsed = h("div.pv-elapsed");
      const upd = () => (elapsed.textContent = `${clock((Date.now() - new Date(r.created_at)) / 1000)} since upload`);
      upd(); elapsedIv = setInterval(upd, 1000);
      return h("div.progress-view",
        h("div.pv-ico", { cls: st }, st === "queued" ? icon("clock") : h("div.spin")),
        h("h3", st === "queued" ? "Waiting in the queue" : cap(r.note || "processing") + "…"),
        h("p", st === "queued" ? "A worker will pick this up in a moment. This page updates by itself."
          : "The GPU service is transcribing and working out who speaks when. The transcript appears here when it's done."),
        steps, h("div.bar.indet.pv-bar", h("i", { style: { width: `${(step / 4) * 100}%` } })), elapsed);
    }

    async function del() {
      if (await confirmDialog({ title: "Delete recording?", body: `“${D.row.name}” and its audio and transcript will be removed. This can't be undone.` })) {
        send("delete", { id: D.row.id });
        setTimeout(() => (location.href = "/"), 1500);   // normally WSW.gone() comes first
      }
    }

    function update(p) {
      if (!D || !D.row) return;
      if (p.result && !D.result) { const t = ws ? ws.getCurrentTime() : 0; mount(p); if (t) ws.once?.("ready", () => ws.setTime(t)); return; }
      const statusChanged = p.row.status !== D.row.status || p.row.note !== D.row.note;
      D.row = { ...D.row, ...p.row };
      titleInp.setValue(D.row.name);
      document.title = D.row.name;
      paintMeta();
      if (statusChanged && !D.result) renderBody();
    }

    function gone() { location.href = "/"; }

    // keyboard + scroll wiring (once)
    function wire() {
      jumpBtn = document.body.appendChild(h("button.jump", { on: { click: () => {
        follow = true; jumpBtn.classList.remove("on");
        if (cur >= 0) scrollToEl(words[cur].el);
      } } }, icon("down"), "Jump to current"));
      ["wheel", "touchmove"].forEach((ev) => addEventListener(ev, userScrolled, { passive: true }));
      addEventListener("keydown", (e) => {
        if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(e.key)) userScrolled();
      });
      addEventListener("scroll", () => {       // back in view by hand: pick up following again
        if (!follow && cur >= 0 && performance.now() - lastUserScroll < 1500 && inView(words[cur].el)) { follow = true; jumpBtn.classList.remove("on"); }
      }, { passive: true });
      document.addEventListener("keydown", (e) => {
        if (!ws || e.target.closest("input, textarea, [contenteditable]") || document.querySelector(".scrim") || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.code === "Space") { e.preventDefault(); ws.playPause(); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); ws.setTime(Math.max(0, ws.getCurrentTime() - 5)); }
        else if (e.key === "ArrowRight") { e.preventDefault(); ws.setTime(Math.min(duration(), ws.getCurrentTime() + 5)); }
      });
    }

    return { mount: (d) => { wire(); mount(d); }, update, gone };
  })();

  // ------------------------------------------------------------ boot
  let view = null;
  document.addEventListener("DOMContentLoaded", () => {
    const d = window.__WSW;
    if (!d) return;
    view = d.view;
    (view === "home" ? Home : Detail).mount(d);
    health(d.health);
  });

  return {
    rows: (list) => view === "home" && Home.rows(list),
    detail: (p) => view === "detail" && Detail.update(p),
    gone: () => view === "detail" && Detail.gone(),
    health,
    toast,
  };
})();
