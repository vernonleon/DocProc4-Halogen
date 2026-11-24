# DocProc4 Halogen — notes for future sessions

Standalone sibling copy of `DocProc4` tailored for `peonist-ai/halogen-flash-server` (`Qwen3.8-Flash-Next` on AMD Strix Halo, default port `8731`). Keep `/home/vsanders/DocProc4` untouched.

## App identity & isolation

- Package name / binary: `docproc4-halogen` (`com.docproc4.halogen` in `src-tauri/tauri.conf.json`).
- Browser-mode localStorage keys: `docproc4-halogen.settings`, `docproc4-halogen.instructions`, `docproc4-halogen.recovery`.
- Disk render prefix: `docproc4-halogen-`.

## Key differences from generic DocProc4

- **No `/v1/load` or `/v1/unload`:** `halogen-flash-server` loads its checkpoint at container startup. Never call `/v1/unload` on Cancel All or window close.
- **Halogen endpoints (`src-tauri/src/halogen.rs`):** `GET /health` (open even with `HALOGEN_API_KEY`), `GET /v1/models`, `GET /cache`, `POST /v1/chat/completions` (`X-Halogen-Keep` / `X-Halogen-From`, `return_progress: true`, `prompt_cache_policy: "no_store"`), `DELETE /halogen/handles/{name}`, `GET /halogen/handles`.
- **Sampling constraints (`ui/halogen-config.js`):** At `temperature: 0`, omit `top_p`, `top_k`, `min_p`, `presence_penalty`, `frequency_penalty`, `repetition_penalty`, and `seed` (Halogen returns HTTP 400 on greedy + non-default penalties). Always use `repetition_penalty` (never `repeat_penalty`). Send only `max_completion_tokens`.
- **Message attachment (`attach_page_images` in `src-tauri/src/main.rs`):** Appends PDF page images to `messages.last_mut().content` so both `[system, user]` and 4-message `[system, user, assistant, user]` (`fork`) layouts work.
- **Vision pixel budget:** Defaults to `3,686,400` px (`2560×1440`, matching `HALOGEN_VISION_MAX_PIXELS`) or `/health`'s `vision.max_pixels`, capped at `4×` (`14.75 MP`). `probeSidesForCap()` keeps synthetic calibration probes below the `4×` HTTP 400 refusal limit.
- **Sleep inhibition (`src-tauri/src/power.rs`):** Uses `systemd-inhibit` on Linux during active runs and releases it on completion, cancellation, or window close.

## Verification

- `npm test` — `scripts/test-inference.js` and `scripts/test-repetition.js`.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml` — Rust unit tests including MuPDF render, SSE parsing, `attach_page_images`, `collect_stream_stats`, `count_tokens` headers, `detect_vision`, and local HTTP `halogen_status`/`warm`/`release` flow.
- `CHROMIUM_PATH=/usr/bin/chromium node scripts/test-ui.js` — Playwright UI smoke test (set `NODE_PATH` if Playwright is outside `node_modules`).
