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
  // every page: top bar (brand, nav, ASR health), an optional config banner, main, footer
  let healthEl, liveEl, bannerEl, navCountEl, lastHealth = null;
  const healthHooks = [];        // extra places that show the ASR state (the architecture page)
  const NAV = [["home", "/", "New recording", "New"], ["recordings", "/recordings", "Recordings", "Recordings"],
               ["architecture", "/architecture", "Architecture", "Architecture"]];
  function shell(active) {
    const root = document.getElementById("wsw");
    root.replaceChildren();
    const pill = (name) => h("div.health", h("span.dot"), h("span", name), h("span.h-state", " …"));
    healthEl = pill("Batch");
    liveEl = pill("Live");
    navCountEl = h("span.nav-count.tnum", String(navCount));
    const nav = h("nav.nav", { "aria-label": "Pages" }, NAV.map(([key, href, label, short]) =>
      h("a.nav-link", { href, cls: key === active ? "on" : "", "aria-current": key === active ? "page" : null },
        h("span.nav-full", label), h("span.nav-short", short), key === "recordings" ? navCountEl : null)));
    root.append(h("div.top-seam"), h("header.topbar",
      h("a.brand", { href: "/" }, h("img", { src: "/static/favicon.svg", alt: "" }), h("span", "Who said what")),
      nav, h("div.spacer"), h("div.healths", healthEl, liveEl)));
    bannerEl = root.appendChild(h("div", { hidden: true }));
    const main = root.appendChild(h("main.wrap"));
    root.append(h("footer.site-footer", h("span.f-note", "Who said what · self-hosted"), h("span.f-note", "Live · Nemotron streaming  ·  Batch · Parakeet + pyannote")));
    if (lastHealth) health(lastHealth);     // a re-mount (detail page: progress <-> result) keeps the known state
    return main;
  }
  let navCount = 0;
  function setCount(n) { navCount = n; if (navCountEl) navCountEl.textContent = n; }

  function health(v) {
    lastHealth = v;
    if (!healthEl) return;
    // two pills: the batch service (the transcript) and the streaming one (live captions)
    const paint = (el, x, what) => {
      x = x || { ok: null, text: "checking" };
      el.className = "health " + (x.ok ? "ok" : x.ok === false ? "bad" : "");
      el.lastChild.textContent = x.ok ? " online" : x.ok === false ? (/not set/.test(x.text) ? " off" : ` ${String(x.text).split(" (")[0]}`) : " …";
      el.title = `${what}: ${x.text}`;
    };
    paint(healthEl, v, "Batch transcription service (:9100)");
    paint(liveEl, v.live, "Live captions service (:9101)");
    bannerEl.hidden = v.configured !== false;
    bannerEl.className = "banner";
    bannerEl.textContent = "ASR_URL / ASR_TOKEN are not set: recordings are saved but cannot be transcribed. Set them in demo/.env and restart.";
    healthHooks.forEach((fn) => fn(v));
  }

  // teal mono label, thin display title, grey lead; optional right-hand side
  const pageHead = (label, title, lead, right = null) => h("div.sec-head",
    h("div", h("div.split-label", label), h("h1.page-title", title), lead ? h("p.page-lead", lead) : null), right);
  const secHead = (label, title, right = null) => h("div.list-head", h("div", h("div.split-label", label), h("h2", title)), right);
  const moreLink = (href, text) => h("a.more-link", { href }, text, h("span.arr", "→"));

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
  const tickAgo = () => setInterval(() => document.querySelectorAll("[data-ago]").forEach((el) => (el.textContent = ago(el.dataset.ago))), 30000);

  // browser storage can throw (private windows, blocked site data): preferences are a convenience
  const pref = {
    get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* not remembered */ } },
  };
  // a toast for the next page (shown by boot), e.g. "Live transcript saved" after navigating
  const flash = (msg) => { try { sessionStorage.setItem("wsw.toast", msg); } catch { /* no toast */ } };

  // LIVE mode: the multipart save of a live session (audio + the live service's final segments)
  async function postLive(blob, { ext, speakers, result }) {
    const q = new URLSearchParams({ ext });
    if (speakers) q.set("num_speakers", speakers);
    const fd = new FormData();
    fd.append("result", JSON.stringify(result));
    fd.append("audio", blob, `recording.${ext}`);
    try {
      const r = await fetch("/api/recordings/live?" + q, { method: "POST", body: fd });
      let body = {};
      try { body = await r.json(); } catch { /* not json */ }
      return r.ok && body.id ? body : { error: body.error || `HTTP ${r.status}` };
    } catch {
      return { error: "network error" };
    }
  }

  const MODES = {
    live: { label: "Live", hint: "Live transcript as you speak · Nemotron streaming",
      tip: "LIVE: the transcript appears while you speak (Nemotron streaming) and is saved as is. You can upgrade it to the accurate transcript later." },
    record: { label: "Record", hint: "Accurate transcript after you stop · Parakeet + pyannote",
      tip: "RECORD: record first; after you stop, the batch pass (Parakeet + pyannote) builds the accurate transcript with word timings." },
  };

  const Home = (() => {
    let lib, recentCount, heroEl, libEl, sessEl;
    let speakersPref = pref.get("wsw.speakers", "");
    let mode = pref.get("wsw.mode", "live") === "record" ? "record" : "live";
    let rowsNow = [];

    function mount(data) {
      const main = shell("home");
      lib = Library({ limit: 3, cls: "recent",
        empty: () => h("div.empty.slim", h("h3", "Nothing here yet"), h("p", "Your latest recordings show up here as soon as they are saved.")) });
      heroEl = h("section.hero",
        h("div.page-head",
          h("div",
            h("div.eyebrow", h("span.eyebrow-rule"), "Live + batch transcription · self-hosted"),
            h("h1.page-title", "New recording")),
          h("p.page-lead", "Record a conversation or drop in a file. Watch the transcript appear as you speak, or get the word-timed one, split by speaker, seconds after you stop.")),
        h("div.studio", Recorder.el(), dropZone()));
      libEl = h("section.library",
        secHead((recentCount = h("span", "Recent")), "Latest recordings", moreLink("/recordings", "View all recordings")),
        lib.el);
      sessEl = Session.el();
      main.append(heroEl, libEl, sessEl);
      healthHooks.push(() => Recorder.paintHint());
      pageDrop();
      setRows(data.rows, true);
      tickAgo();
    }
    function setRows(list, first = false) {
      rowsNow = list;
      setCount(list.length);
      recentCount.textContent = list.length > 3 ? `Recent · 3 of ${list.length}` : "Recent";
      lib.set(list, first);
      Session.rows(list);
    }

    // idle home <-> the focused live session: a ~200 ms cross-fade, then the other side is hidden
    let viewT = 0;
    const inSession = () => document.body.classList.contains("in-session");
    function showSession(on) {
      if (inSession() === on) return;
      document.body.classList.toggle("in-session", on);
      clearTimeout(viewT);
      const out = on ? [heroEl, libEl] : [sessEl], inn = on ? [sessEl] : [heroEl, libEl];
      out.forEach((el) => { el.classList.remove("v-in"); el.classList.add("v-out"); });
      inn.forEach((el) => el.classList.remove("v-out", "v-in"));
      viewT = setTimeout(() => {
        out.forEach((el) => { el.hidden = true; el.classList.remove("v-out"); });
        inn.forEach((el) => { el.hidden = false; el.classList.add("v-in"); });
        scrollTo({ top: 0, behavior: "instant" });
      }, 200);
    }

    function segControl(opts, get, set, label, cls = "") {
      const seg = h("div.seg", { cls, role: "radiogroup", "aria-label": label });
      const paint = () => seg.querySelectorAll("button").forEach((b) => {
        b.classList.toggle("on", b.dataset.v === get());
        b.setAttribute("aria-checked", String(b.dataset.v === get()));
      });
      for (const [v, text, tip] of opts) seg.append(h("button", { "data-v": v, role: "radio", title: tip, on: { click: () => { set(v); paint(); } } }, text));
      paint();
      return seg;
    }
    const speakersControl = () => h("div.field-label", "Speakers", segControl(
      [["", "Auto"], ["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]], () => speakersPref,
      (v) => { speakersPref = v; pref.set("wsw.speakers", v); }, "Number of speakers"));
    const modeControl = () => segControl(Object.entries(MODES).map(([k, m]) => [k, m.label, m.tip]), () => mode,
      (v) => { if (Recorder.busy()) return; mode = v; pref.set("wsw.mode", v); Recorder.paintHint(); }, "Recording mode", "mode-seg");

    // ---- LIVE mode, the live transcript: the mic's 16 kHz PCM goes up /ws/live (a proxy in the ui
    // that adds the token) to the streaming service; updates come back as {from, segments}:
    // segments at `from` and after were revised, the last one grows word by word. On stop the
    // service sends `final` (every segment), which is what gets saved. Nothing here can stop a
    // recording: a failure only shows a notice, and the file then takes the batch path.
    const Live = (() => {
      const SR = 16000, MAX_QUEUE = 100, MAX_BUFFERED = 512 * 1024, READY_TIMEOUT = 8000;
      let ws = null, node = null, sink = null, queue = [], segs = [], finalSegs = null, waiters = [];
      let captured = 0, dropped = 0, lags = [], sid = 0, stopping = false, failed = false, readyT = 0, recAt = 0, tapAt = 0;

      function teardown() {
        clearTimeout(readyT);
        if (node) { try { node.port.onmessage = null; node.disconnect(); } catch { /* ctx closed */ } }
        if (sink) { try { sink.disconnect(); } catch { /* ctx closed */ } }
        node = sink = null; queue = [];
        if (ws) { ws.onclose = ws.onmessage = null; if (ws.readyState <= 1) ws.close(); ws = null; }
      }
      function settle(v) { const w = waiters; waiters = []; w.forEach((fn) => fn(v)); }

      function unavailable(my) {
        if (my !== sid || failed) return;
        failed = true;
        teardown();
        Session.pill("off", "Live · off");
        Session.unavailable(segs.length > 0);
        settle(null);
      }

      async function tap(ctx, src, my) {
        try {
          await ctx.audioWorklet.addModule(window.WSW_WORKLET || "/static/pcm-worklet.js");
          if (my !== sid || failed || stopping) return;
          node = new AudioWorkletNode(ctx, "pcm-tap");
          sink = ctx.createGain(); sink.gain.value = 0;     // keeps the node pulled, plays nothing
          node.port.onmessage = (e) => {
            const n = e.data.byteLength / 2;
            if (!captured) tapAt = performance.now() - (n / SR) * 1000;   // where the stream's t = 0 sits in the file
            captured += n;
            if (ws && ws.readyState === 1 && !queue) {
              if (ws.bufferedAmount > MAX_BUFFERED) return unavailable(my);   // stuck: give up, don't pile up
              ws.send(e.data);
            } else if (queue) {
              queue.push(e.data);                           // before "ready": keep the first words
              if (queue.length > MAX_QUEUE) dropped += queue.shift().byteLength / 2;
            }
          };
          src.connect(node); node.connect(sink); sink.connect(ctx.destination);
        } catch {
          if (!stopping) unavailable(my);
        }
      }

      function start(ctx, src, speakers, t0) {
        teardown();
        const my = ++sid;
        stopping = failed = false; segs = []; finalSegs = null; settle(null);
        captured = dropped = 0; lags = []; queue = []; recAt = tapAt = t0;
        Session.pill("wait", "Live · connecting");
        tap(ctx, src, my);
        try {
          ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/live`);
        } catch { return unavailable(my); }
        ws.binaryType = "arraybuffer";
        readyT = setTimeout(() => unavailable(my), READY_TIMEOUT);
        ws.onopen = () => ws.send(JSON.stringify({ type: "start", sample_rate: SR, encoding: "pcm_s16le",
          language: "auto", max_speakers: speakers ? +speakers : 4 }));
        ws.onmessage = (ev) => {
          if (my !== sid) return;
          let m;
          try { m = JSON.parse(ev.data); } catch { return; }
          if (m.type === "ready") {
            clearTimeout(readyT);
            if (!stopping) Session.pill("on", "Live");
            const q = queue; queue = null;
            for (const b of q || []) ws.send(b);
          } else if (m.type === "update") {
            apply(m.from, m.segments);
            measure(m.segments);
          } else if (m.type === "final") {
            finalSegs = m.segments || [];
            apply(0, finalSegs);
            Session.pill("final", "Final");
            settle(finalSegs);
          } else if (m.type === "error" && !stopping) {
            unavailable(my);
          }
        };
        ws.onclose = () => {
          if (my !== sid) return;
          if (!stopping) unavailable(my);
          else settle(finalSegs);
        };
      }

      // segs = segs[:from] + segments; the view re-renders from the first turn that changed
      function apply(from, list) {
        segs = segs.slice(0, from).concat(list);
        Session.render(from, segs, offset());
      }
      // stream time -> file time: the tap starts a moment after MediaRecorder, and audio dropped
      // from the pre-"ready" queue never reached the service
      const offset = () => Math.max(0, (tapAt - recAt) / 1000) + dropped / SR;

      // word latency, as the service's test client measures it: audio captured so far minus the
      // end of the newest segment when an update arrives (median of the last few)
      function measure(list) {
        if (!list.length || stopping) return;
        const lag = captured / SR - Math.max(...list.map((g) => g.end));
        if (lag < -0.5 || lag > 30) return;
        lags.push(Math.max(0, lag));
        Session.pill("on", `Live · ${median(lags.slice(-8)).toFixed(1)} s`);
      }
      const median = (a) => { const w = a.slice().sort((x, y) => x - y); return w.length ? w[w.length >> 1] : null; };

      function stop() {
        const my = sid;
        stopping = true;
        clearTimeout(readyT);
        if (failed || !ws) return settle(null);
        if (queue) { teardown(); settle(null); return; }      // never got going: nothing to wait for
        if (node) node.port.postMessage("flush");
        Session.pill("wait", "Finishing");
        setTimeout(() => {                                     // after the last batch went out
          if (my !== sid || !ws) return;
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: "stop" }));
          if (node) { try { node.disconnect(); } catch { /* ctx closed */ } }
          const sock = ws;
          setTimeout(() => { if (sock.readyState <= 1) sock.close(); }, 15000);
        }, 150);
      }

      // the `final` segments, or null (failed, or nothing within ms)
      const waitFinal = (ms) => (finalSegs || failed || !ws || ws.readyState === 3) ? Promise.resolve(finalSegs)
        : new Promise((res) => { waiters.push(res); setTimeout(() => res(finalSegs), ms); });

      function close() { sid++; stopping = true; teardown(); settle(null); }

      return { start, stop, close, waitFinal, offset, latency: () => median(lags),
        stats: () => ({ lags: lags.slice(), segments: segs.slice(), failed, offset: offset() }) };
    })();

    // ---- the live session view: a sticky recording bar + the transcript as chat turns
    const Session = (() => {
      let root, bar, timeEl, meter, pillEl, spkEl, turnsEl, noteEl, draftEl, countEl, jump;
      let turns = [], lastGrow = null, growing = false, follow = true, lastInput = 0, held = false;
      let pendingId = null, navT = 0, durS = 0, phase = "idle", my = 0;

      function el() {
        timeEl = h("span.sb-time.tnum", "00:00");
        meter = h("canvas.sb-meter", { height: 30, "aria-hidden": "true" });
        pillEl = h("span.pill.live-pill", "Live");
        spkEl = h("span.chip");
        bar = h("div.sbar", { role: "region", "aria-label": "Recording" });
        turnsEl = h("div.turns.lturns", { "aria-live": "polite" });
        noteEl = h("div.lt-note");
        draftEl = h("span.draft-stamp", { hidden: true }, "Live draft");
        countEl = h("span.lt-count.tnum");
        root = h("section.session", { hidden: true }, bar,
          h("section.box.lt",
            h("div.lt-head", h("span", h("span.eyebrow-rule"), "Live transcript"), h("span.lt-side", draftEl, countEl)),
            turnsEl, noteEl));
        jump = document.body.appendChild(h("button.jump", { on: { click: () => { follow = true; jump.classList.remove("on"); jump.blur(); toBottom(true); } } },
          icon("down"), "Jump to live"));
        wire();
        return root;
      }

      // ---- smart scroll: page-level; follow the newest line while the reader is at the bottom
      const active = () => phase !== "idle";
      const scrollable = () => document.documentElement.scrollHeight > innerHeight + 8;
      const atBottom = () => innerHeight + scrollY >= document.documentElement.scrollHeight - 72;
      const toBottom = (smooth) => scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth ? "smooth" : "instant" });
      function unfollow() {
        if (!active() || !turns.length || !scrollable()) return;
        follow = false; jump.classList.add("on");
      }
      function wire() {
        const input = () => (lastInput = performance.now());
        let ty = 0;
        addEventListener("wheel", (e) => { input(); if (e.deltaY < 0) unfollow(); }, { passive: true });
        addEventListener("touchstart", (e) => { ty = e.touches[0].clientY; }, { passive: true });
        addEventListener("touchmove", (e) => { input(); if (e.touches[0].clientY > ty + 6) unfollow(); }, { passive: true });
        addEventListener("keydown", (e) => {
          if (["PageUp", "ArrowUp", "Home"].includes(e.key)) { input(); unfollow(); }
          else if (["PageDown", "ArrowDown", "End"].includes(e.key)) input();
        });
        addEventListener("pointerdown", (e) => { if (e.target === document.documentElement) { held = true; input(); } });
        addEventListener("pointerup", () => (held = false));
        addEventListener("scroll", () => {
          if (!active()) return;
          if (atBottom()) { follow = true; jump.classList.remove("on"); }
          else if (held || performance.now() - lastInput < 500) unfollow();
        }, { passive: true });
      }

      // ---- the bar: one layout per phase (recording / saving / processing / failed)
      const brk = () => h("span.sb-break");
      function paintBar() {
        const kids = [];
        if (phase === "recording") {
          kids.push(h("div.sb-rec", h("span.rec-dot"), h("span.sb-label", "Rec"), timeEl), meter, brk(),
            h("div.sb-chips", spkEl, pillEl),
            h("div.sb-act", h("button.btn.danger.sb-stop", { title: "Stop (Space)", on: { click: () => Recorder.toggle() } },
              icon("stop"), h("span", "Stop"), h("kbd", "Space"))));
        } else if (phase === "saving") {
          kids.push(h("div.sb-status", h("span.sb-ico", h("div.spin")),
            h("div.sb-msg", h("b", "Saving"), h("span", `${timer(durS)} · the live transcript and the audio…`))));
        } else if (phase === "processing" || phase === "ready") {
          const row = rowsNow.find((r) => r.id === pendingId) || { status: "queued" };
          const step = phase === "ready" ? 3 : row.status === "queued" ? 0 : /^preparing/.test(row.note || "") ? 1 : 2;
          const steps = h("div.msteps", ["Queued", "Preparing", "Transcribing"].map((l, i) =>
            h("span.mstep", { cls: i < step ? "done" : i === step ? "cur" : "" }, h("i"), l)));
          kids.push(h("div.sb-status",
            h("span.sb-ico", { cls: phase === "ready" ? "ok" : "" }, phase === "ready" ? icon("check") : h("div.spin")),
            h("div.sb-msg", h("b", phase === "ready" ? "Ready" : "Saved"),
              h("span", phase === "ready" ? "the accurate transcript is done · opening it…" : `${timer(durS)} · building the accurate transcript…`))),
          steps, brk(), actions(true));
        } else if (phase === "failed" || phase === "upload-failed") {
          const row = rowsNow.find((r) => r.id === pendingId) || {};
          const msg = phase === "failed" ? row.error || "Transcription failed" : upErr;
          kids.push(h("div.sb-status.bad", h("span.sb-ico.bad", icon("alert")),
            h("div.sb-msg", h("b", phase === "failed" ? "Failed" : "Not saved"), h("span", { title: msg }, msg))), brk(),
            h("div.sb-act",
              phase === "failed" ? h("button.btn.btn-sm", { on: { click: () => send("retry", { id: pendingId }) } }, icon("retry"), "Retry") : null,
              phase === "failed" ? h("a.btn.btn-sm", { href: `/r/${pendingId}` }, "Open") : null,
              h("button.btn.btn-sm", { on: { click: close } }, icon("back"), "New recording")));
        }
        bar.className = `sbar ${phase}`;
        bar.replaceChildren(...kids);
      }
      const actions = () => h("div.sb-act",
        h("a.more-link.sb-open", { href: `/r/${pendingId}` }, "Open now", h("span.arr", "→")),
        h("button.btn.btn-sm", { on: { click: close } }, icon("back"), "New recording"));
      let upErr = "";

      function setNote(kind, text) {
        noteEl.dataset.kind = kind || "";
        if (!kind) return noteEl.replaceChildren();
        noteEl.replaceChildren(kind === "empty"
          ? h("div.lt-empty", h("span.lt-eq", [0, 1, 2, 3, 4].map((i) => h("i", { style: { animationDelay: `${i * 0.14}s` } }))), text)
          : h("div.lt-notice", icon("alert"), h("span", text)));
      }

      // ---- turns: consecutive segments of one speaker are one turn; revisions (the `from` index)
      // re-render from the first turn that contains a changed segment, patching nodes in place
      function makeTurn() {
        const t = { spk: -1, a: 0, b: 0, av: h("div.avatar"), name: h("span.tname"), ts: h("span.ts.tnum"), text: h("p.ttext") };
        t.el = h("div.turn.lturn", t.av, h("div", h("div.tmeta", t.name, t.ts), t.text));
        return t;
      }
      function render(from, segs, off) {
        if (!active()) return;
        let k = turns.findIndex((t) => t.b > from);
        if (k < 0) k = Math.max(0, turns.length - 1);
        let i = turns[k] ? turns[k].a : 0, j = k;
        while (i < segs.length) {
          const spk = segs[i].speaker;
          let e = i + 1;
          while (e < segs.length && segs[e].speaker === spk) e++;
          let t = turns[j];
          if (!t) { t = turns[j] = makeTurn(); turnsEl.append(t.el); }
          if (t.spk !== spk) {
            t.spk = spk;
            t.el.style.setProperty("--c", PALETTE[spk % PALETTE.length]);
            t.av.textContent = String(spk + 1);
            t.name.textContent = `Speaker ${spk + 1}`;
          }
          const ts = timer(segs[i].start + off), text = segs.slice(i, e).map((g) => g.text.trim()).filter(Boolean).join(" ");
          if (t.ts.textContent !== ts) t.ts.textContent = ts;
          if (t.text.textContent !== text) t.text.textContent = text;
          t.a = i; t.b = e; i = e; j++;
        }
        while (turns.length > j) turns.pop().el.remove();
        paintGrow();
        if (turns.length && noteEl.dataset.kind === "empty") setNote(null);
        countEl.textContent = turns.length ? plural(turns.length, "turn") : "";
        if (!follow && atBottom() && performance.now() - lastInput > 600) { follow = true; jump.classList.remove("on"); }
        if (follow) toBottom(false);
      }
      function paintGrow() {
        const last = growing ? turns[turns.length - 1]?.el || null : null;
        if (last === lastGrow) return;
        lastGrow?.classList.remove("growing");
        last?.classList.add("growing");
        lastGrow = last;
      }

      function begin(speakers) {
        clearTimeout(navT);
        my++;
        phase = "recording"; pendingId = null; growing = true; follow = true;
        turns = []; lastGrow = null; turnsEl.replaceChildren(); countEl.textContent = "";
        draftEl.hidden = true; root.classList.remove("stopped");
        spkEl.replaceChildren(icon("users"), h("span.chip-k", "Speakers"), h("b", speakers ? speakers : "Auto"));
        spkEl.title = "Speakers: set before recording, fixed while it runs";
        timeEl.textContent = "00:00";
        setNote("empty", "Listening… start talking");
        paintBar();
        showSession(true);
      }
      function stopped(d) {
        durS = d; growing = false; paintGrow();
        draftEl.hidden = !turns.length; root.classList.add("stopped");
        if (noteEl.dataset.kind === "empty") setNote("empty", "Finishing the last words…");
      }
      function saving(d) { stopped(d); phase = "saving"; paintBar(); }
      function processing(id) {
        phase = "processing"; pendingId = id;
        if (noteEl.dataset.kind === "empty") setNote(turns.length ? null : "notice", "No live transcript for this one: the accurate transcript is being built from the recording.");
        paintBar(); rows(rowsNow);
      }
      function uploadFailed(err) { phase = "upload-failed"; upErr = err; if (noteEl.dataset.kind === "empty") setNote(null); paintBar(); }
      function unavailable(hadWords) {
        if (!active()) return;
        setNote("notice", hadWords ? "Live captions stopped — the full transcript will be ready after you stop"
          : "Live captions unavailable — the full transcript will be ready after you stop");
      }
      function rows() {
        if (!pendingId || !["processing", "ready", "failed"].includes(phase)) return;
        const row = rowsNow.find((r) => r.id === pendingId);
        if (!row) return;
        if (row.status === "done" && phase !== "ready") {
          phase = "ready"; paintBar();
          const mine = my, id = pendingId;
          flash("Accurate transcript ready");
          navT = setTimeout(() => { if (mine === my && phase === "ready") location.href = `/r/${id}`; }, 900);
          return;
        }
        if (row.status === "failed") { phase = "failed"; paintBar(); return; }
        if (row.status === "queued" || row.status === "processing") {
          if (phase !== "processing") phase = "processing";
          paintBar();
        }
      }
      function close() {
        clearTimeout(navT);
        try { sessionStorage.removeItem("wsw.toast"); } catch { /* none */ }
        my++; phase = "idle"; pendingId = null;
        Live.close();
        jump.classList.remove("on");
        showSession(false);
      }

      return { el, begin, render, pill: (kind, text) => { pillEl.className = `pill live-pill ${kind}`; pillEl.textContent = text; },
        tick: (t) => { if (phase === "recording") timeEl.textContent = timer(t); }, meter: () => (phase === "recording" ? meter : null),
        saving, processing, uploadFailed, unavailable, rows, close, active };
    })();

    // ---- recorder
    const Recorder = (() => {
      let panel, btn, timeEl, hintEl, canvas, rec = null, stream = null, ctx = null, an = null, raf = 0, t0 = 0, chunks = [], mime = "", state = "idle", recMode = mode;
      const levels = [];
      const types = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];
      const extOf = (m) => (m.includes("ogg") ? "ogg" : m.includes("mp4") ? "m4a" : "webm");

      function el() {
        btn = h("button.rec-btn", { "aria-label": "Start recording", on: { click: toggle } }, icon("mic"));
        timeEl = h("div.rec-time", "00:00");
        hintEl = h("div.rec-hint");
        canvas = h("canvas.rec-wave", { height: 64 });
        panel = h("div.panel.rec-panel",
          h("div.rec-head", h("div.stamp", "01 · Microphone"), modeControl()),
          h("div.rec-main", btn, h("div.rec-info", timeEl, hintEl)),
          canvas,
          h("div.rec-foot", speakersControl(), h("span.field-label.kbd-hint", "Space to start / stop")));
        paintHint();
        requestAnimationFrame(draw);
        addEventListener("resize", () => draw());
        document.addEventListener("keydown", (e) => {
          if (e.code === "Space" && !e.target.closest("input, textarea, button, a, [contenteditable]") && !document.querySelector(".scrim")) {
            e.preventDefault(); toggle();
          }
        });
        return panel;
      }

      function paintHint() {
        if (!hintEl) return;
        const down = mode === "live" && lastHealth && lastHealth.live && lastHealth.live.ok === false;
        hintEl.classList.toggle("warn", state === "idle" && down);
        hintEl.textContent = { idle: down ? "Live service offline · you'll get the accurate transcript after you stop" : MODES[mode].hint,
          starting: "Waiting for the microphone…", recording: "Recording · tap to stop", uploading: "Uploading…" }[state];
      }

      function bars(cv, { bw, gap, color, fadeFrom = 0.3 }) {
        const dpr = devicePixelRatio || 1, W = cv.clientWidth * dpr, H = cv.clientHeight * dpr;
        if (!W) return;
        if (cv.width !== W) cv.width = W;
        if (cv.height !== H) cv.height = H;
        const g = cv.getContext("2d");
        g.clearRect(0, 0, W, H);
        const b = bw * dpr, s = gap * dpr, n = Math.floor(W / (b + s));
        for (let i = 0; i < n; i++) {
          const v = levels[levels.length - n + i];
          const hh = v == null ? 1 * dpr : Math.max(2 * dpr, v * H * 0.92);
          g.fillStyle = v == null ? "rgba(200,200,200,0.14)" : `rgba(${color}, ${Math.min(1, fadeFrom + (i / n) * 0.9)})`;
          g.fillRect(i * (b + s), (H - hh) / 2, b, hh);
        }
      }
      function draw() {          // scrolling level history, newest on the right
        raf = 0;
        if (!canvas) return;
        if (an) {
          const buf = new Float32Array(an.fftSize);
          an.getFloatTimeDomainData(buf);
          let s = 0; for (const v of buf) s += v * v;
          levels.push(Math.min(1, Math.sqrt(s / buf.length) * 5));
          if (levels.length > 600) levels.splice(0, levels.length - 600);
          const t = (performance.now() - t0) / 1000;
          timeEl.textContent = timer(t);
          Session.tick(t);
        }
        bars(canvas, { bw: 2, gap: 3, color: "224, 104, 80" });
        const m = Session.meter();
        if (m) bars(m, { bw: 2, gap: 2, color: "224, 104, 80", fadeFrom: 0.25 });
        if (an) raf = requestAnimationFrame(draw);
      }

      function setState(s) {
        state = s;
        panel.classList.toggle("live", s === "recording");
        btn.replaceChildren(icon(s === "recording" ? "stop" : "mic"));
        btn.disabled = s === "starting" || s === "uploading";
        btn.setAttribute("aria-label", s === "recording" ? "Stop recording" : "Start recording");
        paintHint();
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
          const recAt = performance.now();
          recMode = mode;
          // one 16 kHz context for the level meter and (LIVE) the PCM tap (the browser resamples
          // the mic); Firefox can't mix rates, so it gets the native rate instead
          let src;
          try { ctx = new AudioContext({ sampleRate: 16000 }); src = ctx.createMediaStreamSource(stream); }
          catch { if (ctx) ctx.close(); ctx = new AudioContext(); src = ctx.createMediaStreamSource(stream); }
          an = ctx.createAnalyser(); an.fftSize = 1024;
          src.connect(an);
          t0 = performance.now(); levels.length = 0;
          setState("recording");
          if (recMode === "live") {
            Session.begin(speakersPref);
            try { Live.start(ctx, src, speakersPref, recAt); } catch { Session.unavailable(false); }
          } else if (Session.active()) {
            Session.close();                               // a RECORD take started from the session view
          }
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
        const live = recMode === "live", dur = (performance.now() - t0) / 1000;
        setState("uploading");
        const stopped = new Promise((r) => (rec.onstop = r));
        if (live) { Session.saving(dur); try { Live.stop(); } catch { /* captions are optional */ } }
        rec.stop(); await stopped;
        await new Promise((r) => setTimeout(r, 160));   // the PCM tap sends its last batch
        cleanup();
        const blob = new Blob(chunks, { type: mime.split(";")[0] }); chunks = []; rec = null;
        const ext = extOf(mime);
        timeEl.textContent = "00:00";
        levels.length = 0; draw();
        if (!blob.size) { setState("idle"); toast("Empty recording", "err"); if (live) Session.close(); return; }
        if (live) {
          const final = await Live.waitFinal(12000);
          if (final) {
            const off = Live.offset(), lat = Live.latency();
            const r = await postLive(blob, { ext, speakers: speakersPref, result: {
              segments: final.map((g) => ({ speaker: g.speaker, start: g.start + off, end: g.end + off, text: g.text })),
              latency_s: lat, audio_s: dur } });
            if (!r.error) {
              setState("idle");
              flash("Live transcript saved");
              location.href = `/r/${r.id}`;
              return;
            }
            toast(`Saving the live transcript failed (${r.error}): building the accurate transcript instead`, "err");
          }
        }
        const r = await postAudio(blob, { ext, speakers: speakersPref });
        setState("idle");
        if (live) {
          if (r.error) { Session.uploadFailed(`Upload failed: ${r.error}`); toast(`Upload failed: ${r.error}`, "err"); }
          else Session.processing(r.id);
          return;
        }
        if (r.error) toast(`Upload failed: ${r.error}`, "err");
        else toast("Recording saved, transcribing now");
      }
      return { el, toggle, paintHint, busy: () => state !== "idle" };
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
      const off = () => { depth = 0; veil.classList.remove("on"); dropEl.classList.remove("over"); };
      addEventListener("dragenter", (e) => { if (hasFiles(e) && !inSession()) { depth++; veil.classList.add("on"); dropEl.classList.add("over"); } });
      addEventListener("dragleave", () => { if (--depth <= 0) off(); });
      addEventListener("dragover", (e) => {        // while recording: no drop target (and the browser won't open the file)
        if (!hasFiles(e)) return;
        e.preventDefault();
        if (inSession()) e.dataTransfer.dropEffect = "none";
      });
      addEventListener("drop", (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault(); off();
        if (!inSession()) uploadFiles([...e.dataTransfer.files]);
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

    return { mount, rows: setRows, liveStats: () => Live.stats() };
  })();

  // ------------------------------------------------------------ recording cards (home strip + library page)
  // Library({limit, cls, empty, filter}) -> {el, set(rows, first), setFilter(fn)}: a live card grid.
  // Cards are keyed by id and patched in place, so a status change never re-creates the card.
  function Library({ limit = 0, cls = "", empty }) {
    const grid = h("div.grid", { cls });
    const cards = new Map();
    let rows = [], match = () => true;

    function set(list, first = false) {
      rows = list;
      const shown = list.filter(match).slice(0, limit || undefined);
      const seen = new Set();
      let prev = null;
      for (const m of shown) {
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
      const emptyEl = grid.querySelector(".empty");
      if (!shown.length) {
        const next = empty(list);
        if (emptyEl) emptyEl.replaceWith(next); else grid.append(next);
      } else if (emptyEl) emptyEl.remove();
    }
    return { el: grid, set, setFilter: (fn, render = true) => { match = fn; if (render) set(rows); } };
  }

  const emptyArt = () => h("div.empty-art", [18, 32, 24, 40, 20, 30, 14].map((v, i) => h("i", { style: { height: `${v}px`, animationDelay: `${i * 0.12}s` } })));

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
      h("div.card-top", badge, h("div.card-title", st === "done" ? srcStamp(m.source) : h("div.stamp", { cls: st }, STAMP[st] || st), nameEl, h("div.card-sub", sub)), more),
      h("div.card-foot", footer(c, m)));
  }

  const STAMP = { done: "Transcribed", queued: "Queued", processing: "Processing", failed: "Failed" };
  // who made the transcript: the live streaming models (LIVE mode) or the batch pass
  const SOURCE = { live: ["Live", "Nemotron"], batch: ["Batch", "Parakeet + pyannote"] };
  const srcOf = (v) => (v === "live" ? "live" : "batch");
  const srcStamp = (v) => h("div.stamp.src", { cls: srcOf(v), title: v === "live" ? "Transcribed live while recording (Nemotron streaming)" : "Transcribed by the batch pass (Parakeet + pyannote)" },
    `${SOURCE[srcOf(v)][0]} · ${SOURCE[srcOf(v)][1]}`);
  const srcPill = (v) => h("span.src-pill", { cls: srcOf(v) }, `${SOURCE[srcOf(v)][0]} · ${SOURCE[srcOf(v)][1]}`);
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

  // ------------------------------------------------------------ /recordings: the whole library
  const Recordings = (() => {
    let lib, labelEl, pills = {}, cur = "all";
    const FILTERS = [["all", "All", () => true], ["done", "Done", (m) => m.status === "done"],
                     ["processing", "Processing", (m) => m.status === "processing" || m.status === "queued"],
                     ["failed", "Failed", (m) => m.status === "failed"]];

    function mount(data) {
      const main = shell("recordings");
      document.title = "Recordings · Who said what";
      lib = Library({ empty: (list) => list.length
        ? h("div.empty.slim", h("h3", `No ${FILTERS.find((f) => f[0] === cur)[1].toLowerCase()} recordings`), h("p", "Try another filter."))
        : h("div.empty", emptyArt(), h("h3", "No recordings yet"),
            h("p", "Record a conversation or drop in an audio file to get started."),
            h("a.btn.primary", { href: "/", style: { marginTop: "18px" } }, icon("mic"), "New recording")) });
      const filters = h("div.filters", { role: "tablist", "aria-label": "Filter recordings" }, FILTERS.map(([k, label]) =>
        (pills[k] = h("button.fpill", { role: "tab", on: { click: () => pick(k) } }, label, h("span.tnum", "0")))));
      main.append(h("section.library.page",
        pageHead((labelEl = h("span", "Library")), "Recordings",
          "Everything you have recorded or uploaded, newest first. Statuses update live while the GPU works.", filters),
        lib.el));
      pick(cur, false);
      setRows(data.rows, true);
      tickAgo();
    }
    function pick(k, render = true) {
      cur = k;
      Object.entries(pills).forEach(([key, el]) => { el.classList.toggle("on", key === k); el.setAttribute("aria-selected", String(key === k)); });
      lib.setFilter(FILTERS.find((f) => f[0] === k)[2], render);
    }
    function setRows(list, first = false) {
      setCount(list.length);
      labelEl.textContent = `Library · ${list.length}`;
      for (const [k, , fn] of FILTERS) pills[k].lastChild.textContent = list.filter(fn).length;
      lib.set(list, first);
    }
    return { mount, rows: setRows };
  })();

  // ------------------------------------------------------------ detail
  const Detail = (() => {
    let D = null;           // {row, audio, result}
    let ws = null, main, titleInp, metaEl, playBtn, timeEl, dimEl, bodySlot, colorOf = {}, nameEls = [], words = [], cur = -1, curTurn = null;
    let follow = true, jumpBtn, rafId = 0, elapsedIv = 0, lastUserScroll = 0, rerunAt = 0;

    function mount(data) {
      D = data;
      if (ws) { ws.destroy(); ws = null; }
      main = shell("recordings");
      if (D.count != null) setCount(D.count);
      if (!D.row) {
        main.append(h("div.notfound", h("h1", "Recording not found"), h("p", "It may have been deleted."),
          h("a.btn", { href: "/recordings" }, icon("back"), "All recordings")));
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
        h("div.dtitle", h("a.back", { href: "/recordings" }, icon("back"), "All recordings"), titleInp, metaEl), actions));
      paintMeta();

      main.append(player());
      bodySlot = h("div");
      main.append(bodySlot);
      renderBody();
    }

    function paintMeta() {
      const r = D.row, res = D.result, parts = [];
      if (res || r.status === "done") parts.push(srcPill(r.source));
      parts.push(h("span", icon("calendar"), longDate(r.created_at)));
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
        return h("div.turn", { "data-s": t.start, vars: { "--c": colorOf[t.speaker] || NEUTRAL } },
          h("div.avatar", { "data-spk": t.speaker, vars: { "--c": colorOf[t.speaker] || NEUTRAL } }, avatarText(s.name, i)),
          h("div", h("div.tmeta", h("span.tname", { "data-spk": t.speaker }, s.name), h("button.ts", { "data-s": t.start }, clock(t.start))), text));
      });
      const segMode = res.granularity === "segment";
      const tcard = h("section.box.tcard", { cls: segMode ? "seg-mode" : "" },
        h("button.thead", { "aria-expanded": "true", on: { click: (e) => {
          const closed = tcard.classList.toggle("closed");
          e.currentTarget.setAttribute("aria-expanded", String(!closed));
        } } }, icon("chevron"), h("span.thead-t", "Transcript"),
          h("span.sub", `${plural(res.turns.length, "turn")} · ${plural(res.words, "word")}${segMode ? " · segment timings" : ""}`)),
        h("div.tbody", h("div", h("div.turns", turns))));
      tcard.addEventListener("click", (e) => {
        const w = e.target.closest(".w, .ts") || (segMode && e.target.closest(".turn"));   // live: a click anywhere in a turn
        if (!w || !ws || e.target.closest("input")) return;
        ws.setTime(+w.dataset.s + 0.01);
        follow = true; jumpBtn.classList.remove("on");
        ws.play();
      });

      const stat = (l, v, cls = "") => h("div.stat", { cls }, h("div.stat-l", l), h("div.stat-v", { cls: cls === "accent" ? "accent" : "", title: v }, v));
      const live = res.source === "live";
      const stats = h("div.stats",
        stat("Audio", clock(r.duration_s)),
        live ? stat("Mode", "Live") : stat("Processing", secs(r.processing_s)),
        live ? stat("Latency", res.latency_s != null ? `${res.latency_s.toFixed(1)} s` : "–", "accent")
          : stat("Speed", r.rtf ? `${+r.rtf.toFixed(1)}×` : "–", "accent"),
        stat("Words", String(res.words)),
        h("div.stat.wide", h("div.stat-l", "Speech recognition"), h("div.stat-v", { title: res.stt || "" }, res.stt || "–")),
        h("div.stat.wide", h("div.stat-l", "Diarization"), h("div.stat-v", { title: res.diar || "" }, (res.diar || "–").split("/").pop())));

      return h("div.dgrid", tcard,
        h("aside.aside",
          live ? upgradeBox() : null,
          h("section.box.spk-box", h("div.box-h", h("span", h("span.eyebrow-rule"), "Speakers"), h("span", `${res.speakers.length}`)), h("div.spk-list", spkRows), rerunControl()),
          h("section.box.stats-box", h("div.box-h", h("span", h("span.eyebrow-rule"), "Stats")), stats)));
    }

    // a LIVE recording: offer the batch pass (the same re-run path; afterwards it is a batch recording)
    function upgradeBox() {
      const r = D.row;
      const go = h("button.btn.primary", { title: "Transcribe this recording with Parakeet + pyannote: word-level timings, usually more accurate",
        on: { click: () => {
          go.disabled = true;
          rerunAt = Date.now();
          send("rerun", { id: r.id, num_speakers: r.num_speakers_hint || null });
          setTimeout(() => (go.disabled = false), 3000);
        } } }, icon("zap"), "Upgrade to accurate transcript");
      return h("section.box.up-box",
        h("div.box-h", h("span", h("span.eyebrow-rule"), "Transcript"), srcPill("live")),
        h("div.up-body",
          h("p", "Transcribed live while you spoke, by the Nemotron streaming models. Timings are per segment, not per word."),
          go,
          h("p.up-sub", "Parakeet + pyannote · word-level timings · replaces this transcript")));
    }

    // "wrong number of speakers?" -> transcribe the same audio again with a count (or Auto)
    function rerunControl() {
      const r = D.row;
      let pick = r.num_speakers_hint ? String(r.num_speakers_hint) : "";
      const seg = h("div.seg", { role: "radiogroup", "aria-label": "Number of speakers for the re-run" });
      const paint = () => seg.querySelectorAll("button").forEach((b) => {
        b.classList.toggle("on", b.dataset.v === pick);
        b.setAttribute("aria-checked", String(b.dataset.v === pick));
      });
      for (const [v, label] of [["", "Auto"], ["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]]) {
        seg.append(h("button", { "data-v": v, role: "radio", on: { click: () => { pick = v; paint(); } } }, label));
      }
      paint();
      const go = h("button.btn.btn-sm", { title: "Transcribe this recording again with this number of speakers", on: { click: () => {
        go.disabled = true;
        rerunAt = Date.now();
        send("rerun", { id: r.id, num_speakers: pick ? +pick : null });
        setTimeout(() => (go.disabled = false), 3000);   // normally the page has switched to progress by then
      } } }, icon("retry"), "Re-run");
      return h("div.rerun", h("span.field-label", "Re-run with"), h("div.rerun-row", seg, go));
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
      const upd = () => (elapsed.textContent = rerunAt
        ? `${clock((Date.now() - rerunAt) / 1000)} since re-run`
        : `${clock((Date.now() - new Date(r.created_at)) / 1000)} since upload`);
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
        setTimeout(() => (location.href = "/recordings"), 1500);   // normally WSW.gone() comes first
      }
    }

    function update(p) {
      if (!D || !D.row) return;
      if (p.result && !D.result) { const t = ws ? ws.getCurrentTime() : 0; rerunAt = 0; mount(p); if (t) ws.once?.("ready", () => ws.setTime(t)); return; }
      if (D.result && p.row.status && p.row.status !== "done") {   // re-run: back to the live progress view
        mount({ ...D, row: { ...D.row, ...p.row }, result: null });
        return;
      }
      const statusChanged = p.row.status !== D.row.status || p.row.note !== D.row.note;
      D.row = { ...D.row, ...p.row };
      titleInp.setValue(D.row.name);
      document.title = D.row.name;
      paintMeta();
      if (statusChanged && !D.result) renderBody();
    }

    function gone() { location.href = "/recordings"; }

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

  // ------------------------------------------------------------ /architecture
  const Architecture = (() => {
    // ---- the pipeline diagram (inline SVG, wide screens). Two lanes: RECORD / UPLOAD on top (gold),
    // LIVE underneath (teal); the Browser and the ui span both. Gold = audio in / job out,
    // teal = result + live event back, dashed gold = playback straight from MinIO,
    // dashed teal -> gold = upgrading a live recording into the RECORD path.
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    function node(x, y, w, hh, stamp, name, lines, { dot = "", cls = "", foot = "" } = {}) {
      // stamp pinned to the top; name + detail lines follow it (short boxes) or sit centred (tall ones)
      const bh = 26 + lines.length * 19, top = hh < 130 ? y + 34 : Math.max(y + 40, y + hh / 2 - bh / 2);
      return `<g class="n ${cls}"><rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="8"/>` +
        `<text class="n-stamp" x="${x + 16}" y="${y + 24}">${esc(stamp)}</text>` +
        (dot ? `<circle class="sdot ${dot}" cx="${x + w - 18}" cy="${y + 20}" r="4"/>` : "") +
        `<text class="n-name" x="${x + 16}" y="${top + 24}">${esc(name)}</text>` +
        lines.map((l, i) => `<text class="n-line" x="${x + 16}" y="${top + 46 + i * 19}">${esc(l)}</text>`).join("") +
        (foot ? `<text class="n-foot" x="${x + 16}" y="${y + hh - 16}">${esc(foot)}</text>` : "") + "</g>";
    }
    // horizontal arrow: label line(s) stack above the middle, smaller `sub` lines hang below it
    function arrow(x1, x2, y, label, kind, sub = []) {
      const mid = (x1 + x2) / 2, ls = [].concat(label);
      return `<g class="e ${kind}"><line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" marker-end="url(#ah-${kind})"/>` +
        ls.map((l, i) => `<text class="e-label" x="${mid}" y="${y - 9 - (ls.length - 1 - i) * 14}" text-anchor="middle">${esc(l)}</text>`).join("") +
        sub.map((l, i) => `<text class="e-sub" x="${mid}" y="${y + 17 + i * 13}" text-anchor="middle">${esc(l)}</text>`).join("") + "</g>";
    }
    // a mode lane: tinted band, accent bar, vertical name in the left gutter, stamp top right
    function band(y1, y2, kind, title, note) {
      return `<g class="band ${kind}"><rect class="band-bg" x="36" y="${y1}" width="1380" height="${y2 - y1}" rx="10"/>` +
        `<line class="band-bar" x1="37" y1="${y1 + 10}" x2="37" y2="${y2 - 10}"/>` +
        `<text class="band-v" transform="translate(20 ${(y1 + y2) / 2}) rotate(-90)" text-anchor="middle">${esc(title)}</text>` +
        `<text class="band-t" x="1400" y="${y1 + 24}" text-anchor="end">${esc(title)}</text>` +
        `<text class="band-n" x="1400" y="${y1 + 42}" text-anchor="end">${esc(note)}</text></g>`;
    }
    function diagram() {
      const B = [50, 190], U = [350, 490], I = [630, 820], W = [970, 1110], G = [1250, 1410];
      const R = [44, 462], L = [498, 876];          // the RECORD and LIVE lanes
      const rows = [110, 206, 302, 398];            // RECORD: MinIO, Postgres, pub/sub, stream
      const ic = (I[0] + I[1]) / 2, bc = (B[0] + B[1]) / 2;
      const svg = `<svg class="arch-svg" viewBox="0 0 1420 890" role="img" aria-label="Two modes. RECORD or upload lane: browser, ui, MinIO, Postgres, Redis stream, worker, GPU batch ASR on 9100. LIVE lane: the browser streams through the ui proxy to the GPU streaming ASR on 9101; on stop the ui saves the audio and the live result straight to MinIO and Postgres, no queue and no worker. A live recording can be upgraded: re-run puts it on the RECORD queue">
        <defs>
          <marker id="ah-gold" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" class="ah gold"/></marker>
          <marker id="ah-teal" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" class="ah teal"/></marker>
          <marker id="ah-play" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" class="ah gold"/></marker>
          <linearGradient id="up-grad" gradientUnits="userSpaceOnUse" x1="0" y1="512" x2="0" y2="440">
            <stop offset="0" class="stop-teal"/><stop offset="1" class="stop-gold"/></linearGradient>
        </defs>
        ${band(R[0], R[1], "record", "RECORD / UPLOAD mode", "batch · after you stop")}
        ${band(L[0], L[1], "live", "LIVE mode", "streaming · while you speak")}
        <g class="e play"><path d="M${ic} 70 V30 H${bc} V71" marker-end="url(#ah-play)"/>
          <text class="e-label" x="${(bc + ic) / 2}" y="21" text-anchor="middle">Playback, both modes · presigned GET (1 h) · streamed straight from MinIO</text></g>
        ${node(B[0], 74, B[1] - B[0], 786, "Client", "Browser", ["LIVE | RECORD", "mic recorder", "PCM worklet", "live transcript", "waveform", "player"], { foot: "both modes" })}
        ${node(U[0], 60, U[1] - U[0], 800, "Web · :8080", "ui", ["NiceGUI", "websocket push", "/ws/live proxy", "custom JS"], { dot: "live", foot: "both modes" })}

        ${node(I[0], 70, I[1] - I[0], 80, "Object store · :9000", "MinIO", [], { cls: "infra" })}
        ${node(I[0], 166, I[1] - I[0], 80, "Database", "Postgres", [], { cls: "infra" })}
        ${node(I[0], 262, I[1] - I[0], 80, "Redis pub/sub", "events", [], { cls: "infra" })}
        ${node(I[0], 358, I[1] - I[0], 80, "Redis stream", "asr-jobs", [], { cls: "infra" })}
        ${node(W[0], 70, W[1] - W[0], 368, "Worker", "worker", ["FastStream", "2 in flight", "retries on 503"])}
        ${node(G[0], 150, G[1] - G[0], 180, "GPU · :9100", "Batch ASR", ["Parakeet · words", "pyannote · speakers", "2× RTX 3090"], { dot: "gpu", cls: "gpu" })}
        ${arrow(B[1], U[0], 150, ["POST audio", "/api/recordings"], "gold", ["num_speakers", "Auto → none · 1–4"])}
        ${arrow(U[0], B[1], 250, "status push", "teal")}
        ${arrow(U[1], I[0], rows[0], "PUT audio", "gold")}
        ${arrow(U[1], I[0], rows[1], "INSERT · queued", "gold")}
        ${arrow(I[0], U[1], rows[2], "event", "teal")}
        ${arrow(U[1], I[0], rows[3], "XADD job", "gold")}
        ${arrow(W[0], I[1], rows[0], "result.json", "teal")}
        ${arrow(W[0], I[1], rows[1], "stats · done", "teal")}
        ${arrow(W[0], I[1], rows[2], "PUBLISH done", "teal")}
        ${arrow(I[1], W[0], rows[3], "XREADGROUP", "gold")}
        ${arrow(W[1], G[0], 216, "/v1/transcribe", "gold", ["num_speakers if set"])}
        ${arrow(G[0], W[1], 276, "words + who", "teal")}

        <g class="e up"><path d="M${ic} 512 V440" marker-end="url(#ah-gold)"/>
          <text class="up-label" x="${ic + 14}" y="477">Upgrade · re-run</text>
          <text class="e-sub" x="${ic + 14}" y="492">row → queued, source → batch · then worker → :9100 → word timings</text></g>

        ${node(I[0], 512, I[1] - I[0], 80, "Same table", "Postgres", [], { cls: "infra live" })}
        ${node(I[0], 608, I[1] - I[0], 80, "Same bucket", "MinIO", [], { cls: "infra live" })}
        <g class="ghost"><rect x="${W[0]}" y="528" width="${W[1] - W[0]}" height="144" rx="8"/>
          <text class="n-stamp" x="${W[0] + 16}" y="552">No job</text>
          <text class="n-line" x="${W[0] + 16}" y="590">no queue</text>
          <text class="n-line" x="${W[0] + 16}" y="611">no worker</text>
          <text class="n-line" x="${W[0] + 16}" y="632">saved as</text>
          <text class="n-line" x="${W[0] + 16}" y="653">it was heard</text></g>
        ${arrow(B[1], U[0], 600, ["② on stop · POST", "/api/recordings/live"], "gold", ["audio + final segments"])}
        ${arrow(U[1], I[0], 552, ["INSERT · done", "source = live"], "gold")}
        ${arrow(U[1], I[0], 648, ["PUT audio", "+ result.json"], "gold")}

        ${node(G[0], 716, G[1] - G[0], 144, "GPU · :9101", "Live ASR", ["Nemotron streaming", "ASR + diarization", "4 live sessions"], { dot: "gpulive", cls: "gpu" })}
        ${arrow(B[1], U[0], 764, "① PCM /ws/live", "gold", ["start: max_speakers", "Auto → 4 · 1–4"])}
        ${arrow(U[0], B[1], 836, "transcript", "teal")}
        ${arrow(U[1], G[0], 764, "/v1/stream · 16 kHz PCM · bearer token added server side", "gold", ["start message passed on · max_speakers clamped to 1–4"])}
        ${arrow(G[0], U[1], 836, "{from, segments} updates · words ~0.2 s after they are spoken", "teal")}
      </svg>`;
      const box = h("div.arch-diagram");
      box.innerHTML = svg;
      return box;
    }

    // ---- the same two lanes as a vertical list (narrow screens)
    function flow() {
      const n = (stamp, name, sub, dot) => h("div.fl-node", h("div.fl-stamp", stamp, dot ? h("span.sdot-h", { cls: dot }) : null), h("div.fl-name", name), sub ? h("div.fl-sub", sub) : null);
      const e = (kind, label, arr = "↓") => h("div.fl-edge", { cls: kind }, h("span.fl-arr", arr), h("span", label));
      const lane = (kind, title, note, ...kids) => h("div.fl-mode", { cls: kind },
        h("div.fl-mode-head", h("span.stamp.src", { cls: kind === "live" ? "live" : "batch" }, title), h("span.fl-mode-note", note)), ...kids);
      return h("div.arch-flow",
        h("div.fl-both", "Browser + ui serve both modes · playback: presigned GET straight from MinIO"),
        lane("record", "RECORD / UPLOAD mode", "batch · after you stop",
          n("Client", "Browser", "mic recorder · upload · waveform · player"),
          e("gold", "POST /api/recordings · num_speakers: Auto → none, 1–4"),
          n("Web · :8080", "ui", "NiceGUI + websocket push", "live"),
          e("gold", "PUT audio · INSERT row (queued) · XADD job"),
          h("div.fl-trio", n("Object store", "MinIO"), n("Database", "Postgres"), n("Redis stream", "asr-jobs")),
          e("gold", "XREADGROUP · 2 in flight"),
          n("Worker", "worker", "FastStream · retries on 503"),
          e("gold", "POST /v1/transcribe · num_speakers if set"),
          n("GPU · :9100", "Batch ASR", "Parakeet words + pyannote speakers · 2× RTX 3090", "gpu"),
          e("teal", "words + who spoke, back to the worker"),
          h("div.fl-trio", n("MinIO", "result.json"), n("Postgres", "stats · done"), n("Redis pub/sub", "PUBLISH")),
          e("teal", "event → ui → websocket"),
          n("Client", "Browser", "status updates on every open page")),
        lane("live", "LIVE mode", "streaming · while you speak",
          n("Client", "Browser", "the mic as 16 kHz PCM from an AudioWorklet"),
          e("gold", "① /ws/live · start: max_speakers (Auto → 4, 1–4)"),
          n("Web · :8080", "ui proxy", "adds the bearer token server side"),
          e("gold", "/v1/stream · 16 kHz PCM"),
          n("GPU box · :9101", "Live ASR", "Nemotron streaming ASR + diarization · 4 live sessions", "gpulive"),
          e("teal", "the transcript back over both WebSockets, words ~0.2 s after they are spoken"),
          n("Client", "Browser", "live transcript view"),
          e("gold", "② on stop: POST /api/recordings/live · audio + final segments"),
          n("Web · :8080", "ui", "no queue, no worker, no second pass"),
          e("gold", "PUT audio + result.json · INSERT row done, source = live"),
          h("div.fl-duo", n("Same bucket", "MinIO"), n("Same table", "Postgres"))),
        h("div.fl-upgrade", h("span.fl-arr", "↑"), h("span",
          h("b", "Upgrade · re-run"), " a live recording any time: row → queued, source → batch, XADD onto asr-jobs, then the RECORD path above: worker → :9100 → word timings.")));
    }

    // ---- LIVE vs RECORD, side by side
    const COMPARE = [
      ["Models", "Nemotron 3.5 ASR streaming 0.6B + Nemotron 3 Diarization", "Parakeet TDT 0.6B v3 + pyannote community-1"],
      ["When text appears", "While you speak: words ~0.2 s after they are spoken (p50; 0.55 s p95)", "Seconds after you stop: ~40× real time on the GPU"],
      ["Speaker labels", "Live, and may be revised as it hears more; up to 4 speakers", "Clustered over the whole recording; Auto or 1–4"],
      ["Speakers setting", "max_speakers in the start message: Auto → 4, or 1–4", "num_speakers on the POST: Auto → none (the model decides), or 1–4"],
      ["Timings", "Per segment", "Per word"],
      ["Path", "WebSocket /ws/live → ui proxy → :9101; saved on stop, no queue", "MinIO → Redis Stream → worker → :9100"],
      ["Accuracy", "Good", "Best"],
      ["If it fails", "Live unavailable → the recording is uploaded after stop and gets the batch transcript", "503 busy → retried up to 3×, waiting the service's Retry-After"],
      ["Upgrade", "→ batch any time (Upgrade / Re-run on the recording's page)", "— (already the accurate one; Re-run changes the speaker count)"],
    ];
    function compare() {
      const head = h("div.cmp-row.cmp-head", h("div.cmp-k"),
        h("div.cmp-v.live", h("span.stamp.src.live", "LIVE mode")),
        h("div.cmp-v.batch", h("span.stamp.src.batch", "RECORD / UPLOAD mode")));
      return h("div.cmp", head, COMPARE.map(([k, a, b]) => h("div.cmp-row",
        h("div.cmp-k", k),
        h("div.cmp-v.live", h("span.cmp-m", "LIVE"), a),
        h("div.cmp-v.batch", h("span.cmp-m", "RECORD"), b))));
    }

    // ---- how a recording moves: one column per mode
    const STEPS = {
      live: [
        ["Stream", "An AudioWorklet taps the mic at 16 kHz; the PCM goes over /ws/live to the ui, which adds the token and relays it to the streaming service on :9101 with max_speakers (Auto → 4). Speaker-coloured turns come back as the words are spoken and are revised in place.", ["/ws/live proxy", "Nemotron streaming", ":9101"]],
        ["Save on stop", "The browser POSTs the recording and the service's final segments in one request. The ui writes the audio and result.json to MinIO, then inserts the row already done (source live). No job, no worker, no second pass.", ["POST /api/recordings/live", "MinIO", "source = live"]],
        ["Upgrade, any time", "Upgrade (re-run) on the recording's page puts the row back to queued with source batch and adds a job: from there it takes the RECORD path and comes back with word timings.", ["store.rerun", "XADD", "source → batch"]],
      ],
      batch: [
        ["Queue", "The file is POSTed with num_speakers (Auto → none) and streamed into MinIO; the ui inserts a Postgres row with status queued and adds a job to the asr-jobs Redis stream. A worker claims it with a conditional UPDATE.", ["POST /api/recordings", "XADD", "Consumer group"]],
        ["Batch transcribe", "The worker sends the whole file to the GPU box on :9100. Parakeet writes the words with timestamps, pyannote works out who spoke when over the whole recording. A busy service (503) is retried.", ["Parakeet", "pyannote", ":9100"]],
        ["Save + live update", "result.json goes to MinIO and the numbers to Postgres, status done. A PUBLISH on Redis pub/sub reaches the ui, which pushes it to every open page; the player streams the audio from MinIO via a presigned URL.", ["MinIO", "Redis pub/sub", "presigned URL"]],
      ],
    };
    function steps() {
      const col = (kind, title, note, list) => h("div.steps-col", { cls: kind },
        h("div.steps-col-head", h("span.stamp.src", { cls: kind }, title), h("span.fl-mode-note", note)),
        h("ol.steps-list", list.map(([t, d, tags], i) => h("li.step-card",
          h("div.step-n", String(i + 1).padStart(2, "0")), h("div",
            h("h3.step-t", t), h("p.step-d", d), h("div.stack-tags", tags.map((x) => h("span.tag", x))))))));
      return h("div", h("p.steps-intro", "Pick LIVE or RECORD on the recorder (the choice is remembered in the browser). Uploads always take the RECORD path."),
        h("div.steps-cols",
          col("live", "LIVE mode", "the transcript while you speak", STEPS.live),
          col("batch", "RECORD / UPLOAD mode", "the accurate transcript after you stop", STEPS.batch)));
    }

    const SERVICES = [
      ["Frontend · ui", "Who said what", "The pages you are looking at. NiceGUI serves them and pushes every status change over its websocket; the recorder, the drop zone and the player are plain JavaScript.",
        ["NiceGUI", "Custom JS", "wavesurfer.js", "MediaRecorder", "AudioWorklet", "/ws/live proxy"]],
      ["Worker · FastStream", "Job runner", "Takes jobs off a Redis stream, sends the audio to the GPU service and writes the result back. Two jobs in flight; a busy service (503) is retried, an interrupted job is picked up again on restart.",
        ["FastStream", "Redis Streams", "Consumer group", "2 in flight", "Retries on 503"]],
      ["Storage", "MinIO + Postgres", "Audio and the raw service response live in MinIO; Postgres keeps one row per recording with its status and numbers. Status events travel over Redis pub/sub.",
        ["MinIO", "Postgres", "Presigned URLs", "Redis pub/sub"]],
      ["GPU · batch ASR · :9100", "Parakeet + pyannote", "Speech recognition with word timestamps, then speaker diarization, on the home lab box. Roughly forty times faster than real time. The accurate transcript for RECORD mode, uploads and upgraded live recordings.",
        ["Parakeet TDT 0.6B v3", "pyannote community-1", "2× RTX 3090", "~40× real time"]],
      ["GPU · live ASR · :9101", "Nemotron streaming", "LIVE mode: the transcript while you record, from streaming speech recognition coupled with streaming diarization, over a WebSocket, on the same box and token. Its final segments are what a live recording is saved with.",
        ["Nemotron 3.5 ASR streaming 0.6B", "Nemotron 3 Diarization", "Streaming ASR", "Streaming diarization", "4 live sessions", "~0.2 s word latency"]],
    ];

    function gpuStatus(el, pick, name) {
      const paint = (v) => {
        const x = pick(v) || { ok: null };
        el.className = "env-status " + (x.ok ? "ok" : x.ok === false ? "bad" : "");
        el.replaceChildren(h("span.dot"), x.ok ? `${name} · healthy` : x.ok === false ? `${name} down · ${x.text}` : "Checking…");
      };
      healthHooks.push(paint);
      if (lastHealth) paint(lastHealth);
      return el;
    }

    function mount(data) {
      const main = shell("architecture");
      document.title = "Architecture · Who said what";
      setCount(data.count || 0);
      healthHooks.push((v) => {
        const dots = (sel, x) => document.querySelectorAll(sel).forEach((d) => {
          d.classList.toggle("ok", !!(x && x.ok)); d.classList.toggle("bad", !!x && x.ok === false);
        });
        dots(".sdot.gpu, .sdot-h.gpu", v);
        dots(".sdot.gpulive, .sdot-h.gpulive", v.live);
      });

      const legend = h("div.legend",
        h("span", h("i.lg.gold"), "Audio in, job out"), h("span", h("i.lg.teal"), "Result + live event back"),
        h("span", h("i.lg.lg-play"), "Playback"), h("span", h("i.lg.lg-up"), "Upgrade · re-run"),
        h("span", h("i.lg-band.record"), "RECORD / upload lane"), h("span", h("i.lg-band.live"), "LIVE lane"),
        h("span", h("i.lg-dot"), "Live status"));

      const services = h("div.arch-grid", SERVICES.map(([stamp, name, desc, tags]) => h("div.arch-card",
        h("div.stamp", stamp), h("h3.arch-name", name), h("p.arch-desc", desc), h("div.stack-tags", tags.map((t) => h("span.tag", t))))));

      const cell = (tag, stamp, name, url, status, href) => h(tag, { cls: "env-cell", ...(href ? { href, target: "_blank", rel: "noopener" } : {}) },
        h("div.stamp", stamp), h("div.env-name", name, href ? h("span.arr", "↗") : null), h("div.env-url", url), status);
      const where = h("div.deploy-grid",
        cell("div", "Environment 01", "Local UI", "localhost:8080", h("div.env-status.ok", h("span.dot"), "Live · this page")),
        cell("div", "Environment 02", "GPU box", "Batch :9100 · live :9101, on the LAN",
          h("div.env-stack", gpuStatus(h("div.env-status"), (v) => v, "Batch"), gpuStatus(h("div.env-status"), (v) => v.live, "Live"))),
        cell("a", "Environment 03", "MinIO console", "localhost:9001", h("div.env-status.ok", h("span.dot"), "Object store · recordings bucket"), "http://localhost:9001"));

      main.append(
        h("section.page", pageHead("System", "Architecture",
          "Two ways from your microphone to a transcript: LIVE streams to one GPU service and is saved as it was heard; RECORD and uploads take the queue to the batch pass. And how every open page hears about it the moment it is done.")),
        h("section.arch-sec.first", h("div.panel.diagram-panel", h("div.stamp", "Pipeline"), diagram(), flow(), legend)),
        h("section.arch-sec", secHead("01 · Modes", "LIVE vs RECORD"), compare()),
        h("section.arch-sec", secHead("02 · Flow", "How a recording moves"), steps()),
        h("section.arch-sec", secHead("03 · Services", "What runs"), services),
        h("section.arch-sec", secHead("04 · Deployment", "Where it runs"), where,
          h("div.note", h("div.split-label", "Playback"),
            h("p", "The browser streams the audio straight from MinIO through a presigned URL that is valid for one hour, so audio never passes through the ui. wavesurfer.js decodes the whole file to draw the speaker-coloured waveform, which is fine at demo lengths."))));
    }
    return { mount };
  })();

  // ------------------------------------------------------------ boot
  let view = null;
  document.addEventListener("DOMContentLoaded", () => {
    const d = window.__WSW;
    if (!d) return;
    view = d.view;
    ({ home: Home, recordings: Recordings, architecture: Architecture, detail: Detail }[view] || Detail).mount(d);
    health(d.health);
    let carried = null;
    try { carried = sessionStorage.getItem("wsw.toast"); sessionStorage.removeItem("wsw.toast"); } catch { /* none */ }
    if (carried) toast(carried);
  });

  return {
    rows: (list) => (view === "home" ? Home : view === "recordings" ? Recordings : null)?.rows(list),
    count: setCount,
    detail: (p) => view === "detail" && Detail.update(p),
    gone: () => view === "detail" && Detail.gone(),
    health,
    toast,
    liveStats: () => (view === "home" ? Home.liveStats() : null),
  };
})();
