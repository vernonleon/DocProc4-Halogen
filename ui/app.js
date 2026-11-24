/* app.js — DocProc4 Halogen frontend */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* ================= State ================= */

const state = {
  pdfName: null,          // e.g. "report.pdf"
  pages: [],              // [{index, label, dpi}]
  batchMode: "fixed",     // 'fixed' | 'visual'
  fixedN: 3,
  visualBatches: [[]],    // array of arrays of page indices; last one is "open"
  conversionVersion: 0,   // invalidates an older PDF conversion when file/mode/budget changes
  renderTargetPx: null,   // pixels per full page used by the current render
  converting: false,
  server: "unknown",      // 'unknown' | 'online' | 'offline'
  serverInfo: null,       // latest response from Backend.halogenStatus()
  running: false,
  currentRun: null,
};

const SETTINGS_DEFAULTS = {
  theme: "cyberpunk",
  baseUrl: HalogenConfig.DEFAULT_URL,
  apiKey: "",
  model: HalogenConfig.DEFAULT_MODEL,
  conc: HalogenConfig.DEFAULT_CONCURRENCY,
  maxTokens: HalogenConfig.DEFAULT_MAX_TOKENS,
  thinkingEffort: "none",
  maxThinkingTokens: 0,
  cacheMode: "no_store",
  keepAwake: true,
  samplingPreset: "greedy",
  temp: 0,
  topp: "",
  topk: "",
  minp: "",
  presencePenalty: "",
  frequencyPenalty: "",
  repetitionPenalty: "",
  seed: "",
  batchZoom: 165,
  saveMode: "merged",
  efficientMode: false,
  execPresets: {},
  paramPresets: {},
  outputView: "rendered",
  collapsed: {},
  imageBudgetOverrides: {},
  imageBudgets: {},
  lastTargetPx: null,
};

const EXEC_PRESET_KEYS = ["conc", "maxTokens", "thinkingEffort", "maxThinkingTokens", "cacheMode", "keepAwake"];
const PARAM_PRESET_KEYS = [
  "samplingPreset", "temp", "topp", "topk", "minp",
  "presencePenalty", "frequencyPenalty", "repetitionPenalty", "seed",
];

const settings = { ...SETTINGS_DEFAULTS };
const instructionSets = {};

let pdfConversionQueue = Promise.resolve();
function convertPdfSerialized(file, targetPx) {
  const job = pdfConversionQueue.then(() => Backend.convertPdf(file, targetPx));
  pdfConversionQueue = job.catch(() => {});
  return job;
}

const saveSettings = () => { refreshDerivedUI(); return Backend.persistSettings(settings); };
const saveInstr = () => Backend.persistInstructions(instructionSets);

const BATCH_COLORS = [
  "#35c4d8", "#d8a848", "#e6457a", "#4ec96f", "#e07a3a",
  "#9a6ee8", "#4d8fe0", "#e04848", "#3ad8a8", "#d8d848",
];
const batchColor = (i) => BATCH_COLORS[i % BATCH_COLORS.length];

/* ================= Toasts ================= */

function toast(message, kind = "info", ms = kind === "error" ? 6500 : 3500) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  const icon = document.createElement("span");
  icon.className = "t-icon";
  icon.textContent = kind === "success" ? "✓" : kind === "error" ? "!" : "i";
  const text = document.createElement("span");
  text.textContent = message;
  el.append(icon, text);
  const close = () => {
    if (el.classList.contains("leaving")) return;
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 200);
  };
  el.addEventListener("click", close);
  setTimeout(close, ms);
  $("#toasts").appendChild(el);
  const all = $$("#toasts .toast");
  if (all.length > 4) all[0].remove();
}

/* ================= Tabs, steps & theme ================= */

function selectTab(id) {
  $$(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === id));
  $$(".tab-panel").forEach(p => p.classList.toggle("active", p.id === id));
  if (id === "tab3" || id === "tab4") pollSystemStats();
}

$$(".tab-btn").forEach(btn => btn.addEventListener("click", () => selectTab(btn.dataset.tab)));
document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-goto]");
  if (go) selectTab(go.dataset.goto);
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("#theme-select").value = theme;
  settings.theme = theme;
  saveSettings();
}
$("#theme-select").addEventListener("change", e => applyTheme(e.target.value));

const plural = (n, word, many = word + "s") => `${n} ${n === 1 ? word : many}`;
const currentModel = () => $("#model-id")?.value.trim() || settings.model || Backend._state.loadedModel || "";

function updateSteps() {
  const setStep = (n, status, sub) => {
    const btn = $(`.tab-btn[data-tab="tab${n}"]`);
    btn.classList.remove("done", "running", "warn");
    if (status) btn.classList.add(status);
    $(`#step${n}-sub`).textContent = sub;
    btn.title = sub;
  };
  const hasPdf = state.pages.length > 0;
  const hasInstr = $("#instruction-editor").value.trim().length > 0;
  if (state.converting) setStep(1, "running", "converting…");
  else if (!hasPdf) setStep(1, "", "no PDF yet");
  else setStep(1, hasInstr ? "done" : "", hasInstr ? `${state.pdfName} · ${state.pages.length} pp` : "add instructions");

  const batches = hasPdf ? getBatches() : [];
  const batchPages = batches.reduce((n, b) => n + b.length, 0);
  if (batches.length) setStep(2, "done", `${plural(batches.length, "batch", "batches")} · ${batchPages} pp`);
  else setStep(2, "", hasPdf ? "no batches yet" : "—");

  const model = currentModel();
  const visionOff = state.server === "online" && state.serverInfo?.vision_enabled === false;
  if (state.server === "offline") setStep(3, "warn", "server offline");
  else if (visionOff) setStep(3, "warn", "vision tower OFF");
  else if (state.server === "online") setStep(3, model ? "done" : "", model || "pick a model");
  else setStep(3, "", model ? `${model} · not checked` : "not checked");

  const run = state.currentRun;
  if (!run) setStep(4, "", "idle");
  else {
    const total = run.batches?.length ?? 0;
    const done = run.done.filter(Boolean).length;
    const failed = failedIndices(run).length;
    if (state.running) setStep(4, "running", `running · ${done}/${total}`);
    else if (failed) setStep(4, "warn", `${failed} failed · ${done}/${total} done`);
    else if (done) setStep(4, "done", `done · ${done}/${total}`);
    else setStep(4, "", "cancelled");
  }

  const checks = [
    [hasPdf, "PDF loaded", "tab1"],
    [hasInstr, "Instructions written", "tab1"],
    [batches.length > 0, "Batches defined", "tab2"],
    [!!model && !visionOff, visionOff ? "Enable HALOGEN_VISION_TOWER=1" : "Model configured", "tab3"],
  ];
  const list = $("#readiness");
  list.innerHTML = "";
  checks.forEach(([ok, label, tab]) => {
    const li = document.createElement("li");
    li.className = ok ? "ok" : "";
    li.append(label);
    if (!ok) {
      const go = document.createElement("button");
      go.className = "go"; go.dataset.goto = tab; go.textContent = "Go →";
      li.appendChild(go);
    }
    list.appendChild(li);
  });
}

function refreshDerivedUI() {
  updateCardSummaries();
  updateSteps();
  updateBudgetInfo();
  updateRenderNote();
}

/* ================= Tab 1: PDF & instructions ================= */

function showPdfCard() {
  const loaded = !!state.pdfName;
  $("#dropzone").hidden = loaded;
  $("#pdf-card").hidden = !loaded;
  $("#pdf-name").textContent = state.pdfName || "no file loaded";
}

function pickPdf() {
  $("#pdf-input").value = "";
  $("#pdf-input").click();
}
$("#dropzone").addEventListener("click", pickPdf);
$("#btn-open-pdf").addEventListener("click", pickPdf);

function setConverting(on) {
  state.converting = on;
  $("#pdf-spinner").hidden = !on;
  updateSteps();
}

async function convertCurrentPdf(reason = "load") {
  const conversion = ++state.conversionVersion;
  const file = state.pdfFile;
  const oldSession = state.pages[0]?.sessionId;
  const oldCount = state.pages.length;
  const targetPx = renderTargetPx();
  if (oldSession) Backend.clearPdf?.(oldSession);
  $("#page-count").textContent = `rendering at ${fmtMP(targetPx)} per page…`;
  setConverting(true);
  try {
    const pages = await convertPdfSerialized(file, targetPx);
    if (conversion !== state.conversionVersion) return false;
    state.pages = pages;
    state.renderTargetPx = targetPx;
  } catch (err) {
    if (conversion !== state.conversionVersion) return false;
    state.pages = [];
    state.renderTargetPx = null;
    $("#page-count").textContent = "conversion failed: " + err.message;
    setConverting(false);
    renderThumbs(); renderBatches();
    toast(`Couldn't convert ${file.name}: ${err.message}`, "error");
    return false;
  }
  if (reason === "load" || state.pages.length !== oldCount) state.visualBatches = [[]];
  $("#page-count").textContent = `${plural(state.pages.length, "page")} · ${fmtMP(targetPx)} each`;
  setConverting(false);
  renderThumbs(); renderBatches();
  updateSavePreview();
  refreshDerivedUI();
  const n = plural(state.pages.length, "page");
  toast(reason === "budget" ? `Re-rendered ${n} at ${fmtMP(targetPx)} for Halogen's image budget`
    : reason === "mode" ? `Re-rendered ${n} in ${settings.efficientMode ? "Efficient" : "Fast"} mode`
    : `Loaded ${file.name} · ${n}`, "success");
  return true;
}

function loadPdfFile(file) {
  if (state.running) { toast("Wait for the run to finish before loading another PDF.", "error"); return; }
  state.pdfFile = file;
  state.pdfName = file.name;
  showPdfCard();
  convertCurrentPdf("load");
}

$("#pdf-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) loadPdfFile(file);
});

function applyProcessingMode(efficient) {
  settings.efficientMode = efficient;
  Backend.configure({ efficient });
  $$(".mode-btn").forEach(b => {
    const on = (b.dataset.mode === "efficient") === efficient;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", String(on));
  });
  $("#mode-note").textContent = efficient
    ? "Efficient mode: only thumbnails are rendered now. Full-size pages render one at a time just before they're sent, then get deleted."
    : "Fast mode: all full-size pages are rendered now and kept in /tmp (often held in RAM) until you close the PDF.";
}
$$(".mode-btn").forEach(btn => btn.addEventListener("click", () => {
  const efficient = btn.dataset.mode === "efficient";
  if (efficient === settings.efficientMode) return;
  applyProcessingMode(efficient);
  saveSettings();
  if (state.pdfFile && !state.running) convertCurrentPdf("mode");
}));

function loadInstructionFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    $("#instruction-editor").value = reader.result;
    updateSteps();
    toast(`Instructions loaded from ${file.name}`, "success");
  };
  reader.onerror = () => toast(`Couldn't read ${file.name}`, "error");
  reader.readAsText(file);
}

$("#btn-open-md").addEventListener("click", () => { $("#md-input").value = ""; $("#md-input").click(); });
$("#md-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) loadInstructionFile(file);
});
$("#instruction-editor").addEventListener("input", () => updateSteps());

function refreshInstructionSelect() {
  const sel = $("#instruction-select");
  sel.innerHTML = '<option value="">— saved sets —</option>';
  Object.keys(instructionSets).sort().forEach(name => {
    const opt = document.createElement("option");
    opt.value = name; opt.textContent = name;
    sel.appendChild(opt);
  });
}

$("#instruction-select").addEventListener("change", (e) => {
  const name = e.target.value;
  if (name && instructionSets[name] != null) {
    $("#instruction-editor").value = instructionSets[name];
    updateSteps();
  }
});

$("#btn-save-instruction").addEventListener("click", () => {
  const name = prompt("Name for this instruction set:", $("#instruction-select").value);
  if (!name) return;
  instructionSets[name] = $("#instruction-editor").value;
  saveInstr(); refreshInstructionSelect();
  $("#instruction-select").value = name;
  toast(`Saved instruction set "${name}"`, "success");
});

$("#btn-delete-instruction").addEventListener("click", () => {
  const name = $("#instruction-select").value;
  if (!name) return;
  if (!confirm(`Delete instruction set "${name}"?`)) return;
  delete instructionSets[name];
  saveInstr(); refreshInstructionSelect();
  toast(`Deleted instruction set "${name}"`);
});

/* ---- drag & drop anywhere in the window ---- */
let dragDepth = 0;
const draggingFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $("#drop-overlay").hidden = false;
});
window.addEventListener("dragover", (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", (e) => {
  if (!draggingFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; $("#drop-overlay").hidden = true; }
});
window.addEventListener("drop", (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("#drop-overlay").hidden = true;
  handleDroppedFiles([...e.dataTransfer.files]);
});

function handleDroppedFiles(files) {
  const pdf = files.find(f => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
  const text = files.find(f => /\.(md|markdown|txt)$/i.test(f.name));
  if (!pdf && !text) { toast("Drop a PDF, or a .md or .txt file for instructions.", "error"); return; }
  if (pdf) loadPdfFile(pdf);
  if (text) loadInstructionFile(text);
  selectTab("tab1");
}

/* ================= Tab 2: batching ================= */

$$('input[name="batch-mode"]').forEach(r => r.addEventListener("change", (e) => {
  state.batchMode = e.target.value;
  $("#tab2").dataset.mode = state.batchMode;
  const visual = state.batchMode === "visual";
  $("#visual-hint").hidden = !visual;
  $("#btn-next-batch").hidden = !visual;
  $("#btn-clear-batches").hidden = !visual;
  decorateThumbs(); renderBatches();
}));

$("#fixed-n").addEventListener("change", (e) => {
  state.fixedN = clampInt(e.target.value, 1, 20, 3);
  e.target.value = state.fixedN;
  decorateThumbs(); renderBatches();
});

$("#btn-next-batch").addEventListener("click", () => {
  const open = state.visualBatches[state.visualBatches.length - 1];
  if (open.length === 0) return;
  state.visualBatches.push([]);
  decorateThumbs(); renderBatches();
});

$("#btn-clear-batches").addEventListener("click", () => {
  state.visualBatches = [[]];
  decorateThumbs(); renderBatches();
});

function applyBatchZoom(value) {
  const zoom = clampInt(value, 100, 320, 165);
  settings.batchZoom = zoom;
  $("#thumb-strip").style.setProperty("--batch-thumb-width", zoom + "px");
  $("#batch-zoom").value = zoom;
  $("#batch-zoom-value").textContent = zoom + " px";
}
$("#batch-zoom").addEventListener("input", e => applyBatchZoom(e.target.value));
$("#batch-zoom").addEventListener("change", () => saveSettings());

function getBatches() {
  if (state.batchMode === "fixed") {
    const out = [];
    for (let i = 0; i < state.pages.length; i += state.fixedN)
      out.push(state.pages.slice(i, i + state.fixedN).map(p => p.index));
    return out;
  }
  return state.visualBatches.filter(b => b.length > 0);
}

function drawPlaceholder(canvas, pageNum, scale = 1) {
  const w = 220, h = 285;
  canvas.width = w * scale; canvas.height = h * scale;
  const c = canvas.getContext("2d");
  c.scale(scale, scale);
  const cs = getComputedStyle(document.documentElement);
  c.fillStyle = cs.getPropertyValue("--bg-inset").trim() || "#111";
  c.fillRect(0, 0, w, h);
  c.strokeStyle = cs.getPropertyValue("--border").trim() || "#333";
  c.strokeRect(4, 4, w - 8, h - 8);
  c.fillStyle = cs.getPropertyValue("--muted").trim() || "#888";
  for (let y = 30; y < h - 40; y += 16) {
    const lineW = w - 40 - Math.random() * 60;
    c.fillRect(20, y, lineW, 5);
  }
  c.fillStyle = cs.getPropertyValue("--accent").trim() || "#0ff";
  c.font = "bold 28px monospace";
  c.textAlign = "center";
  c.fillText(String(pageNum), w / 2, h / 2 + 10);
}

let thumbObserver = null;
function observeThumb(img, p) {
  if (!thumbObserver) {
    thumbObserver = new IntersectionObserver((entries) => {
      entries.forEach(({ target, isIntersecting }) => {
        if (!isIntersecting) { target.removeAttribute("src"); return; }
        const page = target._page;
        Backend.thumbnail(page)
          .then(src => { if (target.isConnected && target._page === page) target.src = src; })
          .catch(() => {});
      });
    }, { root: $("#thumb-strip"), rootMargin: "400px 0px" });
  }
  img._page = p;
  img.addEventListener("load", () => { img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`; }, { once: true });
  thumbObserver.observe(img);
}

let dragSel = null;
let lastPick = null;

const assignedBatch = (index) => state.visualBatches.findIndex(b => b.includes(index));
function rangeIndices(a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return state.pages.map(p => p.index).filter(i => i >= lo && i <= hi);
}
function previewSelection() {
  const lo = dragSel ? Math.min(dragSel.anchor, dragSel.current) : -1;
  const hi = dragSel ? Math.max(dragSel.anchor, dragSel.current) : -2;
  $$("#thumb-strip .thumb").forEach(t => {
    const i = Number(t.dataset.index);
    const inRange = i >= lo && i <= hi;
    t.classList.toggle("sel-preview", inRange);
    t.classList.toggle("removing", inRange && !!dragSel?.remove);
  });
}
function applyRange(indices, remove) {
  if (remove) {
    state.visualBatches.forEach(b => indices.forEach(i => { const at = b.indexOf(i); if (at !== -1) b.splice(at, 1); }));
  } else {
    const open = state.visualBatches[state.visualBatches.length - 1];
    indices.forEach(i => { if (assignedBatch(i) === -1) open.push(i); });
  }
  const open = state.visualBatches[state.visualBatches.length - 1];
  state.visualBatches = [...state.visualBatches.slice(0, -1).filter(b => b.length), open];
  decorateThumbs(); renderBatches();
}
window.addEventListener("pointerup", () => {
  if (!dragSel) return;
  const { anchor, current, remove } = dragSel;
  dragSel = null;
  previewSelection();
  applyRange(rangeIndices(anchor, current), remove);
  lastPick = current;
});

function renderThumbs() {
  const strip = $("#thumb-strip");
  thumbObserver?.disconnect();
  strip.innerHTML = "";
  lastPick = null;

  state.pages.forEach(p => {
    const div = document.createElement("div");
    div.className = "thumb";
    div.dataset.index = p.index;
    if (p.sessionId && Backend.thumbnail) {
      const img = document.createElement("img");
      img.alt = p.label; img.loading = "lazy"; img.draggable = false;
      if (settings.efficientMode) {
        img.classList.add("lazy-thumb");
        observeThumb(img, p);
      } else {
        Backend.thumbnail(p).then(src => { if (div.isConnected) img.src = src; }).catch(() => {});
      }
      div.appendChild(img);
    } else if (p.thumb) {
      const img = document.createElement("img"); img.src = p.thumb; img.alt = p.label; img.loading = "lazy"; img.draggable = false;
      div.appendChild(img);
    } else {
      const cv = document.createElement("canvas");
      drawPlaceholder(cv, p.index + 1);
      div.appendChild(cv);
    }
    div.insertAdjacentHTML("beforeend", `<div class="tint"></div><div class="stripe"></div>
      <div class="pnum">p. ${p.index + 1}</div><div class="badge" hidden></div>`);
    const zb = document.createElement("button");
    zb.className = "zoom-btn";
    zb.title = "Zoom";
    zb.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.5"/><line x1="10.5" y1="10.5" x2="14" y2="14"/></svg>';
    zb.addEventListener("click", (e) => { e.stopPropagation(); openZoom(p); });
    div.appendChild(zb);
    div.addEventListener("dblclick", () => openZoom(p));
    div.addEventListener("pointerdown", (e) => {
      if (state.batchMode !== "visual" || e.button !== 0 || e.target.closest(".zoom-btn")) return;
      e.preventDefault();
      if (e.shiftKey && lastPick != null) {
        applyRange(rangeIndices(lastPick, p.index), false);
        lastPick = p.index;
        return;
      }
      dragSel = { anchor: p.index, current: p.index, remove: assignedBatch(p.index) !== -1 };
      previewSelection();
    });
    div.addEventListener("pointerenter", () => {
      if (!dragSel) return;
      dragSel.current = p.index;
      previewSelection();
    });
    strip.appendChild(div);
  });

  const any = state.pages.length > 0;
  strip.hidden = !any;
  $("#thumb-empty").hidden = any;
  $("#thumb-summary").textContent = any ? `· ${plural(state.pages.length, "page")}` : "";
  decorateThumbs();
}

function decorateThumbs() {
  const assignment = {};
  (state.batchMode === "visual" ? state.visualBatches : getBatches())
    .forEach((b, bi) => b.forEach(pi => { assignment[pi] = bi; }));
  $$("#thumb-strip .thumb").forEach(t => {
    const bi = assignment[Number(t.dataset.index)];
    const badge = t.querySelector(".badge");
    const on = bi != null;
    t.classList.toggle("assigned", on);
    badge.hidden = !on;
    if (on) {
      t.style.setProperty("--bc", batchColor(bi));
      badge.textContent = `B${bi + 1}`;
    } else {
      t.style.removeProperty("--bc");
    }
  });
}

async function openZoom(p) {
  const lb = $("#lightbox"); if (!lb) return;
  const img = $("#lightbox-img");
  lb.hidden = false;
  try {
    img.src = p.sessionId && Backend.preview ? await Backend.preview(p) : (p.full || "");
  } catch { img.removeAttribute("src"); }
}
function closeZoom() { const lb = $("#lightbox"); if (!lb) return; lb.hidden = true; $("#lightbox-img").removeAttribute("src"); }

$("#lightbox")?.addEventListener("click", closeZoom);
document.addEventListener("keydown", (e) => {
  const lb = $("#lightbox");
  if (e.key === "Escape" && lb) closeZoom();
});

function renderBatches() {
  const wrap = $("#batch-pills");
  wrap.innerHTML = "";
  const batches = getBatches();
  const visual = state.batchMode === "visual" && state.pages.length > 0;
  const open = state.visualBatches[state.visualBatches.length - 1];
  const addPill = (i, text, isOpen) => {
    const pill = document.createElement("span");
    pill.className = "bpill" + (isOpen ? " open" : "");
    pill.textContent = text;
    pill.style.color = batchColor(i);
    pill.style.borderColor = batchColor(i);
    wrap.appendChild(pill);
  };
  batches.forEach((b, i) => {
    const pages = b.map(x => x + 1);
    const range = pages.length > 1 ? `p.${pages[0]}–${pages[pages.length - 1]}` : `p.${pages[0]}`;
    const isOpen = visual && b === open;
    addPill(i, `Batch ${i + 1} · ${range}${isOpen ? " (open)" : ""}`, isOpen);
  });
  if (visual && !open.length) addPill(batches.length, `Batch ${batches.length + 1} (open) · click pages to add`, true);
  updateSavePreview();
  updateSteps();
}

/* ================= Image budget (Halogen vision cap + /v1/messages/count_tokens) ================= */

const fmtMP = (px) => `${(px / 1e6).toFixed(2)} MP`;
const letterDpi = (px) => Math.round(72 * Math.sqrt(px / (612 * 792)));
const serverKey = () => settings.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
const budgetKey = (model) => `${serverKey()} ${model}`;
const budgetFor = (model) => (model ? settings.imageBudgets[budgetKey(model)] ?? null : null);
const customBudgetPx = () => settings.imageBudgetOverrides[budgetKey(currentModel())] ?? null;

function renderTargetPx() {
  return (
    customBudgetPx()
    ?? budgetFor(currentModel())?.targetPx
    ?? state.serverInfo?.vision_max_pixels
    ?? settings.lastTargetPx
    ?? HalogenConfig.DEFAULT_BUDGET_PX
  );
}

function probeImage(side) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = side;
  const c = canvas.getContext("2d");
  c.fillStyle = "#fff";
  c.fillRect(0, 0, side, side);
  c.fillStyle = "#222";
  const line = Math.max(4, Math.round(side / 90));
  for (let y = line * 3; y < side - line * 3; y += line * 2.2)
    c.fillRect(line * 3, y, side - line * (6 + ((y / line) % 7) * 3), line);
  const url = canvas.toDataURL("image/png");
  canvas.width = canvas.height = 0;
  return url;
}

async function measureImageBudget(model) {
  const defaultPx = state.serverInfo?.vision_max_pixels ?? HalogenConfig.DEFAULT_BUDGET_PX;
  const probeSides = HalogenConfig.probeSidesForCap(defaultPx);
  const text = { type: "text", text: "Describe the image." };
  const count = (content) => Backend.promptTokens(model, content);
  const base = await count([text]);
  const imageTokens = async (side) =>
    (await count([text, { type: "image_url", image_url: { url: probeImage(side) } }])) - base;
  const [sa, sb, sc] = probeSides;
  const a = await imageTokens(sa);
  const b = await imageTokens(sb);
  let c = null, cError = "";
  try { c = await imageTokens(sc); } catch (err) { cError = err.message || String(err); }
  const near = (x, y, tol) => Math.abs(x - y) <= tol * Math.max(Math.abs(x), Math.abs(y));
  const measuredAt = new Date().toISOString();

  if (a > 0 && near(b / a, (sb * sb) / (sa * sa), 0.2)) {
    const pxPerToken = (sb * sb) / b;
    if (c == null)
      return {
        kind: "fallback", targetPx: defaultPx, pxPerToken, measuredAt,
        reason: `the oversized test image failed (${cError})`,
      };
    const capPx = c * pxPerToken;
    if (capPx < sc * sc * 0.95)
      return { kind: "measured", tokens: c, pxPerToken, targetPx: Math.round(capPx), measuredAt };
    return {
      kind: "uncapped", tokens: c, pxPerToken, targetPx: sc * sc, measuredAt,
      reason: `no image cap found up to ${fmtMP(sc * sc)}`,
    };
  }
  if (a > 0 && near(a, b, 0.03) && (c == null || near(a, c, 0.03)))
    return {
      kind: "fixed", tokens: a, targetPx: defaultPx, measuredAt,
      reason: "fixed-resolution model (same token count at every image size)",
    };
  return {
    kind: "fallback", targetPx: defaultPx, measuredAt,
    reason: `unexpected token counts (${a}, ${b}${c != null ? `, ${c}` : ""})`,
  };
}

let budgetJob = null;
function ensureImageBudget(model, force = false) {
  if (!model) return Promise.resolve(null);
  const key = budgetKey(model);
  if (!force && settings.imageBudgets[key]) return Promise.resolve(settings.imageBudgets[key]);
  if (budgetJob?.key === key) return budgetJob.promise;
  const promise = (async () => {
    $("#budget-info").textContent = `Measuring image budget for ${model} via /v1/messages/count_tokens…`;
    $("#btn-measure").disabled = true;
    try {
      const budget = await measureImageBudget(model);
      settings.imageBudgets = { ...settings.imageBudgets, [key]: budget };
      settings.lastTargetPx = budget.targetPx;
      saveSettings();
      if (budget.kind === "measured")
        toast(`Image budget for ${model}: ${budget.tokens} tokens · ${fmtMP(budget.targetPx)} per page`, "success");
      else
        toast(`Image budget for ${model}: using ${fmtMP(budget.targetPx)} — ${budget.reason}`);
      return budget;
    } catch (err) {
      toast(`Couldn't measure image budget for ${model}: ${err.message || err}`, "error");
      return null;
    } finally {
      budgetJob = null;
      $("#btn-measure").disabled = false;
      refreshDerivedUI();
    }
  })();
  budgetJob = { key, promise };
  return promise;
}

async function rerenderForBudget() {
  if (!state.pdfFile || !state.pages.length || state.renderTargetPx == null) return true;
  const target = renderTargetPx();
  if (Math.abs(target - state.renderTargetPx) / target < 0.02) return true;
  return convertCurrentPdf("budget");
}

function updateBudgetInfo() {
  const model = currentModel();
  const b = budgetFor(model);
  const el = $("#budget-info");
  const custom = customBudgetPx();
  const serverCap = state.serverInfo?.vision_max_pixels;
  $("#budget-mode").value = custom == null ? "auto" : "custom";
  $("#budget-mode").disabled = !model || state.running;
  $("#budget-mp").disabled = !model || state.running || custom == null;
  $("#budget-apply").disabled = !model || state.running;
  if (document.activeElement !== $("#budget-mp"))
    $("#budget-mp").value = Number((renderTargetPx() / 1e6).toFixed(4));
  if (custom != null) {
    el.textContent = `Selected budget: ${fmtMP(custom)} per page (≈${letterDpi(custom)} DPI on Letter). Halogen scales above HALOGEN_VISION_MAX_PIXELS down internally and refuses images above 4× that (14.75 MP default).`;
    return;
  }
  if (budgetJob) return;
  if (!model) el.textContent = "Image budget: enter or pick a model first.";
  else if (b?.kind === "measured")
    el.textContent = `Measured budget: ${b.tokens} tokens × ${Math.round(b.pxPerToken)} px ≈ ${fmtMP(b.targetPx)} per page (≈${letterDpi(b.targetPx)} DPI on Letter) · measured ${new Date(b.measuredAt).toLocaleDateString()}`;
  else if (b)
    el.textContent = `Image budget: using ${fmtMP(b.targetPx)} per page (≈${letterDpi(b.targetPx)} DPI on Letter) — ${b.reason}`;
  else if (serverCap)
    el.textContent = `Server vision cap: ${fmtMP(serverCap)} per page (≈${letterDpi(serverCap)} DPI on Letter, from /health). Click Re-measure to verify exact tokens/px.`;
  else
    el.textContent = `Halogen default budget: ${fmtMP(HalogenConfig.DEFAULT_BUDGET_PX)} per page (2560×1440, ≈${letterDpi(HalogenConfig.DEFAULT_BUDGET_PX)} DPI on Letter).`;
  el.title = model ? `Cached for ${budgetKey(model)}` : "";
}

function updateRenderNote() {
  const target = renderTargetPx();
  const b = budgetFor(currentModel());
  const source = customBudgetPx() != null
    ? `your custom budget for ${currentModel()}`
    : b ? `the measured budget for ${currentModel()}`
    : state.serverInfo?.vision_max_pixels ? "the server's vision cap (/health)"
    : settings.lastTargetPx ? "the last measured budget"
    : "Halogen's 2560×1440 default";
  let text = `Pages render at ${fmtMP(target)} (≈${letterDpi(target)} DPI on Letter), from ${source}.`;
  if (state.renderTargetPx != null && Math.abs(target - state.renderTargetPx) / target >= 0.02)
    text += ` This PDF was rendered at ${fmtMP(state.renderTargetPx)} and will be re-rendered when you Start.`;
  $("#render-note").textContent = text;
}

/* ================= Tab 3: Halogen status, execution & sampling ================= */

function renderCacheTelemetry(data) {
  const cache = data?.cache;
  const pool = cache?.pool;
  if (pool?.positions) {
    const pct = Math.round((pool.usage_ratio ?? ((pool.used || 0) / pool.positions)) * 100);
    const txt = `${(pool.used || 0).toLocaleString()} / ${pool.positions.toLocaleString()} (${pct}%)`;
    $("#hx-kvpool").textContent = txt;
    $("#d-kvpool").textContent = `${pct}% (${Math.round((pool.used || 0) / 1000)}k)`;
  } else {
    $("#hx-kvpool").textContent = data?.context ? `${Number(data.context).toLocaleString()} ctx` : "—";
    $("#d-kvpool").textContent = "—";
  }
  if (cache && cache.hit_rate != null) {
    $("#hx-cache").textContent = `${Math.round(cache.hit_rate * 100)}% req · ${Math.round((cache.token_hit_rate || 0) * 100)}% tok`;
  } else {
    $("#hx-cache").textContent = "—";
  }
  if (data) {
    const slots = data.slots ?? "?";
    const active = data.in_flight ?? 0;
    const queued = data.queued ?? 0;
    const wait = data.longest_wait_s > 0 ? ` (${Math.round(data.longest_wait_s)}s wait)` : "";
    $("#hx-queue").textContent = `${slots} slots · ${active} active · ${queued} queued${wait}`;
  }
}

function renderServerStatus(st) {
  $("#halogen-status-grid").hidden = false;
  const visionOn = st.vision_enabled !== false;
  const vPill = $("#vision-pill");
  vPill.textContent = visionOn ? "vision ready" : "vision OFF";
  vPill.className = "pill " + (visionOn ? "ok" : "err");

  const warn = $("#vision-warning");
  warn.hidden = visionOn;
  if (!visionOn) {
    warn.textContent = st.vision_reason || "Vision tower is not loaded on this halogen-flash-server. Start the container with -e HALOGEN_VISION_TOWER=1.";
  }

  const ver = st.version;
  $("#hx-ver").textContent = ver?.engine
    ? `${ver.engine}${ver.api && ver.api !== ver.engine ? " / API " + ver.api : ""}`
    : (st.provider || "connected");
  const capPx = st.vision_max_pixels;
  $("#hx-vision-cap").textContent = capPx
    ? `${fmtMP(capPx)} (max ${fmtMP(capPx * 4)})`
    : (visionOn ? "3.69 MP default" : "disabled");

  renderCacheTelemetry(st);
}

function syncModelControls(models, preferredId = null) {
  const sel = $("#model-select");
  sel.innerHTML = "";
  const ids = (models || []).map(m => (typeof m === "string" ? m : m.id)).filter(Boolean);
  if (!ids.length) {
    sel.innerHTML = '<option value="">— none reported —</option>';
  } else {
    ids.forEach(id => {
      const opt = document.createElement("option");
      opt.value = id; opt.textContent = id;
      sel.appendChild(opt);
    });
  }
  if (!$("#model-id").value.trim() && preferredId) {
    $("#model-id").value = preferredId;
    settings.model = preferredId;
    saveSettings();
  }
  const activeId = currentModel();
  if (activeId && ids.includes(activeId)) sel.value = activeId;
  else if (ids.length && !activeId) {
    sel.value = ids[0];
    $("#model-id").value = ids[0];
    settings.model = ids[0];
    saveSettings();
  }
}

async function checkHealth() {
  const pill = $("#health-pill");
  pill.textContent = "checking…"; pill.className = "pill unknown";
  try {
    let st;
    if (Backend.halogenStatus) {
      st = await Backend.halogenStatus();
    } else {
      const h = await Backend.health();
      const models = await Backend.listModels().catch(() => []);
      st = { ...h, models, model_id: h.model_loaded || models[0] || settings.model, vision_enabled: true };
    }
    const online = st.status === "ok" || st.status == null;
    pill.textContent = online ? "online" : st.status;
    pill.className = "pill " + (online ? "ok" : "err");
    state.server = online ? "online" : "offline";
    state.serverInfo = st;
    syncModelControls(st.models, st.model_id);
    renderServerStatus(st);
    refreshDerivedUI();
    return online;
  } catch {
    pill.textContent = "offline"; pill.className = "pill err";
    $("#vision-pill").textContent = "vision unknown"; $("#vision-pill").className = "pill unknown";
    $("#halogen-status-grid").hidden = true;
    $("#vision-warning").hidden = true;
    state.server = "offline";
    state.serverInfo = null;
    refreshDerivedUI();
    return false;
  }
}

$("#btn-health").addEventListener("click", async () => {
  const online = await checkHealth();
  if (!online) {
    toast(`Can't reach halogen-flash-server at ${settings.baseUrl}`, "error");
  } else if (state.serverInfo?.vision_enabled === false) {
    toast("Server is online, but the vision tower is OFF. Restart with -e HALOGEN_VISION_TOWER=1.", "error");
  } else {
    toast("halogen-flash-server is online and vision-ready", "success");
  }
});

$("#btn-fetch-models").addEventListener("click", async () => {
  const sel = $("#model-select");
  sel.innerHTML = '<option value="">loading…</option>';
  try {
    const models = await Backend.listModels();
    syncModelControls(models, models[0]);
    toast(`Found ${plural(models.length, "model")}`, "success");
  } catch (err) {
    sel.innerHTML = '<option value="">(fetch failed)</option>';
    toast(`Couldn't fetch models: ${err.message || err}`, "error");
  }
});

$("#model-select").addEventListener("change", (e) => {
  if (!e.target.value) return;
  $("#model-id").value = e.target.value;
  settings.model = e.target.value;
  saveSettings();
});
$("#model-id").addEventListener("change", (e) => {
  settings.model = e.target.value.trim();
  const sel = $("#model-select");
  if ([...sel.options].some(o => o.value === settings.model)) sel.value = settings.model;
  saveSettings();
});

$("#budget-mode").addEventListener("change", () => {
  $("#budget-mp").disabled = $("#budget-mode").value !== "custom";
});
$("#budget-apply").addEventListener("click", async () => {
  const model = currentModel();
  if (!model || state.running) return;
  const key = budgetKey(model);
  if ($("#budget-mode").value === "custom") {
    const mp = Number($("#budget-mp").value);
    if (!Number.isFinite(mp) || mp < 0.065536 || mp > 14.7456) {
      toast("Choose a budget between 0.066 and 14.75 megapixels per page (Halogen 4× limit).", "error");
      return;
    }
    settings.imageBudgetOverrides[key] = Math.round(mp * 1e6);
  } else {
    delete settings.imageBudgetOverrides[key];
  }
  await saveSettings();
  toast("Image budget saved. It will apply when you Start the next run.", "success");
});

$$(".budget-preset").forEach(btn => {
  btn.addEventListener("click", async () => {
    if (state.running) return;
    const pixels = Number(btn.dataset.pixels);
    const model = currentModel() || HalogenConfig.DEFAULT_MODEL;
    const key = budgetKey(model);
    settings.imageBudgetOverrides[key] = pixels;
    $("#budget-mode").value = "custom";
    $("#budget-mp").value = Number((pixels / 1e6).toFixed(4));
    await saveSettings();
    toast(`Image budget set to ${fmtMP(pixels)} for ${model}.`, "success");
  });
});

$("#btn-measure").addEventListener("click", async () => {
  const model = currentModel();
  if (!model) { toast("Pick or enter a model ID first.", "error"); return; }
  if (await ensureImageBudget(model, true) && !state.running) await rerenderForBudget();
});

/* ---- Execution & cache controls ---- */

function syncExecUI() {
  $("#hx-conc").value = settings.conc;
  $("#hx-max-tokens").value = settings.maxTokens;
  $("#hx-thinking").value = settings.thinkingEffort;
  $("#hx-max-thinking").value = settings.maxThinkingTokens;
  $("#hx-cache-mode").value = settings.cacheMode;
  $("#hx-keep-awake").checked = !!settings.keepAwake;

  const thinkOff = settings.thinkingEffort === "none";
  $("#hx-max-thinking").disabled = thinkOff;
  $("#hx-max-thinking-field").classList.toggle("is-disabled", thinkOff);
  $("#hx-max-thinking-field").hidden = thinkOff;

  const note = $("#hx-thinking-note");
  if (thinkOff) {
    note.textContent = "Sends reasoning_effort: none + enable_thinking: false (fastest and skips reasoning token spend).";
  } else if (!settings.thinkingEffort) {
    note.textContent = "Uses server default (HALOGEN_REASONING_EFFORT, usually xhigh). Answer room reserves max(1024, 15%) for output.";
  } else {
    note.textContent = `Sends reasoning_effort: "${settings.thinkingEffort}". Max completion tokens covers both thinking and Markdown output.`;
  }

  const help = $("#hx-cache-help");
  if (settings.cacheMode === "fork") {
    help.textContent = "Keeps a named KV prefix handle (X-Halogen-Keep) before launching workers, passes X-Halogen-From + no_store per batch, and deletes the handle on completion.";
  } else if (settings.cacheMode === "standard") {
    help.textContent = "Uses Halogen's default HALOGEN_PROMPT_CACHE=2 without no_store. Useful for single-batch checks or keeping finished pages in cache.";
  } else {
    help.textContent = "Warms the shared instructions once, then sends prompt_cache_policy: \"no_store\" on batches so finished pages never evict the prefix.";
  }
  updateCardSummaries();
}

function bindExecOptions() {
  $("#hx-conc").addEventListener("change", (e) => {
    settings.conc = clampInt(e.target.value, 1, HalogenConfig.MAX_CONCURRENCY, HalogenConfig.DEFAULT_CONCURRENCY);
    e.target.value = settings.conc;
    saveSettings(); syncExecUI();
  });
  $("#hx-max-tokens").addEventListener("change", (e) => {
    settings.maxTokens = clampInt(e.target.value, 64, HalogenConfig.MAX_TOKENS_CAP, HalogenConfig.DEFAULT_MAX_TOKENS);
    e.target.value = settings.maxTokens;
    saveSettings(); syncExecUI();
  });
  $("#hx-thinking").addEventListener("change", (e) => {
    settings.thinkingEffort = e.target.value;
    saveSettings(); syncExecUI();
  });
  $("#hx-max-thinking").addEventListener("change", (e) => {
    settings.maxThinkingTokens = clampInt(e.target.value, 0, HalogenConfig.MAX_TOKENS_CAP, 0);
    e.target.value = settings.maxThinkingTokens;
    saveSettings(); syncExecUI();
  });
  $("#hx-cache-mode").addEventListener("change", (e) => {
    settings.cacheMode = e.target.value;
    saveSettings(); syncExecUI();
  });
  $("#hx-keep-awake").addEventListener("change", (e) => {
    settings.keepAwake = e.target.checked;
    saveSettings(); syncExecUI();
  });
  syncExecUI();
}

/* ---- Sampling controls ---- */

const samplingBindings = [
  ["#p-temp", "temp", v => parseFloat(v)],
  ["#p-topp", "topp", v => (v.trim() === "" ? "" : parseFloat(v))],
  ["#p-topk", "topk", v => (v.trim() === "" ? "" : Math.max(0, parseInt(v, 10)))],
  ["#p-minp", "minp", v => (v.trim() === "" ? "" : parseFloat(v))],
  ["#p-presence-penalty", "presencePenalty", v => (v.trim() === "" ? "" : parseFloat(v))],
  ["#p-frequency-penalty", "frequencyPenalty", v => (v.trim() === "" ? "" : parseFloat(v))],
  ["#p-repetition-penalty", "repetitionPenalty", v => (v.trim() === "" ? "" : parseFloat(v))],
  ["#p-seed", "seed", v => (v.trim() === "" ? "" : Math.max(0, parseInt(v, 10)))],
];

function matchSamplingPreset() {
  const keys = ["temp", "topp", "topk", "minp", "presencePenalty", "frequencyPenalty", "repetitionPenalty", "seed"];
  for (const [name, p] of Object.entries(HalogenConfig.SAMPLING_PRESETS)) {
    if (name === "server-default") continue;
    const eq = keys.every(k => String(settings[k] ?? "") === String(p[k] ?? ""));
    if (eq) return name;
  }
  return "custom";
}

function syncParamsUI() {
  $("#p-preset").value = settings.samplingPreset || "greedy";
  samplingBindings.forEach(([sel, key]) => { $(sel).value = settings[key] ?? ""; });

  const serverDefault = settings.samplingPreset === "server-default";
  const greedy = !serverDefault && (HalogenConfig.optNum(settings.temp) ?? 0) === 0;
  $("#p-temp").disabled = serverDefault;
  $$("#sampling-extra input").forEach(el => { el.disabled = serverDefault || greedy; });

  const status = $("#sampling-status");
  if (serverDefault) {
    status.textContent = "Server defaults (HALOGEN_TEMPERATURE / HALOGEN_TOP_*) will be used — no sampling fields sent.";
  } else if (greedy) {
    status.textContent = "Greedy decoding (temp 0): filters, penalties, and seed omitted for byte-identical MTP + PLD.";
  } else {
    status.textContent = `Sampled decoding (temp ${settings.temp}): MTP + PLD remain active with repetition_penalty.`;
  }
  updateCardSummaries();
}

function bindParamInputs() {
  const serverBindings = [
    ["#base-url", "baseUrl", v => v.trim()],
    ["#api-key", "apiKey", String],
  ];
  serverBindings.forEach(([sel, key, parse]) => {
    const el = $(sel);
    el.value = settings[key] ?? "";
    el.addEventListener("change", () => {
      settings[key] = parse(el.value);
      el.value = settings[key];
      Backend.configure(settings);
      state.server = "unknown";
      state.serverInfo = null;
      saveSettings();
    });
  });

  $("#model-id").value = settings.model ?? HalogenConfig.DEFAULT_MODEL;

  $("#p-preset").addEventListener("change", (e) => {
    const name = e.target.value;
    settings.samplingPreset = name;
    const preset = HalogenConfig.SAMPLING_PRESETS[name];
    if (preset && name !== "server-default") Object.assign(settings, preset);
    saveSettings();
    syncParamsUI();
  });

  samplingBindings.forEach(([sel, key, parse]) => {
    const el = $(sel);
    el.addEventListener("change", () => {
      const v = parse(el.value);
      if (typeof v === "number" && Number.isNaN(v)) { el.value = settings[key] ?? ""; return; }
      settings[key] = v;
      settings.samplingPreset = matchSamplingPreset();
      saveSettings();
      syncParamsUI();
    });
  });
  syncParamsUI();
}

function updateCardSummaries() {
  const execParts = [
    `${settings.conc}× parallel`,
    `${settings.maxTokens} tok cap`,
    `thinking ${HalogenConfig.THINKING_LABELS[settings.thinkingEffort] ?? settings.thinkingEffort}`,
    HalogenConfig.CACHE_MODE_LABELS[settings.cacheMode] ?? settings.cacheMode,
  ];
  $("#exec-summary").textContent = execParts.join(" · ");

  if (settings.samplingPreset === "server-default") {
    $("#param-summary").textContent = "server defaults";
  } else if ((HalogenConfig.optNum(settings.temp) ?? 0) === 0) {
    $("#param-summary").textContent = "greedy (temp 0 · byte-identical MTP + PLD)";
  } else {
    const parts = [`temp ${settings.temp}`];
    if (settings.topp !== "") parts.push(`top-p ${settings.topp}`);
    if (settings.topk !== "") parts.push(`top-k ${settings.topk}`);
    if (settings.presencePenalty !== "") parts.push(`pres ${settings.presencePenalty}`);
    if (settings.repetitionPenalty !== "") parts.push(`rep ${settings.repetitionPenalty}`);
    if (settings.seed !== "") parts.push(`seed ${settings.seed}`);
    $("#param-summary").textContent = parts.join(" · ");
  }
}

function bindCards() {
  $$(".card").forEach(card => {
    const key = card.dataset.card;
    const apply = (collapsed) => {
      card.classList.toggle("collapsed", collapsed);
      card.querySelector(".collapse-btn").setAttribute("aria-expanded", String(!collapsed));
    };
    apply(!!settings.collapsed?.[key]);
    const toggle = () => {
      const collapsed = !card.classList.contains("collapsed");
      apply(collapsed);
      settings.collapsed = { ...settings.collapsed, [key]: collapsed };
      saveSettings();
    };
    card.querySelector(".collapse-btn").addEventListener("click", toggle);
    card.querySelector(".card-title").addEventListener("click", toggle);
    card.querySelector(".card-summary").addEventListener("click", toggle);
  });
}

function bindPresets({ select, save, del, store, keys, sync, label }) {
  const sel = $(select);
  function refresh(selected = "") {
    sel.innerHTML = '<option value="">— saved presets —</option>';
    Object.keys(settings[store]).sort().forEach(name => {
      const opt = document.createElement("option");
      opt.value = name; opt.textContent = name;
      sel.appendChild(opt);
    });
    sel.value = selected;
  }
  sel.addEventListener("change", () => {
    const preset = settings[store][sel.value];
    if (!preset) return;
    keys.forEach(k => { settings[k] = k in preset ? preset[k] : SETTINGS_DEFAULTS[k]; });
    saveSettings(); sync();
    toast(`Applied ${label} preset "${sel.value}"`);
  });
  $(save).addEventListener("click", () => {
    const name = prompt(`Name for this ${label} preset:`, sel.value);
    if (!name) return;
    settings[store] = { ...settings[store], [name]: Object.fromEntries(keys.map(k => [k, settings[k]])) };
    saveSettings(); refresh(name);
    toast(`Saved ${label} preset "${name}"`, "success");
  });
  $(del).addEventListener("click", () => {
    const name = sel.value;
    if (!name || !confirm(`Delete ${label} preset "${name}"?`)) return;
    const { [name]: _removed, ...rest } = settings[store];
    settings[store] = rest;
    saveSettings(); refresh();
    toast(`Deleted ${label} preset "${name}"`);
  });
  refresh();
}

/* ---- Local machine & live Halogen KV pool telemetry ---- */

const STAT_HISTORY = 40;
const statHistory = { ram: [], vram: [], gpu: [] };

async function pollSystemStats() {
  if (!$("#tab3").classList.contains("active") && !$("#tab4").classList.contains("active")) return;
  const el = $("#sys-stats");
  try {
    const s = await Backend.systemStats();
    const gb = v => v == null ? "n/a" : `${v.toFixed(1)} GiB`;
    const pct = v => v == null ? "n/a" : `${Math.round(v)}%`;
    const vram = s.vram_total_gb != null ? `${gb(s.vram_gb)}/${gb(s.vram_total_gb)}` : gb(s.vram_gb);
    const gtt = s.gtt_total_gb != null ? ` · Shared/GTT ${gb(s.gtt_gb)}/${gb(s.gtt_total_gb)}` : "";
    el.textContent = `CPU ${pct(s.cpu_percent)} · RAM ${gb(s.memory_gb)} · VRAM ${vram} · GPU ${pct(s.gpu_percent)}${gtt}`;
    el.title = "Local Linux telemetry. On AMD Strix Halo, Shared/GTT holds unified model weights and the KV pool.";

    const useGtt = s.gtt_gb != null && (s.vram_total_gb == null || s.vram_total_gb < 2);
    const gpuMem = useGtt ? s.gtt_gb : s.vram_gb;
    const gpuMemTotal = useGtt ? s.gtt_total_gb : s.vram_total_gb;
    const push = (key, v) => { if (v == null) return; statHistory[key].push(v); if (statHistory[key].length > STAT_HISTORY) statHistory[key].shift(); };
    push("ram", s.memory_gb); push("vram", gpuMem); push("gpu", s.gpu_percent);
    $("#d-ram").textContent = gb(s.memory_gb);
    $("#d-vram-label").textContent = useGtt ? "Shared GPU mem" : "VRAM";
    $("#d-vram").textContent = gpuMemTotal != null ? `${gb(gpuMem)} / ${gpuMemTotal.toFixed(0)}` : gb(gpuMem);
    $("#d-gpu").textContent = pct(s.gpu_percent);
    drawSpark("ram", null);
    drawSpark("vram", gpuMemTotal);
    drawSpark("gpu", 100);
  } catch {
    el.textContent = "local host stats unavailable";
  }

  if (state.server === "online" && Backend.halogenCache) {
    try {
      const live = await Backend.halogenCache();
      renderCacheTelemetry(live);
    } catch { /* keep last known cache readout during heavy cold prefill */ }
  }
}
setInterval(pollSystemStats, 3000);

function drawSpark(metric, max) {
  const svg = $(`.spark-tile[data-metric="${metric}"] .spark`);
  const data = statHistory[metric];
  if (!svg || data.length < 2) return;
  const top = max ?? (Math.max(...data) * 1.15 || 1);
  const step = 100 / (STAT_HISTORY - 1);
  const x0 = 100 - (data.length - 1) * step;
  const pts = data.map((v, i) => `${(x0 + i * step).toFixed(2)},${(24 - Math.min(v / top, 1) * 22).toFixed(2)}`);
  svg.querySelector(".spark-line").setAttribute("d", "M" + pts.join(" L"));
  svg.querySelector(".spark-area").setAttribute("d", `M${x0.toFixed(2)},24 L${pts.join(" L")} L100,24 Z`);
}

/* ================= Tab 4: run & outputs ================= */

function bindSaveMode() {
  $$('input[name="save-mode"]').forEach(r => {
    r.checked = r.value === settings.saveMode;
    r.addEventListener("change", e => { settings.saveMode = e.target.value; saveSettings(); updateSavePreview(); });
  });
  $$('input[name="output-view"]').forEach(r => {
    r.checked = r.value === settings.outputView;
    r.addEventListener("change", e => {
      settings.outputView = e.target.value;
      saveSettings();
      $$(".run-panel").forEach(p => paintOutput(p, p._raw ?? ""));
    });
  });
}

function pdfBase(name = state.pdfName) {
  return name ? name.replace(/\.pdf$/i, "") : "output";
}

function updateSavePreview() {
  const batches = getBatches();
  const el = $("#save-preview");
  if (!batches.length || !state.pdfName) { el.textContent = ""; return; }
  el.textContent = settings.saveMode === "merged"
    ? `→ ${pdfBase()}.md`
    : `→ ${pdfBase()}_1_of_${batches.length}.md … ${pdfBase()}_${batches.length}_of_${batches.length}.md`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

const COPY_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/></svg>';
const PAGES_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="2.5" width="5.5" height="11" rx="1"/><path d="M9.5 4h5M9.5 7h5M9.5 10h3.5"/></svg>';

function paintOutput(panel, text) {
  panel._raw = text;
  if (panel._paintPending) return;
  panel._paintPending = requestAnimationFrame(() => {
    panel._paintPending = 0;
    const out = panel.querySelector(".rp-output");
    const stick = out.scrollHeight - out.scrollTop - out.clientHeight < 24;
    const raw = settings.outputView === "raw";
    out.classList.toggle("raw", raw);
    out.classList.toggle("md", !raw);
    if (raw) out.textContent = panel._raw;
    else out.innerHTML = Markdown.render(panel._raw);
    if (stick) out.scrollTop = out.scrollHeight;
  });
}

function togglePanelPages(panel, batch) {
  const run = state.currentRun;
  if (run?.restored && !restoredPdfLoaded(run)) {
    toast(`Load ${run.pdfName} again in step 1 to see its pages.`, "error");
    return;
  }
  const on = !panel.classList.contains("with-pages");
  panel.classList.toggle("with-pages", on);
  panel.querySelector(".rp-pages-btn").classList.toggle("on", on);
  const box = panel.querySelector(".rp-pages");
  box.hidden = !on;
  box.innerHTML = "";
  if (!on) return;
  batch.map(pi => state.pages[pi]).filter(Boolean).forEach(p => {
    const fig = document.createElement("figure");
    const cap = document.createElement("figcaption");
    cap.textContent = `page ${p.index + 1}`;
    let el;
    if (p.sessionId && Backend.preview) {
      el = document.createElement("img");
      el.alt = p.label;
      Backend.preview(p)
        .then(src => { if (fig.isConnected) el.src = src; })
        .catch(() => { cap.textContent += " · image unavailable"; });
    } else {
      el = document.createElement("canvas");
      drawPlaceholder(el, p.index + 1);
    }
    el.addEventListener("click", () => openZoom(p));
    fig.append(el, cap);
    box.appendChild(fig);
  });
}

function buildRunPanel(i, batch) {
  const pages = batch.map(x => x + 1);
  const range = pages.length > 1 ? `pages ${pages[0]}–${pages[pages.length - 1]}` : `page ${pages[0]}`;
  const panel = document.createElement("div");
  panel.className = "run-panel";
  panel.style.setProperty("--bc", batchColor(i));
  panel.innerHTML = `
    <div class="rp-head">
      <span class="bname">Batch ${i + 1}</span>
      <span class="muted">${range}</span>
      <span class="rp-status">queued</span>
      <button class="btn icon rp-pages-btn" title="Show the pages next to the output">${PAGES_ICON}</button>
      <button class="btn icon rp-copy" title="Copy Markdown">${COPY_ICON}</button>
      <button class="btn danger rp-cancel">Cancel</button>
    </div>
    <div class="rp-thinking-live" hidden></div>
    <div class="rp-body"><div class="rp-pages" hidden></div><div class="rp-output"></div></div>
    <div class="rp-stats" hidden></div>`;
  panel._raw = "";
  panel.querySelector(".rp-pages-btn").addEventListener("click", () => togglePanelPages(panel, batch));
  panel.querySelector(".rp-copy").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    await copyText(panel._raw);
    btn.classList.add("ok");
    setTimeout(() => btn.classList.remove("ok"), 800);
    toast(`Copied batch ${i + 1} Markdown`, "success", 2000);
  });
  return panel;
}

const LOOP_CHECK_EVERY = 500;

async function prepareRunPrefix(run, count) {
  run.prefixWarmed = false;
  run.warmReply = "";
  if (run.activeHandle) {
    await Backend.halogenReleaseHandle?.(run.activeHandle).catch(() => {});
    run.activeHandle = null;
  }
  if (run.cacheMode === "fork") {
    const handle = "docproc4-" + crypto.randomUUID().slice(0, 8);
    $("#run-status").textContent = `keeping Halogen session handle (${handle})…`;
    const res = await Backend.halogenWarmPrefix(
      handle,
      HalogenConfig.warmPayload(run.model, run.instruction, "fork")
    );
    run.activeHandle = res?.handle || handle;
    run.warmReply = res?.reply || "";
    run.prefixWarmed = true;
  } else if (run.cacheMode === "no_store" && count > 1) {
    $("#run-status").textContent = "warming shared Halogen instruction prefix…";
    try {
      await Backend.halogenWarmPrefix(
        null,
        HalogenConfig.warmPayload(run.model, run.instruction, "no_store")
      );
      run.prefixWarmed = true;
    } catch (err) {
      if (HalogenConfig.serverUnavailable(err.message || err)) throw err;
      run.prefixWarmed = false;
    }
  }
}

async function releaseRunResources(run) {
  if (run?.activeHandle) {
    const h = run.activeHandle;
    run.activeHandle = null;
    await Backend.halogenReleaseHandle?.(h).catch(() => {});
  }
  await Backend.inhibitSuspend?.(false).catch(() => {});
}

async function runBatch(i, batch, instruction, run) {
  const panel = run.panels[i];
  panel.querySelector(".rp-thinking")?.remove();
  const statusEl = panel.querySelector(".rp-status");
  const thinkEl = panel.querySelector(".rp-thinking-live");
  const outEl = panel.querySelector(".rp-output");
  const statsEl = panel.querySelector(".rp-stats");
  thinkEl.textContent = ""; thinkEl.hidden = true;
  paintOutput(panel, "");
  statsEl.textContent = ""; statsEl.hidden = true;
  statusEl.className = "rp-status";
  run.outputs[i] = ""; run.done[i] = false; run.speeds[i] = undefined; run.prefill[i] = undefined; run.stats[i] = undefined;
  const ctrl = new AbortController();
  run.controllers[i] = ctrl;
  const cancelBtn = panel.querySelector(".rp-cancel");
  const freshBtn = cancelBtn.cloneNode(true);
  cancelBtn.replaceWith(freshBtn);
  freshBtn.disabled = false;
  freshBtn.addEventListener("click", () => ctrl.abort());

  statusEl.textContent = "running"; statusEl.classList.add("running");
  outEl.classList.add("streaming");
  updateDashboard();
  let outputStarted = false;
  let thinkingText = "";
  let paintTimer = null;
  const flushPaint = () => {
    clearTimeout(paintTimer); paintTimer = null;
    if (outputStarted) paintOutput(panel, run.outputs[i]);
    else if (thinkingText) {
      thinkEl.hidden = false; thinkEl.textContent = thinkingText;
      thinkEl.scrollTop = thinkEl.scrollHeight;
    }
  };
  const schedulePaint = () => {
    if (paintTimer == null) paintTimer = setTimeout(flushPaint, 75);
  };
  let checkedThinking = 0, checkedOutput = 0;
  const loopError = (where) => {
    ctrl.abort();
    return new Error(`the model started repeating itself in its ${where}, so the batch was stopped`);
  };
  const useNoStore = run.cacheMode === "fork"
    || (run.cacheMode === "no_store" && (run.prefixWarmed || run.batches.length === 1 || i > 0));
  const headers = run.activeHandle ? { "X-Halogen-From": run.activeHandle } : null;

  try {
    const stream = Backend.streamBatch({
      batch: batch.map(pi => state.pages[pi]),
      instruction,
      params: {
        model: run.model,
        settings: run.settingsSnapshot || settings,
        cacheMode: run.cacheMode,
        warmReply: run.warmReply,
        useNoStore,
      },
      headers,
      signal: ctrl.signal,
    });
    for await (const ev of stream) {
      if (ev.type === "progress" && ev.progress) {
        const pp = ev.progress;
        const total = Number(pp.total ?? 0);
        const processed = Number(pp.processed ?? 0);
        const cached = Number(pp.cache ?? 0);
        const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
        const cachedStr = cached > 0 ? ` (${cached.toLocaleString()} cached)` : "";
        statusEl.textContent = total > 0
          ? `prefill ${processed.toLocaleString()} / ${total.toLocaleString()} tok${cachedStr} · ${pct}%`
          : "prefilling…";
        statusEl.className = "rp-status prefill";
      } else if (ev.type === "thinking") {
        if (!outputStarted && statusEl.classList.contains("prefill")) {
          statusEl.textContent = "running";
          statusEl.className = "rp-status running";
        }
        thinkingText += ev.text;
        schedulePaint();
        if (thinkingText.length - checkedThinking >= LOOP_CHECK_EVERY) {
          checkedThinking = thinkingText.length;
          if (Repetition.detect(thinkingText)) throw loopError("thinking");
        }
      } else if (ev.type === "output") {
        if (!outputStarted) {
          outputStarted = true;
          thinkEl.textContent = "";
          thinkEl.hidden = true;
          statusEl.textContent = "running";
          statusEl.className = "rp-status running";
        }
        run.outputs[i] += ev.text;
        panel._raw = run.outputs[i];
        schedulePaint();
        if (run.outputs[i].length - checkedOutput >= LOOP_CHECK_EVERY) {
          checkedOutput = run.outputs[i].length;
          if (Repetition.detect(run.outputs[i])) throw loopError("output");
        }
      } else if (ev.type === "stats") {
        statsEl.hidden = false;
        statsEl.textContent = formatStats(ev.stats);
        run.stats[i] = ev.stats;
        const speed = Number(ev.stats.tokPerSec);
        if (ev.stats.tokPerSec != null && Number.isFinite(speed)) run.speeds[i] = speed;
        const prefill = Number(ev.stats.prefillPerSec);
        if (ev.stats.prefillPerSec != null && Number.isFinite(prefill)) run.prefill[i] = prefill;
      }
    }
    statusEl.textContent = "done"; statusEl.className = "rp-status done";
    run.done[i] = true;
    persistRecovery(run);
    if (thinkingText) {
      const det = document.createElement("details");
      det.className = "rp-thinking";
      const sum = document.createElement("summary");
      sum.textContent = "thinking";
      const body = document.createElement("div");
      body.className = "body";
      body.textContent = thinkingText;
      det.append(sum, body);
      panel.insertBefore(det, panel.querySelector(".rp-body"));
    }
  } catch (err) {
    if (err.name === "AbortError") {
      statusEl.textContent = "cancelled"; statusEl.className = "rp-status cancelled";
    } else {
      statusEl.textContent = "error: " + err.message; statusEl.className = "rp-status error";
      if (!run.cancelled && !run.serverFailed && HalogenConfig.serverUnavailable(err.message)) {
        run.serverFailed = true;
        run.cancelled = true;
        run.panels.forEach((p, idx) => {
          if (idx !== i && !run.controllers[idx] && !run.done[idx]) {
            const st = p.querySelector(".rp-status");
            st.textContent = "cancelled";
            st.className = "rp-status cancelled";
            p.querySelector(".rp-cancel").disabled = true;
          }
        });
        run.controllers.forEach((c, idx) => { if (idx !== i) c?.abort(); });
        toast("halogen-flash-server connection or state failed. Queue paused; check the server before retrying.", "error");
      }
    }
  } finally {
    flushPaint();
    if (run.done[i]) { thinkEl.hidden = true; thinkEl.textContent = ""; }
    outEl.classList.remove("streaming");
    panel.querySelector(".rp-cancel").disabled = true;
    updateDashboard();
    updateSteps();
    await maybeFinishRun(run);
  }
}

function failedIndices(run) {
  return run.panels.map((_, i) => i).filter(i => {
    const s = run.panels[i].querySelector(".rp-status");
    return s.classList.contains("error") || s.classList.contains("cancelled");
  });
}

async function maybeFinishRun(run) {
  if (!state.running) return;
  const settled = run.panels.every((_, i) => run.done[i] || run.controllers[i]?.signal.aborted
    || run.panels[i].querySelector(".rp-status").classList.contains("error")
    || run.panels[i].querySelector(".rp-status").classList.contains("cancelled"));
  if (!settled) return;
  state.running = false;
  run.finishedAt = Date.now();
  stopDashTimer();
  await releaseRunResources(run);
  const done = run.done.filter(Boolean).length;
  const failed = failedIndices(run).length;
  $("#btn-start").disabled = false;
  $("#btn-cancel-all").disabled = true;
  $("#btn-save").disabled = !done;
  $("#btn-rerun").disabled = !failed;
  $("#run-status").textContent = run.serverFailed
    ? "paused — halogen-flash-server unavailable"
    : done
      ? (failed ? "finished with failures — re-run available" : "finished")
      : "cancelled";
  updateDashboard();
  updateSteps();
  if (run.serverFailed) return;
  if (run.cancelled) toast(done ? `Run cancelled · ${plural(done, "batch", "batches")} finished` : "Run cancelled");
  else if (failed) toast(`Finished with ${plural(failed, "failed batch", "failed batches")}. Use Re-run failed to try ${failed === 1 ? "it" : "them"} again.`, "error");
  else toast(`Finished ${plural(done, "batch", "batches")} in ${fmtDuration(run.finishedAt - run.startedAt)}`, "success");
}

/* ---- unsaved-run recovery ---- */
let recoveryQueue = Promise.resolve();
function persistRecovery(run) {
  const snapshot = {
    version: 1,
    savedAt: Date.now(),
    pdfName: run.pdfName,
    pageCount: run.pageCount,
    model: run.model,
    instruction: run.instruction,
    maxTokens: run.maxTokens,
    thinkingEffort: run.thinkingEffort,
    maxThinkingTokens: run.maxThinkingTokens,
    cacheMode: run.cacheMode,
    settingsSnapshot: run.settingsSnapshot,
    batches: run.batches,
    outputs: run.batches.map((_, i) => (run.done[i] ? run.outputs[i] : null)),
    stats: run.batches.map((_, i) => (run.done[i] ? run.stats[i] ?? null : null)),
  };
  recoveryQueue = recoveryQueue
    .then(() => Backend.writeRecovery(snapshot))
    .catch(err => {
      console.warn("Couldn't write the recovery file:", err);
      if (!run.recoveryWarned) {
        run.recoveryWarned = true;
        toast(`Couldn't back up finished batches: ${err}. Save before closing.`, "error");
      }
    });
}
function discardRecovery() {
  $("#recovery-banner").hidden = true;
  recoveryQueue = recoveryQueue.then(() => Backend.clearRecovery());
}
function restoredPdfLoaded(run) {
  return state.pdfName === run.pdfName && state.pages.length === run.pageCount && !state.converting;
}

async function offerRecovery() {
  const rec = await Backend.readRecovery();
  if (!rec || !Array.isArray(rec.batches) || !Array.isArray(rec.outputs)) return;
  const done = rec.outputs.filter(o => typeof o === "string").length;
  if (!done) { discardRecovery(); return; }
  const when = new Date(rec.savedAt).toLocaleString();
  $("#recovery-text").textContent =
    `Unsaved run from ${rec.pdfName || "a PDF"}: ${done} of ${plural(rec.batches.length, "batch", "batches")} finished (${when}).`;
  $("#recovery-banner").hidden = false;
  $("#btn-recovery-restore").onclick = () => { $("#recovery-banner").hidden = true; restoreRun(rec); };
  $("#btn-recovery-discard").onclick = () => { discardRecovery(); toast("Discarded the unsaved run"); };
}

function restoreRun(rec) {
  if (state.running) { toast("Wait for the current run to finish before restoring.", "error"); return; }
  const container = $("#run-panels");
  container.innerHTML = "";
  container.hidden = false;
  $("#run-empty").hidden = true;
  const run = {
    panels: [], outputs: [], done: [], controllers: [], speeds: [], prefill: [], stats: [], cancelled: false,
    batches: rec.batches, instruction: rec.instruction, model: rec.model,
    maxTokens: rec.maxTokens ?? settings.maxTokens,
    thinkingEffort: rec.thinkingEffort ?? settings.thinkingEffort,
    maxThinkingTokens: rec.maxThinkingTokens ?? settings.maxThinkingTokens,
    cacheMode: rec.cacheMode ?? settings.cacheMode,
    settingsSnapshot: rec.settingsSnapshot ?? { ...settings },
    warmReply: "", activeHandle: null, prefixWarmed: false, serverFailed: false,
    pdfName: rec.pdfName, pageCount: rec.pageCount, restored: true,
  };
  rec.batches.forEach((b, i) => {
    const panel = buildRunPanel(i, b);
    const out = rec.outputs[i];
    const done = typeof out === "string";
    const status = panel.querySelector(".rp-status");
    status.textContent = done ? "restored" : "not run";
    status.className = "rp-status " + (done ? "done" : "cancelled");
    panel.querySelector(".rp-cancel").disabled = true;
    paintOutput(panel, done ? out : "");
    const stats = done && rec.stats?.[i];
    if (stats && typeof stats === "object") {
      run.stats[i] = stats;
      const el = panel.querySelector(".rp-stats");
      el.hidden = false; el.textContent = formatStats(stats);
      if (stats.tokPerSec != null && Number.isFinite(Number(stats.tokPerSec))) run.speeds[i] = Number(stats.tokPerSec);
      if (stats.prefillPerSec != null && Number.isFinite(Number(stats.prefillPerSec))) run.prefill[i] = Number(stats.prefillPerSec);
    }
    container.appendChild(panel);
    run.panels.push(panel); run.outputs.push(done ? out : ""); run.done.push(done); run.controllers.push(null);
  });
  state.currentRun = run;
  const missing = failedIndices(run).length;
  $("#btn-save").disabled = false;
  $("#btn-rerun").disabled = !missing;
  $("#run-status").textContent = missing
    ? `restored, not saved yet · load ${rec.pdfName} again to re-run the ${plural(missing, "unfinished batch", "unfinished batches")}`
    : "restored, not saved yet";
  selectTab("tab4");
  updateDashboard();
  updateSteps();
  toast(`Restored the run from ${rec.pdfName}`, "success");
}

async function runIndices(run, indices) {
  const queue = [...indices];
  const conc = run.settingsSnapshot?.conc ?? settings.conc;
  async function worker() {
    while (!run.cancelled && queue.length) {
      const i = queue.shift();
      await runBatch(i, run.batches[i], run.instruction, run);
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, indices.length) }, worker));
}

const formatStats = GenerationStats.format;

/* ---- dashboard ---- */

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

let dashTimer = null;
function startDashTimer() { stopDashTimer(); dashTimer = setInterval(updateDashboard, 1000); }
function stopDashTimer() { clearInterval(dashTimer); dashTimer = null; }

function updateDashboard() {
  const budgetLocked = !currentModel() || state.running;
  $("#budget-mode").disabled = budgetLocked;
  $("#budget-mp").disabled = budgetLocked || $("#budget-mode").value !== "custom";
  $("#budget-apply").disabled = budgetLocked;
  const run = state.currentRun;
  $("#dash").classList.toggle("running-run", state.running);
  const bar = $("#prog-bar"), fail = $("#prog-fail"), label = $("#prog-label");
  if (!run?.batches) {
    bar.style.width = "0"; fail.style.width = "0";
    label.textContent = "Not started";
    ["#d-batches", "#d-pages", "#d-prefill", "#d-speed", "#d-cache", "#d-mtp", "#d-elapsed", "#d-eta"].forEach(s => { $(s).textContent = "—"; });
    return;
  }
  const total = run.batches.length;
  const done = run.done.filter(Boolean).length;
  const failed = failedIndices(run).length;
  const totalPages = run.batches.reduce((n, b) => n + b.length, 0);
  const donePages = run.batches.reduce((n, b, i) => n + (run.done[i] ? b.length : 0), 0);
  const pct = total ? Math.round((done / total) * 100) : 0;
  bar.style.width = `${(done / total) * 100}%`;
  fail.style.left = `${(done / total) * 100}%`;
  fail.style.width = `${(failed / total) * 100}%`;
  $(".progress").setAttribute("aria-valuenow", String(pct));
  label.textContent = state.running
    ? (run.startedAt ? `${done} of ${total} batches · ${pct}%` : "preparing Halogen prefix…")
    : failed ? `${done} done · ${failed} failed` : `${done} of ${total} batches · ${pct}%`;

  $("#d-batches").textContent = `${done} / ${total}`;
  $("#d-pages").textContent = `${donePages} / ${totalPages}`;
  const avg = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? `${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)} tok/s` : "—"; };
  $("#d-prefill").textContent = avg(run.prefill);
  $("#d-speed").textContent = avg(run.speeds);

  let sumPrompt = 0, sumCached = 0, sumDraft = 0, sumAccepted = 0;
  for (const st of run.stats) {
    if (!st) continue;
    if (Number.isFinite(st.promptTokens) && st.promptTokens > 0) {
      sumPrompt += st.promptTokens;
      sumCached += Math.min(st.promptTokens, Math.max(0, st.cachedTokens || 0));
    }
    if (Number.isFinite(st.draftTokens) && st.draftTokens > 0 && Number.isFinite(st.draftAccepted)) {
      sumDraft += st.draftTokens;
      sumAccepted += st.draftAccepted;
    }
  }
  $("#d-cache").textContent = sumPrompt > 0 ? `${Math.round((100 * sumCached) / sumPrompt)}%` : "—";
  $("#d-mtp").textContent = sumDraft > 0 ? `${((100 * sumAccepted) / sumDraft).toFixed(1)}%` : "—";

  const now = run.finishedAt ?? Date.now();
  $("#d-elapsed").textContent = run.startedAt ? fmtDuration(now - run.startedAt) : "—";
  const doneThisLeg = done - (run.etaBase ?? 0);
  const remaining = total - done - failed;
  $("#d-eta").textContent = !state.running ? "—"
    : doneThisLeg > 0 && remaining > 0 ? fmtDuration(((Date.now() - run.etaStart) / doneThisLeg) * remaining)
    : remaining === 0 ? "finishing…" : "estimating…";
}

$("#btn-rerun").addEventListener("click", async () => {
  const run = state.currentRun;
  if (!run || state.running) return;
  const failed = failedIndices(run);
  if (!failed.length) return;
  if (run.restored && !restoredPdfLoaded(run)) {
    toast(`Load ${run.pdfName} (${plural(run.pageCount, "page")}) in step 1 first, then re-run.`, "error");
    return;
  }
  $("#run-status").textContent = "checking halogen-flash-server…";
  if (!(await checkHealth())) {
    $("#run-status").textContent = "server offline — aborting";
    toast(`Can't reach halogen-flash-server at ${settings.baseUrl}.`, "error");
    return;
  }
  if (state.serverInfo?.vision_enabled === false) {
    $("#run-status").textContent = "vision tower OFF — aborting";
    toast(state.serverInfo.vision_reason || "Vision tower is off. Start with -e HALOGEN_VISION_TOWER=1.", "error");
    return;
  }
  try {
    HalogenConfig.validateConfig(settings, state.serverInfo?.max_tokens_cap ?? HalogenConfig.MAX_TOKENS_CAP);
  } catch (err) {
    toast(err.message, "error");
    $("#run-status").textContent = "invalid settings";
    return;
  }

  run.settingsSnapshot = { ...settings };
  run.maxTokens = settings.maxTokens;
  run.thinkingEffort = settings.thinkingEffort;
  run.maxThinkingTokens = settings.maxThinkingTokens;
  run.cacheMode = settings.cacheMode;
  run.serverFailed = false;
  run.cancelled = false;
  run.finishedAt = undefined;
  state.running = true;
  $("#btn-start").disabled = true;
  $("#btn-rerun").disabled = true;
  $("#btn-cancel-all").disabled = false;
  $("#btn-save").disabled = true;
  updateSteps();

  try {
    if (settings.keepAwake) await Backend.inhibitSuspend?.(true).catch(() => {});
    await prepareRunPrefix(run, failed.length);
  } catch (err) {
    state.running = false;
    await releaseRunResources(run);
    $("#btn-start").disabled = false;
    $("#btn-rerun").disabled = false;
    $("#btn-cancel-all").disabled = true;
    $("#run-status").textContent = "prefix warm failed: " + (err.message || err);
    toast(`Couldn't prepare Halogen prefix: ${err.message || err}`, "error");
    updateSteps();
    return;
  }

  run.etaStart = Date.now();
  run.etaBase = run.done.filter(Boolean).length;
  $("#run-status").textContent = `re-running ${plural(failed.length, "batch", "batches")}…`;
  startDashTimer();
  updateDashboard();
  runIndices(run, failed);
});

async function startRun() {
  const batches = getBatches();
  const instruction = $("#instruction-editor").value.trim();
  if (!state.pdfName || !batches.length) { toast("Load a PDF and define batches first.", "error"); return; }
  if (!instruction) { toast("Write or load instructions in step 1 first.", "error"); return; }

  $("#run-status").textContent = "checking halogen-flash-server…";
  if (!(await checkHealth())) {
    $("#run-status").textContent = "server offline — aborting";
    toast(`Can't reach halogen-flash-server at ${settings.baseUrl}. Check step 3.`, "error");
    return;
  }
  if (state.serverInfo?.vision_enabled === false) {
    $("#run-status").textContent = "vision tower OFF — aborting";
    toast(
      state.serverInfo.vision_reason || "Vision tower is not loaded on this halogen-flash-server. Start with -e HALOGEN_VISION_TOWER=1.",
      "error"
    );
    return;
  }
  const model = currentModel();
  if (!model) { toast("Pick or enter a model ID in step 3 first.", "error"); $("#run-status").textContent = "idle"; return; }
  if (settings.model !== model) {
    settings.model = model;
    saveSettings();
  }
  try {
    HalogenConfig.validateConfig(settings, state.serverInfo?.max_tokens_cap ?? HalogenConfig.MAX_TOKENS_CAP);
  } catch (err) {
    toast(err.message, "error");
    $("#run-status").textContent = "invalid settings";
    return;
  }

  const container = $("#run-panels");
  container.innerHTML = "";
  container.hidden = false;
  $("#run-empty").hidden = true;
  const run = {
    panels: [], outputs: [], done: [], controllers: [], speeds: [], prefill: [], stats: [],
    cancelled: false, serverFailed: false,
    pdfName: state.pdfName, pageCount: state.pages.length,
    batches, instruction, model,
    maxTokens: settings.maxTokens,
    thinkingEffort: settings.thinkingEffort,
    maxThinkingTokens: settings.maxThinkingTokens,
    cacheMode: settings.cacheMode,
    settingsSnapshot: { ...settings },
    warmReply: "", activeHandle: null, prefixWarmed: false,
  };
  batches.forEach((b, i) => {
    const panel = buildRunPanel(i, b);
    container.appendChild(panel);
    run.panels.push(panel); run.outputs.push(""); run.done.push(false); run.controllers.push(null);
  });

  state.running = true;
  $("#btn-start").disabled = true;
  $("#btn-cancel-all").disabled = false;
  $("#btn-save").disabled = true;
  $("#btn-rerun").disabled = true;
  discardRecovery();
  state.currentRun = run;
  updateDashboard();
  updateSteps();

  if (state.renderTargetPx != null && Math.abs(renderTargetPx() - state.renderTargetPx) / renderTargetPx() >= 0.02) {
    $("#run-status").textContent = "re-rendering pages for Halogen image budget…";
    if (!(await rerenderForBudget())) {
      $("#run-status").textContent = "re-render failed — run stopped";
      state.running = false;
      $("#btn-start").disabled = false;
      $("#btn-cancel-all").disabled = true;
      run.panels.forEach(p => { const st = p.querySelector(".rp-status"); st.textContent = "cancelled"; st.className = "rp-status cancelled"; });
      updateDashboard(); updateSteps();
      return;
    }
    if (run.cancelled) return;
  }

  try {
    if (settings.keepAwake) await Backend.inhibitSuspend?.(true).catch(() => {});
    await prepareRunPrefix(run, batches.length);
  } catch (err) {
    state.running = false;
    await releaseRunResources(run);
    $("#run-status").textContent = "prefix warm failed: " + (err.message || err);
    toast(`Couldn't prepare Halogen prefix: ${err.message || err}`, "error");
    $("#btn-start").disabled = false;
    $("#btn-cancel-all").disabled = true;
    run.panels.forEach(p => { const st = p.querySelector(".rp-status"); st.textContent = "cancelled"; st.className = "rp-status cancelled"; p.querySelector(".rp-cancel").disabled = true; });
    updateDashboard(); updateSteps();
    return;
  }

  if (run.cancelled) {
    await releaseRunResources(run);
    return;
  }
  $("#run-status").textContent = `running ${plural(batches.length, "batch", "batches")}, ${settings.conc} at a time (${HalogenConfig.CACHE_MODE_LABELS[run.cacheMode]})`;
  run.startedAt = run.etaStart = Date.now();
  run.etaBase = 0;
  startDashTimer();
  updateDashboard();
  runIndices(run, batches.map((_, i) => i));
}

$("#btn-start").addEventListener("click", startRun);

$("#btn-cancel-all").addEventListener("click", async () => {
  const run = state.currentRun;
  if (!run || !state.running) return;
  run.cancelled = true;
  run.panels.forEach((panel, i) => {
    if (!run.controllers[i] && !run.done[i]) {
      const status = panel.querySelector(".rp-status");
      status.textContent = "cancelled";
      status.className = "rp-status cancelled";
      panel.querySelector(".rp-cancel").disabled = true;
    }
  });
  run.controllers.forEach(c => c?.abort());
  $("#run-status").textContent = "cancelling…";
  await maybeFinishRun(run);
});

$("#btn-save").addEventListener("click", async () => {
  const run = state.currentRun;
  if (!run) return;
  const base = pdfBase(run.pdfName);
  const n = run.outputs.length;
  const completed = run.outputs.map((t, i) => ({ t, i })).filter(x => run.done[x.i] && x.t.trim());
  if (!completed.length) { toast("No completed batches to save.", "error"); return; }
  const merged = settings.saveMode === "merged";
  const files = merged
    ? [{ name: `${base}.md`, content: completed.map(x => x.t).join("\n\n---\n\n") }]
    : completed.map(x => ({ name: `${base}_${x.i + 1}_of_${n}.md`, content: x.t }));
  try {
    const res = await Backend.saveOutputs(merged, files);
    if (res.saved.length) {
      $("#run-status").textContent = `saved: ${res.saved.join(", ")}`;
      discardRecovery();
      toast(res.saved.length === 1 ? `Saved ${res.saved[0]}` : `Saved ${res.saved.length} files`, "success");
    } else {
      $("#run-status").textContent = "save cancelled";
    }
  } catch (err) {
    $("#run-status").textContent = "save failed: " + err;
    toast(`Save failed: ${err}`, "error");
  }
});

window.addEventListener("beforeunload", () => {
  if (state.currentRun?.activeHandle) {
    Backend.halogenReleaseHandle?.(state.currentRun.activeHandle).catch(() => {});
  }
});

/* ================= Helpers & init ================= */

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? dflt : Math.min(hi, Math.max(lo, n));
}

(async function init() {
  try {
    const persisted = await Backend.loadPersisted();
    if (persisted.settings) Object.assign(settings, persisted.settings);
    if (persisted.instructions) Object.assign(instructionSets, persisted.instructions);
  } catch { /* first run */ }

  Backend.configure({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, efficient: settings.efficientMode });

  applyTheme(settings.theme);
  bindParamInputs();
  bindExecOptions();
  bindCards();
  bindPresets({
    select: "#exec-preset", save: "#btn-exec-preset-save", del: "#btn-exec-preset-delete",
    store: "execPresets", keys: EXEC_PRESET_KEYS, sync: syncExecUI, label: "execution",
  });
  bindPresets({
    select: "#param-preset", save: "#btn-param-preset-save", del: "#btn-param-preset-delete",
    store: "paramPresets", keys: PARAM_PRESET_KEYS, sync: syncParamsUI, label: "parameter",
  });
  bindSaveMode();
  applyProcessingMode(settings.efficientMode);
  $("#fixed-n").value = state.fixedN;
  applyBatchZoom(settings.batchZoom);
  $("#tab2").dataset.mode = state.batchMode;
  $("#run-panels").hidden = true;
  refreshInstructionSelect();
  showPdfCard();
  renderThumbs(); renderBatches();
  updateSavePreview();
  updateDashboard();
  refreshDerivedUI();

  const hash = location.hash.slice(1);
  if (["tab1", "tab2", "tab3", "tab4"].includes(hash)) selectTab(hash);
  const demo = new URLSearchParams(location.search).get("demo");
  if (demo) demoPopulate(demo);
  else offerRecovery().catch(err => console.warn("Couldn't read the recovery file:", err));
})();

function demoPopulate(kind) {
  state.pdfName = "demo.pdf";
  state.pages = Array.from({ length: 9 }, (_, i) => ({
    index: i, label: `demo.pdf · page ${i + 1}`,
  }));
  showPdfCard();
  $("#page-count").textContent = `${plural(state.pages.length, "page")} · ${fmtMP(renderTargetPx())} each`;
  if (kind === "visual") {
    document.querySelector('input[name="batch-mode"][value="visual"]').click();
    state.visualBatches = [[0, 1, 2], [3, 4], []];
  }
  renderThumbs(); renderBatches(); updateSavePreview();
  if (kind === "panels") demoPanels();
}

function demoPanels() {
  const c = $("#run-panels");
  c.innerHTML = "";
  c.hidden = false;
  $("#run-empty").hidden = true;
  const p1 = buildRunPanel(0, [0, 1, 2]);
  const s1 = p1.querySelector(".rp-status");
  s1.textContent = "prefill 2,688 / 7,456 tok (256 cached) · 36%"; s1.className = "rp-status prefill";
  p1.querySelector(".rp-output").classList.add("streaming");
  c.appendChild(p1);

  const p2 = buildRunPanel(1, [3, 4, 5]);
  const s2 = p2.querySelector(".rp-status");
  s2.textContent = "running"; s2.className = "rp-status running";
  p2.querySelector(".rp-output").classList.add("streaming");
  paintOutput(p2, "# Transcription — pages 4–6\n\n## Page 4\n\nLorem ipsum dolor sit amet, **consectetur** adipiscing elit.\n\n| Item | Qty | Price |\n|---|--:|--:|\n| Widget | 4 | $12.00 |");
  c.appendChild(p2);

  const p3 = buildRunPanel(2, [6, 7]);
  const s3 = p3.querySelector(".rp-status");
  s3.textContent = "done"; s3.className = "rp-status done";
  paintOutput(p3, "# Transcription — pages 7–8\n\n## Page 7\n\nDuis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore.");
  const st3 = p3.querySelector(".rp-stats");
  st3.hidden = false;
  st3.textContent = formatStats(GenerationStats.normalize(
    { prompt_n: 4800, cache_n: 256, prompt_ms: 2100, predicted_n: 132, predicted_per_second: 84.5, draft_n: 120, draft_n_accepted: 96 },
    "request",
    { prompt_tokens: 5056, completion_tokens: 132, prompt_tokens_details: { cached_tokens: 256 } },
    "used"
  ));
  p3.querySelector(".rp-cancel").disabled = true;
  c.appendChild(p3);
}
