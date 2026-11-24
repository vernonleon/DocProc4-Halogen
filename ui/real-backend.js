/* real-backend.js — Tauri-backed implementation of the Backend interface.
 * Talks to halogen-flash-server through Rust commands, persists settings,
 * opens native save dialogs, inhibits suspend, and renders PDFs locally.
 * Selected by backend.js only when running inside Tauri.
 */

const TauriBackend = (() => {
  const tauri = window.__TAURI__ || {};
  const invoke = tauri.core?.invoke;
  const listen = tauri.event?.listen;

  const cfg = { baseUrl: "http://localhost:8731", apiKey: "", efficient: false };
  function configure(c) {
    if (c.baseUrl != null) cfg.baseUrl = c.baseUrl;
    if (c.apiKey != null) cfg.apiKey = c.apiKey;
    if (c.efficient != null) cfg.efficient = !!c.efficient;
  }

  // ------------------------------------------------------------------
  // PDF → PNG via vendored pdf.js fallback
  // ------------------------------------------------------------------
  let pdfjs = null;
  async function ensurePdfjs() {
    if (!pdfjs) {
      pdfjs = await import("./vendor/pdf.min.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";
    }
    return pdfjs;
  }

  function renderPage(page, scale) {
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    return page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise.then(() => canvas);
  }
  function canvasPng(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob
      ? blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)), reject)
      : reject(new Error("PNG encoding failed")), "image/png"));
  }
  function releaseCanvas(canvas) { canvas.width = 0; canvas.height = 0; }
  const utf8Base64 = (text) => btoa(Array.from(new TextEncoder().encode(text), b => String.fromCharCode(b)).join(""));
  const storePng = (sessionId, index, kind, bytes) =>
    invoke("store_page_png", bytes, { headers: { "x-session": sessionId, "x-index": String(index), "x-kind": kind } });

  async function renderAndStore(page, sessionId, index, kind, scale) {
    const canvas = await renderPage(page, scale);
    try { await storePng(sessionId, index, kind, await canvasPng(canvas)); }
    finally { releaseCanvas(canvas); }
  }

  let pdfSource = null;

  function scaleForTarget(page, targetPx) {
    const vp = page.getViewport({ scale: 1 });
    const scale = Math.sqrt(targetPx / Math.max(vp.width * vp.height, 1));
    return Math.min(600 / 72, Math.max(30 / 72, scale));
  }

  async function convertPdf(file, targetPx) {
    const efficient = cfg.efficient;
    try {
      const native = await invoke("render_pdf_mupdf", new Uint8Array(await file.arrayBuffer()), {
        headers: { "x-file-name": utf8Base64(file.name), "x-target-px": String(Math.round(targetPx)), "x-efficient": efficient ? "1" : "0" },
      });
      if (Array.isArray(native?.pages) && native.pages.length) {
        pdfSource = null;
        return native.pages.map(page => ({ ...page, sessionId: page.session_id }));
      }
    } catch (err) { console.info("MuPDF couldn't render this PDF; using pdf.js:", err); }
    const lib = await ensurePdfjs();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const { session_id } = await invoke("begin_pdf_render", { fileName: file.name, targetPx: Math.round(targetPx), efficient });
    pdfSource = { sessionId: session_id, file, targetPx };
    const pages = [];
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const scale = scaleForTarget(page, targetPx);
        try {
          if (!efficient) await renderAndStore(page, session_id, i - 1, "full", scale);
          await renderAndStore(page, session_id, i - 1, "thumb", 220 / page.getViewport({ scale: 1 }).width);
        } finally { page.cleanup?.(); }
        pages.push({ index: i - 1, label: `${file.name} · page ${i}`, dpi: Math.round(scale * 72), sessionId: session_id });
      }
      return pages;
    } catch (err) { await invoke("clear_pdf_render", { sessionId: session_id }).catch(() => {}); throw err; }
    finally { await doc.destroy(); }
  }

  let renderQueue = Promise.resolve();
  function ensureFullPages(pages) {
    const job = renderQueue.then(async () => {
      if (!pages.length) return;
      const sessionId = pages[0].sessionId;
      const missing = await invoke("ensure_full_pages", { sessionId, indices: pages.map(p => p.index) });
      if (!missing.length) return;
      if (pdfSource?.sessionId !== sessionId) throw new Error("PDF source is no longer available — reload the PDF");
      const lib = await ensurePdfjs();
      const doc = await lib.getDocument({ data: new Uint8Array(await pdfSource.file.arrayBuffer()) }).promise;
      try {
        for (const index of missing) {
          const page = await doc.getPage(index + 1);
          try { await renderAndStore(page, sessionId, index, "full", scaleForTarget(page, pdfSource.targetPx)); }
          finally { page.cleanup?.(); }
        }
      } finally { await doc.destroy(); }
    });
    renderQueue = job.catch(() => {});
    return job;
  }

  const thumbnail = (page) => invoke("page_thumbnail", { sessionId: page.sessionId, index: page.index });
  async function preview(page) {
    for (let attempt = 0; ; attempt++) {
      await ensureFullPages([page]);
      try { return await invoke("page_preview", { sessionId: page.sessionId, index: page.index }); }
      catch (err) { if (attempt > 0) throw err; }
    }
  }
  const clearPdf = (sessionId) => invoke("clear_pdf_render", { sessionId: sessionId ?? null }).catch(() => {});

  // ------------------------------------------------------------------
  // Halogen & OpenAI-compatible server endpoints (via Rust commands)
  // ------------------------------------------------------------------
  const call = (cmd, args) => invoke(cmd, { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, ...args });

  const _state = { loadedModel: null };

  async function halogenStatus() {
    const st = await call("halogen_status", {});
    _state.loadedModel = st.model_id ?? _state.loadedModel ?? null;
    return st;
  }

  const halogenCache = () => call("halogen_cache", {});
  const halogenWarmPrefix = (handleName, payload) =>
    call("halogen_warm_prefix", { handleName: handleName ?? null, payload });
  const halogenReleaseHandle = (handleName) =>
    call("halogen_release_handle", { handleName });
  const halogenListHandles = () => call("halogen_list_handles", {});
  const inhibitSuspend = (active) => invoke("inhibit_suspend", { active: !!active });

  async function health() {
    const h = await call("health", {});
    _state.loadedModel = h.model_loaded ?? _state.loadedModel ?? null;
    return h;
  }

  async function listModels() {
    const rows = await call("list_models", {});
    return rows.map(r => (typeof r === "string" ? r : r.id)).filter(Boolean);
  }

  // Exact prompt token count via /v1/messages/count_tokens (no_store so probe never pollutes cache).
  const promptTokens = (model, content) => call("measure_prompt_tokens", {
    payload: {
      model,
      stream: false,
      max_completion_tokens: 1,
      temperature: 0,
      reasoning_effort: "none",
      chat_template_kwargs: { enable_thinking: false },
      prompt_cache_policy: "no_store",
      messages: [{ role: "user", content }],
    },
  });

  const systemStats = () => invoke("system_stats");

  // ------------------------------------------------------------------
  // Streaming chat — Rust emits "chat-stream" events per token/progress/stats
  // ------------------------------------------------------------------
  async function* streamBatch({ batch, instruction, params = {}, headers = null, signal }) {
    await ensureFullPages(batch);
    if (signal.aborted) throw new DOMException("cancelled", "AbortError");
    const id = crypto.randomUUID();
    const queue = [];
    let notify = null;
    const push = (ev) => { queue.push(ev); if (notify) { notify(); notify = null; } };

    const unlisten = await listen("chat-stream", (e) => {
      const p = e.payload;
      if (!p || p.id !== id) return;
      if (p.kind === "progress" && p.progress) {
        push({ type: "progress", progress: p.progress });
      } else if (p.kind === "thinking" || p.kind === "output") {
        push({ type: p.kind, text: p.text });
      } else if (p.kind === "stats") {
        push({
          type: "stats",
          stats: GenerationStats.normalize(
            p.stats || {},
            p.source || "request",
            p.usage || null,
            p.halogen_from || null
          ),
        });
      } else if (p.kind === "done") {
        push({ type: "end" });
      } else if (p.kind === "error") {
        push({ type: "error", message: p.message || "unknown error" });
      }
    });

    const payload = params.payload
      ? { ...params.payload, session_id: batch[0]?.sessionId ?? params.payload.session_id }
      : HalogenConfig.buildChatPayload({
          model: params.model,
          instruction,
          settings: params.settings || params,
          cacheMode: params.cacheMode || "no_store",
          warmReply: params.warmReply || "",
          sessionId: batch[0]?.sessionId ?? null,
          useNoStore: !!params.useNoStore,
        });

    const onAbort = () => {
      invoke("chat_cancel", { id }).catch(() => {});
      push({ type: "aborted" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let completed = false;

    try {
      if (signal.aborted) throw new DOMException("cancelled", "AbortError");
      await call("chat_stream", {
        id,
        payload,
        pageIndices: batch.map(p => p.index),
        headers: headers || null,
      });
      for (;;) {
        while (queue.length === 0) await new Promise(r => (notify = r));
        const ev = queue.shift();
        if (ev.type === "end") { completed = true; return; }
        if (ev.type === "aborted") throw new DOMException("cancelled", "AbortError");
        if (ev.type === "error") throw new Error(ev.message);
        yield ev;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (!completed) await invoke("chat_cancel", { id }).catch(() => {});
      unlisten();
    }
  }

  // ------------------------------------------------------------------
  // Persistence + saving (Rust: app-data dir, native dialogs)
  // ------------------------------------------------------------------
  async function loadPersisted() {
    const p = await invoke("read_persisted");
    return {
      settings: p.settings && typeof p.settings === "object" ? p.settings : null,
      instructions: p.instructions && typeof p.instructions === "object" ? p.instructions : null,
    };
  }
  const persistSettings = (s) => invoke("write_settings", { data: s }).catch(() => {});
  const persistInstructions = (i) => invoke("write_instructions", { data: i }).catch(() => {});
  const saveOutputs = (merged, files) => invoke("save_outputs", { merged, files });
  const readRecovery = () => invoke("read_recovery").catch(() => null);
  const writeRecovery = (data) => invoke("write_recovery", { data });
  const clearRecovery = () => invoke("clear_recovery").catch(() => {});

  return {
    convertPdf, thumbnail, preview, clearPdf,
    health, listModels, systemStats,
    halogenStatus, halogenCache, halogenWarmPrefix, halogenReleaseHandle, halogenListHandles,
    inhibitSuspend,
    streamBatch, promptTokens,
    loadPersisted, persistSettings, persistInstructions, saveOutputs,
    readRecovery, writeRecovery, clearRecovery, configure, _state,
  };
})();
