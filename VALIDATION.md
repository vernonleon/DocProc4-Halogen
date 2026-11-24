# Validation — DocProc4 Halogen

Standalone copy of `DocProc4` at `/home/vsanders/DocProc4-Halogen` tailored for [`peonist-ai/halogen-flash-server`](https://github.com/peonist-ai/halogen-flash-server) (`Qwen3.8-Flash-Next` on AMD Strix Halo).

## Automated checks run after final edits

- **JavaScript suite (`npm test`)**:
  - `scripts/test-inference.js` (13/13 tests): `HalogenConfig` defaults, greedy `temperature: 0` omission of filters/penalties/seed, `repetition_penalty` (never `repeat_penalty`) on sampled requests, `server-default` omission, `thinkingFields` (`none` vs effort + `max_thinking_tokens`), `warmPayload` / `batchMessages` / `buildChatPayload` (`return_progress: true`, `prompt_cache_policy: "no_store"`, `max_completion_tokens`), `probeSidesForCap` staying under Halogen's `4×` vision refusal limit, `validateConfig`, `serverUnavailable`, `GenerationStats` cache-hit/MTP/reasoning/`X-Halogen-From` normalization and zero/missing/server-wide guards, and `TauriBackend.streamBatch` abort/cancellation/progress/header forwarding.
  - `scripts/test-repetition.js` (12/12 checks): streaming repetition/loop detection and performance (`0.14 ms` on 141,354 chars).
- **Rust suite (`cargo test --locked --manifest-path src-tauri/Cargo.toml`)**:
  - 21/21 unit tests passing with 0 failures: `halogen::tests::detects_vision_and_max_pixels_from_health_and_modalities`, `halogen::tests::halogen_status_warm_and_release_http_flow` (mock HTTP server verifying `/health`, `/v1/models`, `/cache`, `X-Halogen-Keep`, and `DELETE /halogen/handles/{name}`), `attach_page_images_targets_final_user_message`, `count_tokens_sends_anthropic_headers`, `request_stats_survive_separate_usage_and_empty_timings`, `calibration_count_endpoint_and_legacy_fallback`, `mupdf_renders_test_pdf_at_pixel_target`, SSE think-tag splitting and UTF-8 boundary handling, error extraction, URL normalization, and atomic recovery writes.
- **Playwright UI smoke test (`CHROMIUM_PATH=/usr/bin/chromium node scripts/test-ui.js`)**:
  - Tested against `StubBackend` via local HTTP server: Halogen `/health` + `/cache` status & vision-OFF warning vs vision-ready display, sampling preset toggling (`greedy` / `qwen-non-thinking` / `server-default`), execution & cache preset persistence across reload, thinking-off hiding `max_thinking_tokens`, image budget presets (`2.07 MP` / `3.69 MP`), streaming `prompt_progress` prefill updates, throttled Markdown rendering (6 renders for 80 fragments), MTP/cache-hit/thinking/`fork used` stats, dashboard tiles (`#d-cache`, `#d-mtp`), and recovery banner across reload with 0 uncaught `pageerror` events.
- **Original workspace isolation**:
  - `/home/vsanders/DocProc4` was not modified (verified timestamps and `git -C /home/vsanders/DocProc4 status --short`).

## Notes

- No live `halogen-flash-server` instance was running on `localhost:8731` during this session, so all server checks used local mock HTTP servers (`std::net::TcpListener` in Rust) and `StubBackend` in Playwright.
- `npm run build` (full Tauri installer bundling) was not executed.
