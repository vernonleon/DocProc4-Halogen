"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const HalogenConfig = require("../ui/halogen-config.js");
const Stats = require("../ui/generation-stats.js");

test("HalogenConfig defaults match halogen-flash-server expectations", () => {
  assert.equal(HalogenConfig.DEFAULT_URL, "http://localhost:8731");
  assert.equal(HalogenConfig.DEFAULT_MODEL, "halogen-qwen3.8-flash-next");
  assert.equal(HalogenConfig.DEFAULT_BUDGET_PX, 3686400);
  assert.equal(HalogenConfig.MAX_BUDGET_PX, 14745600);
  assert.equal(HalogenConfig.DEFAULT_MAX_TOKENS, 16384);
  assert.equal(HalogenConfig.MAX_TOKENS_CAP, 65536);
});

test("samplingFields omits filters, penalties, and seed on greedy (temp 0)", () => {
  const greedy = HalogenConfig.samplingFields({
    samplingPreset: "greedy",
    temp: 0,
    topp: 0.95,
    topk: 20,
    minp: 0.05,
    presencePenalty: 1.5,
    frequencyPenalty: 0.5,
    repetitionPenalty: 1.1,
    seed: 42,
  });
  assert.deepEqual(greedy, { temperature: 0 });
  assert.equal("repeat_penalty" in greedy, false);
  assert.equal("repetition_penalty" in greedy, false);
  assert.equal("seed" in greedy, false);
});

test("samplingFields sends repetition_penalty (never repeat_penalty) when sampled and omits all on server-default", () => {
  const sampled = HalogenConfig.samplingFields({
    samplingPreset: "qwen-non-thinking",
    ...HalogenConfig.SAMPLING_PRESETS["qwen-non-thinking"],
    seed: 123,
  });
  assert.equal(sampled.temperature, 0.7);
  assert.equal(sampled.top_p, 0.8);
  assert.equal(sampled.top_k, 20);
  assert.equal(sampled.presence_penalty, 1.5);
  assert.equal(sampled.repetition_penalty, 1.0);
  assert.equal(sampled.seed, 123);
  assert.equal("repeat_penalty" in sampled, false);
  assert.equal("min_p" in sampled, false);

  assert.deepEqual(
    HalogenConfig.samplingFields({ samplingPreset: "server-default", temp: 0.7, topp: 0.9 }),
    {}
  );
});

test("thinkingFields handles thinking-off vs effort + max_thinking_tokens", () => {
  assert.deepEqual(HalogenConfig.thinkingFields("none", 4096), {
    reasoning_effort: "none",
    chat_template_kwargs: { enable_thinking: false },
  });
  assert.deepEqual(HalogenConfig.thinkingFields("low", 2048), {
    reasoning_effort: "low",
    max_thinking_tokens: 2048,
  });
  assert.deepEqual(HalogenConfig.thinkingFields("xhigh", 0), {
    reasoning_effort: "xhigh",
  });
  assert.deepEqual(HalogenConfig.thinkingFields("", 1024), {
    max_thinking_tokens: 1024,
  });
});

test("warmPayload, batchMessages, and buildChatPayload construct Halogen layouts", () => {
  const warmFork = HalogenConfig.warmPayload("halogen-qwen3.8-flash-next", "Transcribe.", "fork");
  assert.equal(warmFork.max_completion_tokens, 1);
  assert.equal(warmFork.temperature, 0);
  assert.equal(warmFork.stream, false);
  assert.deepEqual(warmFork.chat_template_kwargs, { enable_thinking: false });
  assert.equal(warmFork.messages[1].content, HalogenConfig.FORK_ACK_PROMPT);

  const warmNoStore = HalogenConfig.warmPayload("halogen-qwen3.8-flash-next", "Transcribe.", "no_store");
  assert.equal(warmNoStore.messages[1].content, "OK");

  const forkMsgs = HalogenConfig.batchMessages("Transcribe.", "fork", "Ready.");
  assert.equal(forkMsgs.length, 4);
  assert.deepEqual(
    forkMsgs.map(m => m.role),
    ["system", "user", "assistant", "user"]
  );
  assert.equal(forkMsgs[2].content, "Ready.");

  const fallbackMsgs = HalogenConfig.batchMessages("Transcribe.", "fork", "");
  assert.equal(fallbackMsgs.length, 2);

  const chat = HalogenConfig.buildChatPayload({
    model: "halogen-qwen3.8-flash-next",
    instruction: "Transcribe.",
    settings: {
      maxTokens: 16384,
      thinkingEffort: "none",
      maxThinkingTokens: 0,
      samplingPreset: "greedy",
      temp: 0,
    },
    cacheMode: "no_store",
    sessionId: "sess-1",
    useNoStore: true,
  });
  assert.equal(chat.return_progress, true);
  assert.equal(chat.prompt_cache_policy, "no_store");
  assert.equal(chat.max_completion_tokens, 16384);
  assert.equal("max_tokens" in chat, false);
  assert.equal(chat.session_id, "sess-1");
});

test("probeSidesForCap stays safely below Halogen 4x vision refusal ceiling", () => {
  const sides = HalogenConfig.probeSidesForCap(HalogenConfig.DEFAULT_BUDGET_PX);
  assert.deepEqual(sides.slice(0, 2), [1024, 1448]);
  const px3 = sides[2] * sides[2];
  assert.ok(px3 > HalogenConfig.DEFAULT_BUDGET_PX);
  assert.ok(px3 < HalogenConfig.MAX_BUDGET_PX);
});

test("validateConfig rejects out-of-range settings and cap violations", () => {
  const valid = {
    maxTokens: 16384,
    maxThinkingTokens: 0,
    conc: 2,
    cacheMode: "no_store",
    thinkingEffort: "none",
    samplingPreset: "greedy",
    temp: 0,
  };
  assert.equal(HalogenConfig.validateConfig(valid, 65536).maxTokens, 16384);
  assert.throws(() => HalogenConfig.validateConfig({ ...valid, maxTokens: 32768 }, 16384));
  assert.throws(() => HalogenConfig.validateConfig({ ...valid, maxTokens: 32 }, 65536));
  assert.throws(() => HalogenConfig.validateConfig({ ...valid, conc: 17 }, 65536));
  assert.throws(() => HalogenConfig.validateConfig({ ...valid, cacheMode: "bogus" }, 65536));
  assert.throws(() =>
    HalogenConfig.validateConfig({ ...valid, samplingPreset: "custom", temp: 0.7, repetitionPenalty: 9 }, 65536)
  );
});

test("serverUnavailable matches Halogen transport and state failures", () => {
  assert.equal(HalogenConfig.serverUnavailable("Connection refused (os error 111)"), true);
  assert.equal(HalogenConfig.serverUnavailable("HTTP 503: engine_busy"), true);
  assert.equal(HalogenConfig.serverUnavailable("HALOGEN_VISION_TOWER=1 required"), true);
  assert.equal(HalogenConfig.serverUnavailable("output truncated"), false);
});

test("GenerationStats normalizes Halogen cache hits, MTP acceptance, reasoning details, and fork header", () => {
  const st = Stats.normalize(
    {
      prompt_n: 2000,
      cache_n: 500,
      prompt_ms: 1000,
      prompt_per_second: 2000,
      predicted_n: 300,
      predicted_per_second: 95.4,
      draft_n: 120,
      draft_n_accepted: 90,
    },
    "request",
    {
      prompt_tokens: 2500,
      completion_tokens: 300,
      prompt_tokens_details: { cached_tokens: 500 },
      completion_tokens_details: { reasoning_tokens: 80, reasoning_closed_by: "answer_room" },
    },
    "used"
  );
  assert.equal(st.promptTokens, 2500);
  assert.equal(st.cachedTokens, 500);
  assert.equal(st.cacheHitPct, 20);
  assert.equal(st.specAcceptance, 75);
  assert.equal(st.reasoningTokens, 80);
  assert.equal(st.reasoningClosedBy, "answer_room");
  assert.equal(st.halogenFrom, "used");

  const formatted = Stats.format(st);
  assert.match(formatted, /2,500 tok \(500 cached, 20%\)/);
  assert.match(formatted, /decode 300 tok @ 95\.4 tok\/s/);
  assert.match(formatted, /MTP 75\.0% \(90\/120\)/);
  assert.match(formatted, /thinking 80 tok \(closed by answer_room\)/);
  assert.match(formatted, /fork used/);
});

test("GenerationStats handles real zero acceptance vs missing/malformed/server-wide counters", () => {
  const zero = Stats.normalize({ draft_n: 10, draft_n_accepted: 0 });
  assert.equal(zero.specAcceptance, 0);
  assert.match(Stats.format(zero), /MTP 0\.0% \(0\/10\)/);

  for (const payload of [
    {}, { draft_n: 0, draft_n_accepted: 0 }, { draft_n: 10 },
    { draft_n: 10, draft_n_accepted: 11 }, { draft_n: -1, draft_n_accepted: 0 },
    { draft_n: "NaN", draft_n_accepted: 0 }, { draft_n: 10.5, draft_n_accepted: 4 },
  ]) {
    const s = Stats.normalize(payload);
    assert.equal(s.specAcceptance, null);
    assert.doesNotMatch(Stats.format(s), /NaN|Infinity|MTP 0\.0%/);
  }

  const srv = Stats.normalize({ draft_n: 10, draft_n_accepted: 9 }, "server");
  assert.equal(srv.specAcceptance, null);
  assert.match(Stats.format(srv), /server-wide stats/);
});

function bridge({ onListen, onStart } = {}) {
  const calls = [];
  let listener, removed = 0;
  const invoke = async (name, args) => {
    calls.push({ name, args });
    if (name === "chat_stream") await onStart?.(args, payload => listener({ payload: { id: args.id, ...payload } }));
  };
  const ctx = vm.createContext({
    window: {
      __TAURI__: {
        core: { invoke },
        event: {
          listen: async (_name, cb) => {
            listener = cb;
            await onListen?.();
            return () => removed++;
          },
        },
      },
    },
    crypto: webcrypto,
    DOMException,
    GenerationStats: Stats,
    HalogenConfig,
  });
  vm.runInContext(
    fs.readFileSync(require.resolve("../ui/real-backend.js"), "utf8") + "\nglobalThis.backend = TauriBackend;",
    ctx
  );
  return { backend: ctx.backend, calls, removed: () => removed };
}

const streamArgs = (signal, extra = {}) => ({
  batch: [],
  instruction: "Transcribe.",
  params: {
    model: "halogen-qwen3.8-flash-next",
    settings: { maxTokens: 16384, thinkingEffort: "none", samplingPreset: "greedy", temp: 0 },
    cacheMode: "no_store",
    useNoStore: true,
    ...extra.params,
  },
  headers: extra.headers ?? null,
  signal,
});

test("abort during event registration cannot launch an uncancellable request", async () => {
  const ctrl = new AbortController();
  const b = bridge({ onListen: () => ctrl.abort() });
  await assert.rejects(b.backend.streamBatch(streamArgs(ctrl.signal)).next(), { name: "AbortError" });
  assert.ok(!b.calls.some(c => c.name === "chat_stream"));
  assert.equal(b.removed(), 1);
});

test("early consumer exit cancels generation and removes listeners", async () => {
  const ctrl = new AbortController();
  const b = bridge({ onStart: (_args, emit) => emit({ kind: "output", text: "hello" }) });
  const stream = b.backend.streamBatch(streamArgs(ctrl.signal));
  assert.equal((await stream.next()).value.text, "hello");
  await stream.return();
  assert.equal(b.removed(), 1);
  const cancelled = b.calls.filter(c => c.name === "chat_cancel").length;
  assert.equal(cancelled, 1);
  ctrl.abort();
  assert.equal(b.calls.filter(c => c.name === "chat_cancel").length, cancelled);
});

test("streamBatch forwards progress events, X-Halogen-From headers, usage, and halogen_from", async () => {
  const b = bridge({
    onStart: (args, emit) => {
      assert.deepEqual(args.headers, { "X-Halogen-From": "docproc4-1234" });
      assert.equal(args.payload.prompt_cache_policy, "no_store");
      assert.equal(args.payload.return_progress, true);
      emit({ kind: "progress", progress: { total: 1000, cache: 200, processed: 600, time_ms: 400 } });
      emit({ kind: "output", text: "# Page 1" });
      emit({
        kind: "stats",
        source: "request",
        stats: { draft_n: 10, draft_n_accepted: 8, cache_n: 200, prompt_n: 800, predicted_n: 40, predicted_per_second: 90 },
        usage: { prompt_tokens: 1000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 200 } },
        halogen_from: "used",
      });
      emit({ kind: "done" });
    },
  });
  const events = [];
  for await (const ev of b.backend.streamBatch(
    streamArgs(new AbortController().signal, { headers: { "X-Halogen-From": "docproc4-1234" } })
  )) {
    events.push(ev);
  }
  assert.equal(events[0].type, "progress");
  assert.equal(events[0].progress.processed, 600);
  assert.equal(events[1].type, "output");
  assert.equal(events[2].type, "stats");
  assert.equal(events[2].stats.specAcceptance, 80);
  assert.equal(events[2].stats.cacheHitPct, 20);
  assert.equal(events[2].stats.halogenFrom, "used");
  assert.equal(b.removed(), 1);
  assert.ok(!b.calls.some(c => c.name === "chat_cancel"));
});
