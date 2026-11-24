/* Pure halogen-flash-server configuration, payload builders, and validation shared by UI and tests. */
"use strict";
const HalogenConfig = (() => {
  const DEFAULT_URL = "http://localhost:8731";
  const DEFAULT_MODEL = "halogen-qwen3.8-flash-next";
  const DEFAULT_BUDGET_PX = 3686400; // 2560 x 1440 (HALOGEN_VISION_MAX_PIXELS default)
  const MAX_BUDGET_PX = 14745600;    // 4 x 3,686,400 (server HTTP 400 ceiling)
  const DEFAULT_MAX_TOKENS = 16384;
  const MAX_TOKENS_CAP = 65536;
  const DEFAULT_CONCURRENCY = 2;
  const MAX_CONCURRENCY = 16;
  const FORK_ACK_PROMPT =
    "Acknowledge the transcription instructions briefly. The PDF page images will follow in the next message.";

  const BUDGET_PRESETS = [
    { label: "2560×1440 (3.69 MP)", pixels: 3686400 },
    { label: "1920×1080 (2.07 MP)", pixels: 2073600 },
    { label: "1280×800 (1.02 MP)", pixels: 1024000 },
  ];

  const SAMPLING_PRESETS = {
    greedy: {
      temp: 0, topp: "", topk: "", minp: "",
      presencePenalty: "", frequencyPenalty: "", repetitionPenalty: "", seed: "",
    },
    "qwen-non-thinking": {
      temp: 0.7, topp: 0.8, topk: 20, minp: "",
      presencePenalty: 1.5, frequencyPenalty: "", repetitionPenalty: 1.0, seed: "",
    },
    "qwen-thinking": {
      temp: 1.0, topp: 0.95, topk: 20, minp: "",
      presencePenalty: 0, frequencyPenalty: "", repetitionPenalty: 1.0, seed: "",
    },
    "server-default": {},
  };

  const THINKING_LABELS = {
    "": "server default",
    none: "none (off)",
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "x-high",
    max: "max",
  };

  const CACHE_MODE_LABELS = {
    no_store: "prefix cache (no_store)",
    fork: "session fork",
    standard: "standard cache",
  };

  function optNum(value) {
    if (value === "" || value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function validateConfig(cfg, serverCap = MAX_TOKENS_CAP) {
    const capNum = optNum(serverCap);
    const cap = Number.isInteger(capNum) && capNum >= 64 ? capNum : MAX_TOKENS_CAP;

    const maxTokens = optNum(cfg.maxTokens);
    if (!Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > cap) {
      throw new Error(`Max completion tokens must be a whole number between 64 and ${cap}.`);
    }

    const rawThink = cfg.maxThinkingTokens;
    const maxThinkingTokens = rawThink === "" || rawThink == null ? 0 : Number(rawThink);
    if (!Number.isInteger(maxThinkingTokens) || maxThinkingTokens < 0 || maxThinkingTokens > cap) {
      throw new Error(`Max thinking tokens must be a whole number between 0 and ${cap}.`);
    }

    const conc = optNum(cfg.conc);
    if (!Number.isInteger(conc) || conc < 1 || conc > MAX_CONCURRENCY) {
      throw new Error(`Concurrent batches must be a whole number between 1 and ${MAX_CONCURRENCY}.`);
    }

    const cacheMode = cfg.cacheMode;
    if (!Object.prototype.hasOwnProperty.call(CACHE_MODE_LABELS, cacheMode)) {
      throw new Error("Choose a valid Halogen prompt cache / session mode.");
    }

    const effort = cfg.thinkingEffort ?? "";
    if (!Object.prototype.hasOwnProperty.call(THINKING_LABELS, effort)) {
      throw new Error("Choose a valid thinking effort.");
    }

    const preset = cfg.samplingPreset || "greedy";
    if (preset !== "server-default") {
      const temp = optNum(cfg.temp);
      if (temp == null || temp < 0 || temp > 2) {
        throw new Error("Temperature must be between 0 and 2.");
      }
      if (temp > 0) {
        const topp = optNum(cfg.topp);
        if (topp != null && (topp < 0 || topp > 1)) {
          throw new Error("Top P must be between 0 and 1.");
        }
        const topk = optNum(cfg.topk);
        if (topk != null && (!Number.isInteger(topk) || topk < 0)) {
          throw new Error("Top K must be a non-negative whole number.");
        }
        const minp = optNum(cfg.minp);
        if (minp != null && (minp < 0 || minp > 1)) {
          throw new Error("Min P must be between 0 and 1.");
        }
        const presence = optNum(cfg.presencePenalty);
        if (presence != null && (presence < -2 || presence > 2)) {
          throw new Error("Presence penalty must be between -2 and 2.");
        }
        const frequency = optNum(cfg.frequencyPenalty);
        if (frequency != null && (frequency < -2 || frequency > 2)) {
          throw new Error("Frequency penalty must be between -2 and 2.");
        }
        const repetition = optNum(cfg.repetitionPenalty);
        if (repetition != null && (repetition < 0.1 || repetition > 5)) {
          throw new Error("Repetition penalty must be between 0.1 and 5.");
        }
        const seed = optNum(cfg.seed);
        if (seed != null && (!Number.isInteger(seed) || seed < 0)) {
          throw new Error("Seed must be a non-negative whole number.");
        }
      }
    }

    return { maxTokens, maxThinkingTokens, conc, cacheMode, thinkingEffort: effort };
  }

  function thinkingFields(effort, maxThinkingTokens) {
    if (effort === "none") {
      return {
        reasoning_effort: "none",
        chat_template_kwargs: { enable_thinking: false },
      };
    }
    const out = {};
    if (effort) {
      out.reasoning_effort = effort;
    }
    const cap = optNum(maxThinkingTokens);
    if (cap != null && Number.isInteger(cap) && cap > 0) {
      out.max_thinking_tokens = cap;
    }
    return out;
  }

  function samplingFields(cfg) {
    if (cfg.samplingPreset === "server-default") return {};
    const temp = optNum(cfg.temp) ?? 0;
    // halogen-flash-server rejects non-default penalties/filters at temperature: 0 with HTTP 400.
    if (temp === 0) return { temperature: 0 };
    const out = { temperature: temp };
    const topp = optNum(cfg.topp);
    const topk = optNum(cfg.topk);
    const minp = optNum(cfg.minp);
    const presence = optNum(cfg.presencePenalty);
    const frequency = optNum(cfg.frequencyPenalty);
    const repetition = optNum(cfg.repetitionPenalty);
    const seed = optNum(cfg.seed);
    if (topp != null) out.top_p = topp;
    if (topk != null) out.top_k = topk;
    if (minp != null) out.min_p = minp;
    if (presence != null) out.presence_penalty = presence;
    if (frequency != null) out.frequency_penalty = frequency;
    if (repetition != null) out.repetition_penalty = repetition;
    if (seed != null) out.seed = seed;
    return out;
  }

  function warmPayload(model, instruction, cacheMode = "no_store") {
    return {
      model,
      stream: false,
      max_completion_tokens: 1,
      temperature: 0,
      reasoning_effort: "none",
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        { role: "system", content: instruction },
        { role: "user", content: cacheMode === "fork" ? FORK_ACK_PROMPT : "OK" },
      ],
    };
  }

  function batchMessages(instruction, cacheMode = "no_store", warmReply = "") {
    if (cacheMode === "fork" && typeof warmReply === "string" && warmReply.length > 0) {
      return [
        { role: "system", content: instruction },
        { role: "user", content: FORK_ACK_PROMPT },
        { role: "assistant", content: warmReply },
        { role: "user", content: [] },
      ];
    }
    return [
      { role: "system", content: instruction },
      { role: "user", content: [] },
    ];
  }

  function buildChatPayload({
    model,
    instruction,
    settings,
    cacheMode = "no_store",
    warmReply = "",
    sessionId = null,
    useNoStore = false,
  }) {
    const payload = {
      model,
      messages: batchMessages(instruction, cacheMode, warmReply),
      stream: true,
      return_progress: true,
      max_completion_tokens: Number(settings.maxTokens ?? DEFAULT_MAX_TOKENS),
      ...samplingFields(settings),
      ...thinkingFields(settings.thinkingEffort, settings.maxThinkingTokens),
    };
    if (useNoStore) payload.prompt_cache_policy = "no_store";
    if (sessionId) payload.session_id = sessionId;
    return payload;
  }

  function probeSidesForCap(maxPixels = DEFAULT_BUDGET_PX) {
    const capNum = optNum(maxPixels);
    const cap = capNum != null && capNum > 0 ? capNum : DEFAULT_BUDGET_PX;
    const raw = Math.floor(Math.sqrt(cap * 3.2) / 32) * 32;
    const side3 = Math.min(4096, Math.max(2048, raw));
    return [1024, 1448, side3];
  }

  function serverUnavailable(message) {
    return /error sending request|error decoding response body|connection (?:refused|reset|closed|failed)|failed to (?:read|connect)|broken pipe|http (?:502|503|504)\b|engine_busy|engine_stalled|host_memory|HALOGEN_VISION_TOWER/i.test(
      String(message || "")
    );
  }

  return {
    DEFAULT_URL,
    DEFAULT_MODEL,
    DEFAULT_BUDGET_PX,
    MAX_BUDGET_PX,
    DEFAULT_MAX_TOKENS,
    MAX_TOKENS_CAP,
    DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
    FORK_ACK_PROMPT,
    BUDGET_PRESETS,
    SAMPLING_PRESETS,
    THINKING_LABELS,
    CACHE_MODE_LABELS,
    optNum,
    validateConfig,
    thinkingFields,
    samplingFields,
    warmPayload,
    batchMessages,
    buildChatPayload,
    probeSidesForCap,
    serverUnavailable,
  };
})();
if (typeof module !== "undefined") module.exports = HalogenConfig;
