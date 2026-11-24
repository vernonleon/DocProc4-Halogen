/* stub.js — mock backend used when running in a plain browser (no Tauri).
 * Simulates halogen-flash-server (/health, /v1/models, /cache, X-Halogen-Keep/From,
 * prompt_progress, MTP telemetry, and vision pixel limits) for browser UI testing.
 */

const StubBackend = (() => {
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  const state = {
    loadedModel: "halogen-qwen3.8-flash-next",
    visionEnabled: true,
    visionMaxPixels: 3686400,
    models: [
      {
        id: "halogen-qwen3.8-flash-next",
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      },
    ],
    handles: new Set(),
    poolUsed: 32768,
    poolPositions: 524288,
    reqHits: 0,
    reqTotal: 0,
    tokCached: 0,
    tokTotal: 0,
  };

  async function convertPdf(file, targetPx) {
    await delay(250);
    const name = typeof file === "string" ? file : file.name;
    const count = 6 + [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 7;
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      label: `${name} · page ${i + 1}`,
      dpi: Math.round(72 * Math.sqrt(targetPx / (612 * 792))),
      full: null,
      thumb: null,
    }));
  }

  async function halogenStatus() {
    await delay(120);
    const modelIds = state.models.map(m => ({
      ...m,
      architecture: {
        input_modalities: state.visionEnabled ? ["text", "image"] : ["text"],
        output_modalities: ["text"],
      },
    }));
    const modelId = state.loadedModel || modelIds[0]?.id || "halogen-qwen3.8-flash-next";
    return {
      status: "ok",
      version: { api: "0.20.7", engine: "0.20.7" },
      model_id: modelId,
      models: modelIds,
      vision_enabled: state.visionEnabled,
      vision_reason: state.visionEnabled
        ? ""
        : "Vision tower is not loaded on this halogen-flash-server. Start the container with -e HALOGEN_VISION_TOWER=1.",
      vision_max_pixels: state.visionMaxPixels,
      vision: { enabled: state.visionEnabled, max_pixels: state.visionMaxPixels },
      context: 262144,
      slots: 4,
      max_tokens_default: 8192,
      max_tokens_cap: 65536,
      reasoning_effort_default: "xhigh",
      thinking_answer_room: 1024,
      busy: false,
      in_flight: 0,
      queued: 0,
      longest_wait_s: 0,
      cache: {
        hit_rate: state.reqTotal ? state.reqHits / state.reqTotal : 0,
        token_hit_rate: state.tokTotal ? state.tokCached / state.tokTotal : 0,
        pool: {
          positions: state.poolPositions,
          used: state.poolUsed,
          usage_ratio: state.poolUsed / state.poolPositions,
        },
      },
    };
  }

  async function halogenCache() {
    await delay(40);
    return {
      busy: false,
      in_flight: 0,
      queued: 0,
      longest_wait_s: 0,
      slots: 4,
      cache: {
        hit_rate: state.reqTotal ? state.reqHits / state.reqTotal : 0,
        token_hit_rate: state.tokTotal ? state.tokCached / state.tokTotal : 0,
        pool: {
          positions: state.poolPositions,
          used: state.poolUsed,
          usage_ratio: state.poolUsed / state.poolPositions,
        },
      },
    };
  }

  async function health() {
    return halogenStatus();
  }

  async function listModels() {
    await delay(100);
    return state.models.map(m => m.id);
  }

  async function halogenWarmPrefix(handleName, _payload) {
    await delay(120);
    if (handleName) state.handles.add(handleName);
    return {
      ok: true,
      handle: handleName || null,
      reply: "Ready. Send the target pages and I will transcribe them.",
      usage: { prompt_tokens: 128, completion_tokens: 1 },
      timings: { prompt_n: 128, cache_n: 0 },
    };
  }

  async function halogenReleaseHandle(handleName) {
    await delay(30);
    state.handles.delete(handleName);
    return { released: handleName };
  }

  async function halogenListHandles() {
    return [...state.handles];
  }

  async function inhibitSuspend() {
    return;
  }

  const sys = { ram: 18.4, gtt: 74.2, gpu: 8 };
  async function systemStats() {
    await delay(60);
    const drift = (v, lo, hi, step) => Math.min(hi, Math.max(lo, v + (Math.random() - 0.5) * step));
    sys.ram = drift(sys.ram, 14, 32, 0.4);
    sys.gtt = drift(sys.gtt, 70, 96, 0.5);
    sys.gpu = drift(sys.gpu, 1, 95, 5);
    return {
      cpu_percent: Math.round(drift(12, 2, 80, 6) * 10) / 10,
      memory_gb: Math.round(sys.ram * 10) / 10,
      gpu_percent: Math.round(sys.gpu * 10) / 10,
      vram_gb: 0.5,
      vram_total_gb: 0.5,
      gtt_gb: Math.round(sys.gtt * 10) / 10,
      gtt_total_gb: 112.0,
    };
  }

  async function* streamBatch({ batch, instruction, params = {}, headers = null, signal }) {
    const pages = batch.map(p => p.index + 1);
    const pageRange = pages.length > 1
      ? `pages ${pages[0]}–${pages[pages.length - 1]}`
      : `page ${pages[0]}`;

    const payload = params.payload || HalogenConfig.buildChatPayload({
      model: params.model,
      instruction,
      settings: params.settings || params,
      cacheMode: params.cacheMode || "no_store",
      warmReply: params.warmReply || "",
      useNoStore: !!params.useNoStore,
    });

    const totalPrompt = batch.length * 2400 + 256;
    const cachedPrompt = (params.cacheMode !== "standard" || state.reqTotal > 0) ? 256 : 0;
    state.reqTotal++;
    if (cachedPrompt > 0) state.reqHits++;
    state.tokTotal += totalPrompt;
    state.tokCached += cachedPrompt;
    state.poolUsed = Math.min(state.poolPositions, 32768 + totalPrompt);

    for (const frac of [0.35, 0.75, 1.0]) {
      if (signal.aborted) throw new DOMException("cancelled", "AbortError");
      const processed = Math.round(cachedPrompt + (totalPrompt - cachedPrompt) * frac);
      yield {
        type: "progress",
        progress: { total: totalPrompt, cache: cachedPrompt, processed, time_ms: Math.round(frac * 900) },
      };
      await delay(90);
    }

    const thinkingOff = payload.chat_template_kwargs?.enable_thinking === false
      || payload.reasoning_effort === "none";
    const thinkingText =
      `Examining ${pageRange} under instruction "${instruction.slice(0, 50)}${instruction.length > 50 ? "…" : ""}". ` +
      `Checking headings, lists, and table layout before transcribing.`;
    const outputText =
      `# Transcription — ${pageRange}\n\n` +
      `## Page ${pages[0]}\n\n` +
      `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor ` +
      `incididunt ut labore et dolore magna aliqua.\n\n` +
      pages.slice(1).map(p =>
        `## Page ${p}\n\nDuis aute irure dolor in reprehenderit in voluptate velit esse ` +
        `cillum dolore eu fugiat nulla pariatur.\n`
      ).join("\n");

    const t0 = performance.now();
    let tokens = 0;
    let reasonTokens = 0;
    if (!thinkingOff) {
      for (const word of thinkingText.split(" ")) {
        if (signal.aborted) throw new DOMException("cancelled", "AbortError");
        yield { type: "thinking", text: word + " " };
        tokens++;
        reasonTokens++;
        await delay(12);
      }
    }

    for (const word of outputText.split(" ")) {
      if (signal.aborted) throw new DOMException("cancelled", "AbortError");
      yield { type: "output", text: word + " " };
      tokens++;
      await delay(10);
    }

    const elapsed = (performance.now() - t0) / 1000;
    const draftN = Math.max(4, Math.round(tokens * 1.4));
    const draftAcc = Math.round(draftN * 0.78);
    const halogenFrom = headers?.["X-Halogen-From"]
      ? (state.handles.has(headers["X-Halogen-From"]) ? "used" : "unknown")
      : null;

    yield {
      type: "stats",
      stats: GenerationStats.normalize(
        {
          prompt_n: totalPrompt - cachedPrompt,
          cache_n: cachedPrompt,
          prompt_ms: 900,
          prompt_per_second: (totalPrompt - cachedPrompt) / 0.9,
          predicted_n: tokens,
          predicted_per_second: tokens / Math.max(elapsed, 0.1),
          draft_n: draftN,
          draft_n_accepted: draftAcc,
        },
        "request",
        {
          prompt_tokens: totalPrompt,
          completion_tokens: tokens,
          prompt_tokens_details: { cached_tokens: cachedPrompt },
          completion_tokens_details: reasonTokens ? { reasoning_tokens: reasonTokens } : {},
        },
        halogenFrom
      ),
    };
  }

  // Mirrors halogen-flash-server: 1024 px/token capped at 3600 tokens (3.69 MP) and 4x refusal.
  async function promptTokens(_model, content) {
    await delay(120);
    let tokens = 24;
    for (const part of content) {
      if (part.type !== "image_url") continue;
      const img = new Image();
      img.src = part.image_url.url;
      await img.decode();
      const px = img.naturalWidth * img.naturalHeight;
      if (px > state.visionMaxPixels * 4) {
        throw new Error("HTTP 400: image exceeds 4x HALOGEN_VISION_MAX_PIXELS");
      }
      tokens += Math.min(Math.round(state.visionMaxPixels / 1024), Math.round(px / 1024)) + 2;
    }
    return tokens;
  }

  const SETTINGS_KEY = "docproc4-halogen.settings";
  const INSTR_KEY = "docproc4-halogen.instructions";
  const RECOVERY_KEY = "docproc4-halogen.recovery";
  async function loadPersisted() {
    return {
      settings: JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"),
      instructions: JSON.parse(localStorage.getItem(INSTR_KEY) || "null"),
    };
  }
  async function persistSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
  async function persistInstructions(i) { localStorage.setItem(INSTR_KEY, JSON.stringify(i)); }
  async function readRecovery() { try { return JSON.parse(localStorage.getItem(RECOVERY_KEY) || "null"); } catch { return null; } }
  async function writeRecovery(data) { localStorage.setItem(RECOVERY_KEY, JSON.stringify(data)); }
  async function clearRecovery() { localStorage.removeItem(RECOVERY_KEY); }

  async function saveOutputs(_merged, files) {
    for (const f of files) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([f.content], { type: "text/markdown" }));
      a.download = f.name;
      a.click();
      URL.revokeObjectURL(a.href);
      await delay(120);
    }
    return { saved: files.map(f => f.name) };
  }

  function configure() {}

  return {
    convertPdf, promptTokens,
    health, listModels, systemStats,
    halogenStatus, halogenCache, halogenWarmPrefix, halogenReleaseHandle, halogenListHandles,
    inhibitSuspend,
    streamBatch, loadPersisted, persistSettings, persistInstructions, saveOutputs,
    readRecovery, writeRecovery, clearRecovery, configure, _state: state,
  };
})();
