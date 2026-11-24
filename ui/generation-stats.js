/* Halogen-flash-server and OpenAI statistics normalized without guessing missing counters. */
"use strict";
const GenerationStats = (() => {
  function number(value) {
    if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && value.trim() === "")) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function normalize(timings = {}, source = "request", usage = null, halogenFrom = null) {
    const s = timings && typeof timings === "object" ? timings : {};
    const u = usage && typeof usage === "object" ? usage : {};

    const rawCacheN = number(s.cache_n ?? u.prompt_tokens_details?.cached_tokens);
    const promptN = number(s.prompt_n);
    const usagePrompt = number(u.prompt_tokens ?? s.prompt_tokens ?? s.input_tokens);
    const promptTokens = usagePrompt ?? (promptN != null || rawCacheN != null ? (promptN ?? 0) + (rawCacheN ?? 0) : null);
    const cachedTokens = rawCacheN != null && promptTokens != null
      ? Math.min(promptTokens, rawCacheN)
      : rawCacheN;
    const cacheHitPct = promptTokens != null && promptTokens > 0 && cachedTokens != null
      ? Math.min(100, (100 * cachedTokens) / promptTokens)
      : null;

    const tokens = number(s.predicted_n ?? u.completion_tokens ?? s.output_tokens ?? s.completion_tokens);
    const tps = number(s.predicted_per_second ?? s.tokens_per_second);
    const promptMs = number(s.prompt_ms);
    const ttft = number(s.time_to_first_token);
    const ttftMs = promptMs ?? (ttft == null ? null : ttft * 1000);
    const prefillCount = promptN != null && promptN > 0 ? promptN : promptTokens;
    const prefill = number(s.prompt_per_second) ?? (prefillCount != null && prefillCount > 0 && ttftMs > 0 ? prefillCount * 1000 / ttftMs : null);

    // Server-wide fallback statistics must never be attributed to a single batch.
    const draftTokens = source === "request" ? number(s.draft_n) : null;
    const draftAccepted = source === "request" ? number(s.draft_n_accepted) : null;
    const validDraft = Number.isSafeInteger(draftTokens) && Number.isSafeInteger(draftAccepted)
      && draftAccepted <= draftTokens;

    const details = u.completion_tokens_details && typeof u.completion_tokens_details === "object"
      ? u.completion_tokens_details
      : null;
    const reasoningTokens = number(details?.reasoning_tokens);
    const reasoningClosedBy = typeof details?.reasoning_closed_by === "string" && details.reasoning_closed_by.trim()
      ? details.reasoning_closed_by.trim()
      : null;
    const reasoningClosedAt = number(details?.reasoning_closed_at);
    const endOfTurnKept = number(details?.end_of_turn_kept);
    const cleanFrom = typeof halogenFrom === "string" && halogenFrom.trim() ? halogenFrom.trim() : null;

    return {
      tokens,
      tokPerSec: tps == null ? null : tps.toFixed(1),
      ttftMs,
      promptTokens,
      promptN,
      cachedTokens,
      cacheHitPct,
      prefillPerSec: prefill == null ? null : prefill.toFixed(1),
      draftTokens: validDraft ? draftTokens : null,
      draftAccepted: validDraft ? draftAccepted : null,
      specAcceptance: validDraft && draftTokens > 0 ? (100 * draftAccepted) / draftTokens : null,
      reasoningTokens,
      reasoningClosedBy,
      reasoningClosedAt,
      endOfTurnKept,
      halogenFrom: cleanFrom,
      source,
    };
  }

  function format(st) {
    if (!st || typeof st !== "object") return "";
    const n = v => number(v) == null ? "?" : Number(v).toLocaleString();
    const parts = [];
    if (st.source === "server") parts.push("server-wide stats");
    if (st.promptTokens != null) {
      let prefillStr = `prefill ${n(st.promptTokens)} tok`;
      if (st.cachedTokens != null && st.cachedTokens > 0) {
        const pct = Math.round(st.cacheHitPct ?? ((100 * st.cachedTokens) / Math.max(1, st.promptTokens)));
        prefillStr += ` (${n(st.cachedTokens)} cached, ${pct}%)`;
      }
      if (st.prefillPerSec != null) prefillStr += ` @ ${st.prefillPerSec} tok/s`;
      parts.push(prefillStr);
    }
    parts.push(`decode ${n(st.tokens)} tok @ ${st.tokPerSec ?? "?"} tok/s`);
    const ttft = number(st.ttftMs);
    parts.push(`TTFT ${ttft == null ? "?" : ttft >= 10000 ? `${(ttft / 1000).toFixed(1)} s` : `${Math.round(ttft)} ms`}`);
    if (number(st.specAcceptance) != null && st.draftTokens > 0) {
      parts.push(`MTP ${Number(st.specAcceptance).toFixed(1)}% (${n(st.draftAccepted)}/${n(st.draftTokens)})`);
    } else {
      parts.push(st.draftTokens === 0 ? "MTP — (no tokens drafted)" : "MTP — (not reported)");
    }
    if (st.reasoningTokens != null && st.reasoningTokens > 0) {
      let r = `thinking ${n(st.reasoningTokens)} tok`;
      if (st.reasoningClosedBy) r += ` (closed by ${st.reasoningClosedBy})`;
      parts.push(r);
    } else if (st.reasoningClosedBy) {
      parts.push(`closed by ${st.reasoningClosedBy}`);
    }
    if (st.halogenFrom) {
      parts.push(`fork ${st.halogenFrom}`);
    }
    return parts.join(" · ");
  }

  return { normalize, format };
})();
if (typeof module !== "undefined") module.exports = GenerationStats;
