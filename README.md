# DocProc4 Halogen

DocProc4 Halogen is a standalone copy of [DocProc4](../DocProc4) tuned specifically for [`peonist-ai/halogen-flash-server`](https://github.com/peonist-ai/halogen-flash-server) (`Qwen3.8-Flash-Next` on AMD Strix Halo). PDF rendering, settings, recovery, and output Markdown files stay on your machine. The original `DocProc4` directory and its app profile (`com.docproc4.app`) are untouched; DocProc4 Halogen uses `com.docproc4.halogen`.

## Starting `halogen-flash-server` with vision enabled

Image inputs on `halogen-flash-server` are off by default until `HALOGEN_VISION_TOWER=1` is set:

```bash
mkdir -p ~/halogen-models
```

```bash
podman run --rm -p 8731:8731 \
  --device /dev/kfd --device /dev/dri --group-add keep-groups \
  --ipc=host --ulimit memlock=-1:-1 \
  -e HALOGEN_VISION_TOWER=1 \
  -e HALOGEN_DOWNLOAD=peonist-ai/halogen-qwen3.8-flash-next \
  -v ~/halogen-models:/models \
  ghcr.io/peonist-ai/halogen-flash-server:0.20.7
```

## Run

```bash
cd /home/vsanders/DocProc4-Halogen
```

```bash
npm install
```

```bash
npm run dev
```

Build release installers with:

```bash
npm run build
```

Requirements: Rust (via rustup), Node.js, a C compiler and clang (MuPDF is built from source), and Tauri's Linux build dependencies (WebKitGTK 4.1 and related packages).

## Halogen-specific tuning

- **Server status & vision tower check:** Connects to `http://localhost:8731` by default and probes `/health`, `/v1/models`, and `/cache`. Shows engine/API versions, KV pool occupancy (`used / positions`), prompt-cache hit rates, slots/queue depth, and a clear warning naming `HALOGEN_VISION_TOWER=1` if the vision tower is off.
- **Image budget:** Defaults to `3.69 MP` (`2560×1440`, matching `HALOGEN_VISION_MAX_PIXELS`), or reads `/health`'s `vision.max_pixels`, with one-click presets (`2560×1440 · 3.69 MP`, `1920×1080 · 2.07 MP`, `1280×800 · 1.02 MP`) and a hard cap at `14.75 MP` (`4×` default, above which Halogen refuses requests with HTTP 400). **Re-measure** probes `/v1/messages/count_tokens` without running image inference, keeping its largest synthetic image safely under Halogen's `4×` ceiling.
- **Thinking & token budget:** `max_completion_tokens` (default `16384`, cap `65536`) covers both thinking and the Markdown output. Thinking defaults to **None — thinking off** (`reasoning_effort: "none"` + `chat_template_kwargs.enable_thinking: false`). When thinking is enabled, **Max thinking tokens** (`0` = Halogen's answer room) can bound reasoning before Halogen closes the think block cleanly.
- **Sampling presets:**
  - **Greedy (`temperature: 0`, default):** Uses Halogen's byte-identical MTP + PLD speculative path and omits filters, penalties, and seed (which Halogen rejects with HTTP 400 at `temperature: 0`).
  - **Qwen card non-thinking:** `temperature: 0.7`, `top_p: 0.80`, `top_k: 20`, `presence_penalty: 1.5`, `repetition_penalty: 1.0`.
  - **Qwen card thinking:** `temperature: 1.0`, `top_p: 0.95`, `top_k: 20`, `presence_penalty: 0`, `repetition_penalty: 1.0`.
  - **Server defaults:** Omits sampling fields so server-side `HALOGEN_TEMPERATURE` / `HALOGEN_TOP_*` apply.
- **Prompt cache & session handles:**
  - **Prefix cache (`no_store` targets, default):** Warms the shared instructions once, then sends `prompt_cache_policy: "no_store"` on batches so finished page transcriptions do not evict the shared prefix.
  - **Session fork (`X-Halogen-Keep` / `X-Halogen-From`):** Keeps a named KV prefix handle before starting workers, replays the kept assistant acknowledgement so every worker gets `X-Halogen-From: used` with `prompt_cache_policy: "no_store"`, and releases the handle via `DELETE /halogen/handles/{name}` when the run finishes, cancels, or closes.
  - **Standard:** Uses Halogen's default `HALOGEN_PROMPT_CACHE=2` behavior without `no_store`.
- **Live telemetry & power management:** Requests `"return_progress": true` to stream prefill progress (`prompt_progress`) before output begins, plus per-batch and run-wide cache hit %, MTP acceptance (`draft_n_accepted / draft_n`), reasoning token counts, `reasoning_closed_by`, `X-Halogen-From` status, and live `/cache` KV pool occupancy. On Linux, active runs acquire a `systemd-inhibit` sleep lock (optional toggle).

## Development checks

Run JavaScript unit and loop-detector tests:

```bash
npm test
```

Run Rust backend tests:

```bash
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Run the Playwright UI smoke test (against the mock backend):

```bash
CHROMIUM_PATH=/usr/bin/chromium node scripts/test-ui.js
```

## License

MuPDF is AGPL-3.0, so DocProc4 Halogen is distributed under `AGPL-3.0-or-later` (`LICENSE`).
