//! DocProc4 Halogen — Tauri backend.
//!
//! Thin bridge between the webview UI and peonist-ai/halogen-flash-server:
//!   - GET /health, GET /v1/models, GET /cache
//!   - POST /v1/chat/completions (SSE streaming with prompt_progress, timings, usage, X-Halogen-From)
//!   - X-Halogen-Keep / X-Halogen-From session handles and DELETE /halogen/handles/{name}
//!   - POST /v1/messages/count_tokens for exact image token budget measurement
//! plus MuPDF/pdf.js PDF rendering, settings/instruction persistence, native
//! save dialogs, atomic run recovery, local system stats, and Linux sleep inhibition.

mod halogen;
mod power;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tokio::task::AbortHandle;

struct RenderSession {
    id: String,
    dir: PathBuf,
    file_name: String,
    /// Pixels per full-size page: the loaded model's measured/configured image budget.
    target_px: u64,
    /// Per-page MuPDF resolution that hits `target_px` (empty for pdf.js sessions).
    page_dpi: Vec<f64>,
    page_count: usize,
    /// Efficient mode: full-size pages are rendered just before sending and deleted after.
    lazy: bool,
    /// Rendered by MuPDF (can render pages itself) rather than pdf.js in the webview.
    native: bool,
}

pub(crate) struct AppState {
    pub(crate) http: reqwest::Client,
    aborts: Mutex<HashMap<String, AbortHandle>>,
    /// Previous /proc/stat totals, used to calculate local CPU utilization.
    cpu_sample: Mutex<Option<(u64, u64)>>,
    /// (base_url, api_key) of the last server contact — used to release active fork handles on exit.
    last_server: Mutex<(String, String)>,
    /// Active X-Halogen-Keep session handle name to release if the app closes mid-run.
    pub(crate) active_handle: Mutex<Option<String>>,
    /// The active PDF render cache. Page PNGs live here, never in the webview.
    render_session: Mutex<Option<RenderSession>>,
    /// Serializes on-demand full-size MuPDF renders.
    render_lock: Mutex<()>,
}

/// Normalize a server root URL. Users commonly paste OpenAI's full API base
/// (for example http://localhost:8731/v1); commands append /v1 themselves,
/// so remove that trailing version segment to avoid /v1/v1/models.
pub(crate) fn normalize(base: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    base.strip_suffix("/v1")
        .or_else(|| base.strip_suffix("/V1"))
        .unwrap_or(base)
        .trim_end_matches('/')
        .to_string()
}

pub(crate) fn authed(req: reqwest::RequestBuilder, key: &str) -> reqwest::RequestBuilder {
    if key.is_empty() {
        req
    } else {
        req.bearer_auth(key)
    }
}

pub(crate) fn remember(state: &State<AppState>, base: &str, key: &str) {
    *state.last_server.lock().unwrap() = (normalize(base), key.to_string());
}

// ---------------------------------------------------------------------------
// Halogen & OpenAI-compatible server endpoints
// ---------------------------------------------------------------------------

/// Checks /health (halogen-flash-server), /v1/health, then falls back to /v1/models.
#[tauri::command]
async fn health(
    state: State<'_, AppState>,
    base_url: String,
    api_key: String,
) -> Result<Value, String> {
    remember(&state, &base_url, &api_key);
    let base = normalize(&base_url);
    for path in ["/health", "/v1/health"] {
        let probe = authed(state.http.get(format!("{base}{path}")), &api_key)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if probe.status().is_success() {
            let mut body: Value = probe.json().await.map_err(|e| e.to_string())?;
            if !body.is_object() {
                body = json!({});
            }
            body["status"] = json!("ok");
            body["supports_model_management"] = json!(false);
            return Ok(body);
        }
        if !matches!(probe.status().as_u16(), 404 | 405) {
            let status = probe.status();
            return Err(format!(
                "HTTP {status}: {}",
                probe.text().await.unwrap_or_default()
            ));
        }
    }
    let resp = authed(state.http.get(format!("{base}/v1/models")), &api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(format!(
            "HTTP {status}: {}",
            resp.text().await.unwrap_or_default()
        ));
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let models = body
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let loaded = if models.len() == 1 {
        models[0]
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
    } else {
        None
    };
    Ok(
        json!({"status":"ok", "provider":"OpenAI-compatible server", "supports_model_management":false, "model_loaded":loaded, "all_models_loaded":[]}),
    )
}

/// Returns the raw `data` array from GET /v1/models.
#[tauri::command]
async fn list_models(
    state: State<'_, AppState>,
    base_url: String,
    api_key: String,
) -> Result<Value, String> {
    remember(&state, &base_url, &api_key);
    let url = format!("{}/v1/models", normalize(&base_url));
    let resp = authed(state.http.get(&url), &api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(format!(
            "HTTP {status}: {}",
            resp.text().await.unwrap_or_default()
        ));
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(body.get("data").cloned().unwrap_or_else(|| json!([])))
}

fn read_u64(path: &Path) -> Option<u64> {
    fs::read_to_string(path).ok()?.trim().parse().ok()
}

fn meminfo_kib(contents: &str, field: &str) -> Option<u64> {
    contents.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if key != field {
            return None;
        }
        value.split_whitespace().next()?.parse().ok()
    })
}

fn local_memory_gb() -> Option<f64> {
    let info = fs::read_to_string("/proc/meminfo").ok()?;
    let total = meminfo_kib(&info, "MemTotal")?;
    let available = meminfo_kib(&info, "MemAvailable")?;
    Some((total.saturating_sub(available)) as f64 / 1_048_576.0)
}

fn local_cpu_sample() -> Option<(u64, u64)> {
    let line = fs::read_to_string("/proc/stat")
        .ok()?
        .lines()
        .next()?
        .to_owned();
    let values: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|v| v.parse().ok())
        .collect();
    if values.len() < 4 {
        return None;
    }
    let total = values.iter().sum();
    // idle plus iowait are both non-busy CPU time.
    let idle = values[3] + values.get(4).copied().unwrap_or(0);
    Some((total, idle))
}

fn local_amd_gpu_stats() -> Value {
    let Ok(cards) = fs::read_dir("/sys/class/drm") else {
        return json!({});
    };
    for card in cards.flatten() {
        let name = card.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("card") || !name[4..].chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let device = card.path().join("device");
        let is_amd = fs::read_to_string(device.join("vendor"))
            .ok()
            .map(|v| v.trim() == "0x1002")
            .unwrap_or(false);
        if !is_amd {
            continue;
        }
        let gb =
            |name: &str| read_u64(&device.join(name)).map(|bytes| bytes as f64 / 1_073_741_824.0);
        return json!({
            "gpu_percent": read_u64(&device.join("gpu_busy_percent")),
            "vram_gb": gb("mem_info_vram_used"),
            "vram_total_gb": gb("mem_info_vram_total"),
            // On AMD APUs/TTM this is the GTT-backed shared system-memory pool.
            "gtt_gb": gb("mem_info_gtt_used"),
            "gtt_total_gb": gb("mem_info_gtt_total"),
            "gpu_name": fs::read_to_string(device.join("uevent")).ok()
                .and_then(|s| s.lines().find_map(|line| line.strip_prefix("PCI_ID=").map(str::to_owned))),
        });
    }
    json!({})
}

/// Local machine telemetry (CPU, RAM, AMD GPU/GTT).
#[tauri::command]
async fn system_stats(state: State<'_, AppState>) -> Result<Value, String> {
    let cpu_percent = local_cpu_sample().and_then(|(total, idle)| {
        let mut previous = state.cpu_sample.lock().ok()?;
        let percent = previous.and_then(|(old_total, old_idle)| {
            let total_delta = total.checked_sub(old_total)?;
            let idle_delta = idle.checked_sub(old_idle)?;
            (total_delta > 0).then(|| {
                100.0 * (total_delta.saturating_sub(idle_delta)) as f64 / total_delta as f64
            })
        });
        *previous = Some((total, idle));
        percent
    });
    let mut stats = json!({
        "cpu_percent": cpu_percent,
        "memory_gb": local_memory_gb(),
        "telemetry_source": "local machine",
    });
    if let (Some(dest), Some(gpu)) = (stats.as_object_mut(), local_amd_gpu_stats().as_object()) {
        dest.extend(gpu.clone());
    }
    Ok(stats)
}

// ---------------------------------------------------------------------------
// PDF page cache: MuPDF native rendering, or PNGs rendered by pdf.js in the webview
// ---------------------------------------------------------------------------

fn session_id() -> Result<String, String> {
    Ok(format!(
        "{RENDER_PREFIX}{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    ))
}

const RENDER_PREFIX: &str = "docproc4-halogen-";

/// Where page PNGs are cached. /tmp is often tmpfs (RAM-backed), so Efficient
/// mode puts the cache in the app cache dir on real disk instead.
fn render_root(app: &AppHandle, efficient: bool) -> Result<PathBuf, String> {
    if efficient {
        Ok(app
            .path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?
            .join("render"))
    } else {
        Ok(std::env::temp_dir())
    }
}

/// Remove render caches left behind by a crash or forced quit.
fn remove_stale_render_caches(app: &AppHandle) {
    let Ok(root) = render_root(app, true) else {
        return;
    };
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(RENDER_PREFIX) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn install_render_session(state: &State<AppState>, session: RenderSession) {
    let old = state.render_session.lock().unwrap().replace(session);
    if let Some(old) = old {
        let _ = fs::remove_dir_all(old.dir);
    }
}

fn page_metadata(session: &RenderSession) -> Value {
    json!({ "session_id": session.id, "target_px": session.target_px, "pages": (0..session.page_count).map(|i| json!({
        "index": i, "label": format!("{} · page {}", session.file_name, i + 1),
        "dpi": session.page_dpi.get(i).map(|d| d.round()), "session_id": session.id,
    })).collect::<Vec<_>>() })
}

fn page_file(dir: &Path, index: usize, full: bool) -> PathBuf {
    let kind = if full { "page" } else { "thumb" };
    dir.join(format!("{kind}-{}.png", index + 1))
}

/// Header value from a binary-body IPC request.
fn ipc_header(request: &tauri::ipc::Request, name: &str) -> Result<String, String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| format!("missing {name} header"))
}

/// PDFs and page PNGs arrive as raw bytes, avoiding base64 copies in the webview.
fn ipc_bytes<'a>(request: &'a tauri::ipc::Request) -> Result<&'a [u8], String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes),
        _ => Err("expected a binary request body".to_string()),
    }
}

/// Open a PDF with the bundled MuPDF library. MuPDF contexts are per thread,
/// so each blocking task opens its own `Document`.
fn open_pdf(input: &Path) -> Result<mupdf::Document, String> {
    let path = input
        .to_str()
        .ok_or_else(|| format!("unsupported characters in path {}", input.display()))?;
    mupdf::Document::open(path).map_err(|e| format!("MuPDF couldn't open the PDF: {e}"))
}

/// Page sizes in points, in page order (rotation applied; the area is what matters).
fn pdf_page_sizes(doc: &mupdf::Document) -> Result<Vec<(f64, f64)>, String> {
    let count = doc.page_count().map_err(|e| e.to_string())?;
    (0..count)
        .map(|i| {
            let b = doc
                .load_page(i)
                .and_then(|page| page.bounds())
                .map_err(|e| format!("MuPDF couldn't read page {}: {e}", i + 1))?;
            Ok((f64::from(b.x1 - b.x0).abs(), f64::from(b.y1 - b.y0).abs()))
        })
        .collect()
}

/// Render page `index` (0-based) at `scale` (1.0 = 72 DPI) to a PNG at `out`.
/// Writes to a temporary name first so readers never see a partial file.
fn render_page_png(doc: &mupdf::Document, index: usize, scale: f32, out: &Path) -> Result<(), String> {
    let fail = |e: mupdf::Error| format!("MuPDF couldn't render page {}: {e}", index + 1);
    let page = doc.load_page(index as i32).map_err(fail)?;
    // Annotations and form fields are drawn too (show_extras).
    let pixmap = page
        .to_pixmap(
            &mupdf::Matrix::new_scale(scale, scale),
            &mupdf::Colorspace::device_rgb(),
            false,
            true,
        )
        .map_err(fail)?;
    let part = out.with_extension("part.png");
    let mut file = std::io::BufWriter::new(fs::File::create(&part).map_err(|e| e.to_string())?);
    pixmap.write_to(&mut file, mupdf::ImageFormat::PNG).map_err(fail)?;
    drop(file);
    fs::rename(&part, out).map_err(|e| e.to_string())
}

/// Thumbnail width in pixels.
const THUMB_WIDTH: f64 = 220.0;

/// Default and bounds for the per-page pixel target.
const MIN_TARGET_PX: u64 = 250_000;
const MAX_TARGET_PX: u64 = 40_000_000;
/// Keep tiny pages from exploding and giant pages from becoming unreadable.
const MIN_DPI: f64 = 30.0;
const MAX_DPI: f64 = 600.0;

fn parse_target_px(value: &str) -> Result<u64, String> {
    let px: u64 = value
        .parse()
        .map_err(|e| format!("invalid x-target-px header: {e}"))?;
    Ok(px.clamp(MIN_TARGET_PX, MAX_TARGET_PX))
}

/// Resolution at which a page of `w`×`h` points renders to about `target_px` pixels.
fn dpi_for_target(w_pt: f64, h_pt: f64, target_px: u64) -> f64 {
    let area_pt = (w_pt * h_pt).max(1.0);
    (72.0 * (target_px as f64 / area_pt).sqrt()).clamp(MIN_DPI, MAX_DPI)
}

fn image_from_session(
    state: &State<AppState>,
    session_id: &str,
    index: usize,
    full: bool,
) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let path = {
        let guard = state.render_session.lock().unwrap();
        let session = guard
            .as_ref()
            .filter(|s| s.id == session_id)
            .ok_or_else(|| "PDF render cache is no longer available".to_string())?;
        if index >= session.page_count {
            return Err("invalid PDF page index".to_string());
        }
        page_file(&session.dir, index, full)
    };
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}

/// Efficient mode: full-size pages are deleted once they have been sent and
/// are rendered again on demand if a batch is re-run.
fn discard_sent_pages(state: &State<AppState>, session_id: &str, indices: &[usize]) {
    let guard = state.render_session.lock().unwrap();
    if let Some(session) = guard.as_ref().filter(|s| s.id == session_id && s.lazy) {
        for &index in indices {
            let _ = fs::remove_file(page_file(&session.dir, index, true));
        }
    }
}

/// Render a PDF with the bundled MuPDF library into an app-owned cache.
#[tauri::command]
async fn render_pdf_mupdf(
    app: AppHandle,
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<Value, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let file_name = STANDARD
        .decode(ipc_header(&request, "x-file-name")?)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .ok_or("invalid x-file-name header")?;
    let target_px = parse_target_px(&ipc_header(&request, "x-target-px")?)?;
    let lazy = ipc_header(&request, "x-efficient").is_ok_and(|v| v == "1");
    let bytes = ipc_bytes(&request)?;
    let id = session_id()?;
    let dir = render_root(&app, lazy)?.join(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let input = dir.join("input.pdf");
    if let Err(e) = fs::write(&input, bytes) {
        let _ = fs::remove_dir_all(&dir);
        return Err(e.to_string());
    }
    let session = tokio::task::spawn_blocking(move || -> Result<RenderSession, String> {
        let result = (|| -> Result<RenderSession, String> {
            let doc = open_pdf(&input)?;
            let sizes = pdf_page_sizes(&doc)?;
            if sizes.is_empty() {
                return Err("the PDF has no pages".to_string());
            }
            let page_dpi: Vec<f64> = sizes
                .iter()
                .map(|&(w, h)| dpi_for_target(w, h, target_px))
                .collect();
            for (i, &(w, _)) in sizes.iter().enumerate() {
                if !lazy {
                    render_page_png(&doc, i, (page_dpi[i] / 72.0) as f32, &page_file(&dir, i, true))?;
                }
                render_page_png(
                    &doc,
                    i,
                    (THUMB_WIDTH / w.max(1.0)) as f32,
                    &page_file(&dir, i, false),
                )?;
            }
            let count = sizes.len();
            Ok(RenderSession {
                id,
                dir: dir.clone(),
                file_name,
                target_px,
                page_dpi,
                page_count: count,
                lazy,
                native: true,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&dir);
        }
        result
    })
    .await
    .map_err(|e| format!("MuPDF renderer task failed: {e}"))??;
    let metadata = page_metadata(&session);
    install_render_session(&state, session);
    Ok(metadata)
}

/// Start the PDF.js fallback cache. A new cache replaces the prior document.
#[tauri::command]
fn begin_pdf_render(
    app: AppHandle,
    state: State<'_, AppState>,
    file_name: String,
    target_px: u64,
    efficient: Option<bool>,
) -> Result<Value, String> {
    let lazy = efficient.unwrap_or(false);
    let id = session_id()?;
    let dir = render_root(&app, lazy)?.join(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    install_render_session(
        &state,
        RenderSession {
            id: id.clone(),
            dir,
            file_name,
            target_px,
            page_dpi: Vec::new(),
            page_count: 0,
            lazy,
            native: false,
        },
    );
    Ok(json!({"session_id": id}))
}

/// Store one pdf.js-rendered PNG. Raw body; headers x-session, x-index, x-kind (full|thumb).
#[tauri::command]
async fn store_page_png(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let session_id = ipc_header(&request, "x-session")?;
    let index: usize = ipc_header(&request, "x-index")?
        .parse()
        .map_err(|e| format!("invalid x-index header: {e}"))?;
    let full = ipc_header(&request, "x-kind")? == "full";
    let bytes = ipc_bytes(&request)?;
    let mut session = state.render_session.lock().unwrap();
    let s = session
        .as_mut()
        .filter(|s| s.id == session_id)
        .ok_or_else(|| "PDF render was superseded".to_string())?;
    fs::write(page_file(&s.dir, index, full), bytes).map_err(|e| e.to_string())?;
    if !full {
        s.page_count = s.page_count.max(index + 1);
    }
    Ok(())
}

/// Make sure full-size PNGs exist for `indices`.
#[tauri::command]
async fn ensure_full_pages(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    indices: Vec<usize>,
) -> Result<Vec<usize>, String> {
    let (dir, page_dpi, native) = {
        let guard = state.render_session.lock().unwrap();
        let session = guard
            .as_ref()
            .filter(|s| s.id == session_id)
            .ok_or_else(|| "PDF render cache is no longer available".to_string())?;
        if indices.iter().any(|&i| i >= session.page_count) {
            return Err("invalid PDF page index".to_string());
        }
        (session.dir.clone(), session.page_dpi.clone(), session.native)
    };
    let missing: Vec<usize> = indices
        .into_iter()
        .filter(|&i| !page_file(&dir, i, true).exists())
        .collect();
    if missing.is_empty() || !native {
        return Ok(missing);
    }
    tokio::task::spawn_blocking(move || -> Result<Vec<usize>, String> {
        let state = app.state::<AppState>();
        let _render = state.render_lock.lock().unwrap();
        let doc = open_pdf(&dir.join("input.pdf"))?;
        for index in missing {
            let target = page_file(&dir, index, true);
            if target.exists() {
                continue;
            }
            let dpi = page_dpi.get(index).ok_or("missing page size")?;
            render_page_png(&doc, index, (dpi / 72.0) as f32, &target)?;
        }
        Ok(Vec::new())
    })
    .await
    .map_err(|e| format!("MuPDF renderer task failed: {e}"))?
}

#[tauri::command]
fn page_thumbnail(
    state: State<'_, AppState>,
    session_id: String,
    index: usize,
) -> Result<String, String> {
    image_from_session(&state, &session_id, index, false)
}

#[tauri::command]
fn page_preview(
    state: State<'_, AppState>,
    session_id: String,
    index: usize,
) -> Result<String, String> {
    image_from_session(&state, &session_id, index, true)
}

#[tauri::command]
fn clear_pdf_render(state: State<'_, AppState>, session_id: Option<String>) {
    let old = {
        let mut guard = state.render_session.lock().unwrap();
        if session_id
            .as_deref()
            .is_some_and(|id| guard.as_ref().is_none_or(|s| s.id != id))
        {
            None
        } else {
            guard.take()
        }
    };
    if let Some(session) = old {
        let _ = fs::remove_dir_all(session.dir);
    }
}

// ---------------------------------------------------------------------------
// Streaming chat completions
// ---------------------------------------------------------------------------

const OPEN_MARKERS: [&str; 2] = ["◁think▷", "<think>"];
const CLOSE_MARKERS: [&str; 2] = ["◁/think▷", "</think>"];
/// Longest marker prefix we might see split across chunks (bytes).
const HOLD_BACK: usize = 11;

/// Reported when the server stops generation with finish_reason=length —
/// the output is incomplete even though the request "succeeded".
const TRUNCATED_MSG: &str = "output truncated: the model hit the token budget (finish_reason=length). \
On halogen-flash-server, max_completion_tokens covers both thinking and the Markdown transcription. \
Raise Max completion tokens (up to 65,536), set a Max thinking tokens cap, lower Thinking effort, or use fewer pages per batch.";

/// Largest index `<= i` that is a UTF-8 char boundary of `s`.
pub(crate) fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Incrementally split a model's content stream into output vs thinking text.
fn drain_content(buf: &mut String, in_thinking: &mut bool, emit: &mut dyn FnMut(&str, String)) {
    loop {
        let markers: &[&str] = if *in_thinking {
            &CLOSE_MARKERS
        } else {
            &OPEN_MARKERS
        };
        let found = markers
            .iter()
            .filter_map(|m| buf.find(m).map(|p| (p, m.len())))
            .min_by_key(|(p, _)| *p);
        match found {
            Some((pos, mlen)) => {
                if pos > 0 {
                    let text: String = buf.drain(..pos).collect();
                    if !text.is_empty() {
                        emit(if *in_thinking { "thinking" } else { "output" }, text);
                    }
                }
                buf.drain(..mlen);
                *in_thinking = !*in_thinking;
            }
            None => {
                if buf.len() > HOLD_BACK {
                    let keep = floor_char_boundary(buf, buf.len() - HOLD_BACK);
                    if keep > 0 {
                        let text: String = buf.drain(..keep).collect();
                        if !text.is_empty() {
                            emit(if *in_thinking { "thinking" } else { "output" }, text);
                        }
                    }
                }
                return;
            }
        }
    }
}

fn flush_content(buf: &mut String, in_thinking: bool, emit: &mut dyn FnMut(&str, String)) {
    if !buf.is_empty() {
        emit(
            if in_thinking { "thinking" } else { "output" },
            std::mem::take(buf),
        );
    }
}

/// Extract an error message from OpenAI-style {"error": {...}} or
/// {"error": "..."} bodies. Returns None when there is no error field.
pub(crate) fn error_message(v: &Value) -> Option<String> {
    let err = v.get("error")?;
    if let Some(m) = err.get("message").and_then(|m| m.as_str()) {
        return Some(m.to_string());
    }
    if let Some(m) = err.as_str() {
        return Some(m.to_string());
    }
    Some(err.to_string())
}

fn merge_non_null(dest: &mut serde_json::Map<String, Value>, src: &serde_json::Map<String, Value>) {
    for (key, value) in src {
        if value.is_null() {
            continue;
        }
        if let Some(src_obj) = value.as_object() {
            if let Some(Value::Object(dest_obj)) = dest.get_mut(key) {
                merge_non_null(dest_obj, src_obj);
                continue;
            }
        }
        dest.insert(key.clone(), value.clone());
    }
}

/// Merge request-local `timings` and `usage` across SSE chunks without letting
/// later partial/null objects erase earlier fields (e.g. draft counts or token details).
fn collect_stream_stats(timings: &mut Option<Value>, usage: &mut Option<Value>, event: &Value) {
    if let Some(t) = event.get("timings").and_then(Value::as_object) {
        if t.values().any(|v| !v.is_null()) {
            let dest = timings.get_or_insert_with(|| json!({}));
            merge_non_null(dest.as_object_mut().unwrap(), t);
        }
    }
    if let Some(u) = event.get("usage").and_then(Value::as_object) {
        if u.values().any(|v| !v.is_null()) {
            let dest = usage.get_or_insert_with(|| json!({}));
            merge_non_null(dest.as_object_mut().unwrap(), u);
        }
    }
}

fn validate_stream_end(
    saw_data: bool,
    saw_tokens: bool,
    finish_reason: Option<&str>,
) -> Result<(), String> {
    if !saw_data {
        return Err("empty response from server (no SSE data)".to_string());
    }
    if !saw_tokens {
        return Err("model returned no content".to_string());
    }
    if finish_reason == Some("length") {
        return Err(TRUNCATED_MSG.to_string());
    }
    Ok(())
}

/// Append image parts to the final message's content array, supporting both
/// `[system, user]` (`no_store`/`standard`) and `[system, user, assistant, user]` (`fork`).
fn attach_page_images(payload: &mut Value, images: Vec<Value>) -> Result<(), String> {
    let content = payload
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .and_then(|arr| arr.last_mut())
        .and_then(|msg| msg.get_mut("content"))
        .and_then(Value::as_array_mut)
        .ok_or("invalid chat payload")?;
    content.extend(images);
    Ok(())
}

/// POST /v1/chat/completions with stream=true. Events emitted as `chat-stream`:
/// {id, kind: progress|thinking|output|stats|done|error, ...}.
#[tauri::command]
async fn chat_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    base_url: String,
    api_key: String,
    mut payload: Value,
    page_indices: Option<Vec<usize>>,
    headers: Option<HashMap<String, String>>,
) -> Result<(), String> {
    if let Some(indices) = page_indices {
        let session_id = payload
            .get("session_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or("missing PDF render session")?;
        let images: Result<Vec<Value>, String> = indices
            .iter()
            .map(|&index| {
                image_from_session(&state, &session_id, index, true)
                    .map(|url| json!({"type":"image_url","image_url":{"url":url}}))
            })
            .collect();
        attach_page_images(&mut payload, images?)?;
        discard_sent_pages(&state, &session_id, &indices);
        if let Some(obj) = payload.as_object_mut() {
            obj.remove("session_id");
        }
    }
    remember(&state, &base_url, &api_key);
    let base = normalize(&base_url);
    let client = state.http.clone();

    let task_id = id.clone();
    let task_app = app.clone();
    let handle = tokio::spawn(async move {
        use futures_util::StreamExt;

        let app = task_app;
        let emit = |kind: &str, extra: Value| {
            let mut obj = json!({ "id": task_id, "kind": kind });
            if let (Some(o), Some(e)) = (obj.as_object_mut(), extra.as_object()) {
                for (k, v) in e {
                    o.insert(k.clone(), v.clone());
                }
            }
            let _ = app.emit("chat-stream", obj);
        };

        let mut halogen_from: Option<String> = None;
        let result: Result<(Option<Value>, Option<Value>), String> = async {
            let url = format!("{base}/v1/chat/completions");
            let mut req = authed(client.post(&url), &api_key).json(&payload);
            if let Some(extra) = headers {
                for (k, v) in extra {
                    let k = k.trim();
                    let v = v.trim();
                    if !k.is_empty() && !v.is_empty() {
                        req = req.header(k, v);
                    }
                }
            }
            let resp = req.send().await.map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                let end = floor_char_boundary(&body, body.len().min(400));
                return Err(format!("HTTP {status}: {}", &body[..end]));
            }
            halogen_from = resp
                .headers()
                .get("x-halogen-from")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);

            let mut stream = resp.bytes_stream();
            let mut pending: Vec<u8> = Vec::new();
            let mut buf = String::new();
            let mut content_buf = String::new();
            let mut in_thinking = false;
            let mut saw_data = false;
            let mut saw_tokens = false;
            let mut timings: Option<Value> = None;
            let mut usage: Option<Value> = None;
            let mut finish_reason: Option<String> = None;
            let mut stream_ended = false;
            'events: loop {
                if !stream_ended {
                    match stream.next().await {
                        Some(chunk) => {
                            let chunk = chunk.map_err(|e| e.to_string())?;
                            pending.extend_from_slice(&chunk);
                            loop {
                                match std::str::from_utf8(&pending) {
                                    Ok(s) => {
                                        buf.push_str(s);
                                        pending.clear();
                                        break;
                                    }
                                    Err(e) => {
                                        let valid = e.valid_up_to();
                                        buf.push_str(
                                            std::str::from_utf8(&pending[..valid]).unwrap(),
                                        );
                                        match e.error_len() {
                                            None => {
                                                pending.drain(..valid);
                                                break;
                                            }
                                            Some(bad) => {
                                                buf.push('\u{FFFD}');
                                                pending.drain(..valid + bad);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        None => {
                            stream_ended = true;
                            if !pending.is_empty() {
                                buf.push_str(&String::from_utf8_lossy(&pending));
                                pending.clear();
                            }
                            if !buf.trim().is_empty() && !buf.ends_with("\n\n") {
                                buf.push_str("\n\n");
                            }
                        }
                    }
                }
                buf = buf.replace("\r\n", "\n");
                while let Some(pos) = buf.find("\n\n") {
                    let event: String = buf.drain(..pos).collect();
                    buf.drain(..2);
                    for raw_line in event.lines() {
                        let line = raw_line.trim();
                        if line.is_empty() {
                            continue;
                        }
                        let Some(data) = line.strip_prefix("data:") else {
                            if line.starts_with('{') {
                                if let Ok(v) = serde_json::from_str::<Value>(line) {
                                    if let Some(msg) = error_message(&v) {
                                        return Err(msg);
                                    }
                                }
                            }
                            continue;
                        };
                        saw_data = true;
                        let data = data.trim();
                        if data == "[DONE]" {
                            break 'events;
                        }
                        let Ok(v) = serde_json::from_str::<Value>(data) else {
                            continue;
                        };
                        if let Some(msg) = error_message(&v) {
                            return Err(msg);
                        }
                        if let Some(pp) = v.get("prompt_progress").filter(|p| p.is_object()) {
                            emit("progress", json!({ "progress": pp }));
                        }
                        collect_stream_stats(&mut timings, &mut usage, &v);
                        if let Some(fr) = v
                            .pointer("/choices/0/finish_reason")
                            .and_then(|x| x.as_str())
                        {
                            finish_reason = Some(fr.to_string());
                        }
                        if let Some(delta) = v.pointer("/choices/0/delta") {
                            if let Some(t) = delta.get("reasoning_content").and_then(|x| x.as_str())
                            {
                                if !t.is_empty() {
                                    saw_tokens = true;
                                    emit("thinking", json!({ "text": t }));
                                }
                            }
                            if let Some(t) = delta.get("content").and_then(|x| x.as_str()) {
                                if !t.is_empty() {
                                    saw_tokens = true;
                                    content_buf.push_str(t);
                                    drain_content(
                                        &mut content_buf,
                                        &mut in_thinking,
                                        &mut |kind, text| {
                                            emit(kind, json!({ "text": text }));
                                        },
                                    );
                                }
                            }
                        }
                    }
                }
                if stream_ended {
                    break;
                }
            }
            flush_content(&mut content_buf, in_thinking, &mut |kind, text| {
                emit(kind, json!({ "text": text }));
            });
            validate_stream_end(saw_data, saw_tokens, finish_reason.as_deref())?;
            Ok((timings, usage))
        }
        .await;

        match result {
            Ok((timings, usage)) => {
                if timings.is_some() || usage.is_some() || halogen_from.is_some() {
                    emit(
                        "stats",
                        json!({
                            "stats": timings,
                            "usage": usage,
                            "halogen_from": halogen_from,
                            "source": "request",
                        }),
                    );
                }
                emit("done", json!({}));
            }
            Err(e) => emit("error", json!({ "message": e })),
        }

        app.state::<AppState>()
            .aborts
            .lock()
            .unwrap()
            .remove(&task_id);
    });

    state
        .aborts
        .lock()
        .unwrap()
        .insert(id.clone(), handle.abort_handle());

    tokio::spawn(async move {
        if let Err(e) = handle.await {
            if e.is_panic() {
                let _ = app.emit(
                    "chat-stream",
                    json!({ "id": id, "kind": "error", "message": "internal error: stream task panicked" }),
                );
                app.state::<AppState>().aborts.lock().unwrap().remove(&id);
            }
        }
    });
    Ok(())
}

/// Translate the calibration messages to the Anthropic Messages token-count format.
fn token_count_payload(payload: &Value) -> Option<Value> {
    let mut messages = payload.get("messages")?.as_array()?.clone();
    for message in &mut messages {
        if let Some(parts) = message.get_mut("content")?.as_array_mut() {
            for part in parts {
                match part.get("type")?.as_str()? {
                    "text" => {}
                    "image_url" => {
                        let url = part.pointer("/image_url/url")?.as_str()?;
                        let (mime, data) = url.strip_prefix("data:")?.split_once(";base64,")?;
                        *part = json!({"type": "image", "source": {
                            "type": "base64", "media_type": mime, "data": data
                        }});
                    }
                    _ => return None,
                }
            }
        }
    }
    Some(json!({"model": payload.get("model")?, "messages": messages}))
}

/// Prefer counting without inference via `/v1/messages/count_tokens` (supported by
/// halogen-flash-server); fall back to `/v1/chat/completions` if unavailable.
async fn measure_tokens(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    payload: &Value,
) -> Result<u64, String> {
    if let Some(count_payload) = token_count_payload(payload) {
        let url = format!("{}/v1/messages/count_tokens", normalize(base_url));
        let mut req = authed(client.post(&url), api_key)
            .header("anthropic-version", "2023-06-01")
            .timeout(std::time::Duration::from_secs(15));
        if !api_key.is_empty() {
            req = req.header("x-api-key", api_key);
        }
        let resp = req
            .json(&count_payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let body = resp.text().await.map_err(|e| e.to_string())?;
        if status.is_success() {
            if let Ok(v) = serde_json::from_str::<Value>(&body) {
                if let Some(count) = v.get("input_tokens").and_then(Value::as_u64) {
                    return Ok(count);
                }
            }
        } else if !matches!(status.as_u16(), 400 | 404 | 405 | 415 | 422 | 501) {
            let end = floor_char_boundary(&body, body.len().min(400));
            return Err(format!("HTTP {status}: {}", &body[..end]));
        }
    }
    let url = format!("{}/v1/chat/completions", normalize(base_url));
    let resp = authed(client.post(&url), api_key)
        .json(payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let end = floor_char_boundary(&body, body.len().min(400));
        return Err(format!("HTTP {status}: {}", &body[..end]));
    }
    let v: Value =
        serde_json::from_str(&body).map_err(|e| format!("invalid JSON from server: {e}"))?;
    if let Some(msg) = error_message(&v) {
        return Err(msg);
    }
    v.pointer("/usage/prompt_tokens")
        .and_then(Value::as_u64)
        .ok_or_else(|| "server did not report usage.prompt_tokens".to_string())
}

#[tauri::command]
async fn measure_prompt_tokens(
    state: State<'_, AppState>,
    base_url: String,
    api_key: String,
    payload: Value,
) -> Result<u64, String> {
    remember(&state, &base_url, &api_key);
    measure_tokens(&state.http, &base_url, &api_key, &payload).await
}

#[tauri::command]
fn chat_cancel(state: State<'_, AppState>, id: String) {
    if let Some(h) = state.aborts.lock().unwrap().remove(&id) {
        h.abort();
    }
}

// ---------------------------------------------------------------------------
// Persistence (settings + instruction sets) in the app data dir
// ---------------------------------------------------------------------------

fn persist_path(app: &AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

fn read_json(app: &AppHandle, name: &str) -> Value {
    persist_path(app, name)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

#[tauri::command]
fn read_persisted(app: AppHandle) -> Result<Value, String> {
    Ok(json!({
        "settings": read_json(&app, "settings.json"),
        "instructions": read_json(&app, "instructions.json"),
    }))
}

#[tauri::command]
fn write_settings(app: AppHandle, data: Value) -> Result<(), String> {
    let s = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(persist_path(&app, "settings.json")?, s).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_instructions(app: AppHandle, data: Value) -> Result<(), String> {
    let s = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(persist_path(&app, "instructions.json")?, s).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Run recovery: finished batches are written to the app data dir as they
// complete, so a crash or kill doesn't lose them before the user saves.
// ---------------------------------------------------------------------------

const RECOVERY_FILE: &str = "last-run.json";
static RECOVERY_LOCK: Mutex<()> = Mutex::new(());

fn recovery_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("recovery");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_extension("json.tmp");
    let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(contents.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_recovery(app: AppHandle, data: Value) -> Result<(), String> {
    let s = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    let _guard = RECOVERY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    write_atomic(&recovery_dir(&app)?.join(RECOVERY_FILE), &s)
}

#[tauri::command]
fn read_recovery(app: AppHandle) -> Result<Value, String> {
    let path = recovery_dir(&app)?.join(RECOVERY_FILE);
    Ok(std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null))
}

#[tauri::command]
fn clear_recovery(app: AppHandle) -> Result<(), String> {
    let _guard = RECOVERY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = recovery_dir(&app)?.join(RECOVERY_FILE);
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Output saving via native dialogs
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct OutFile {
    name: String,
    content: String,
}

#[tauri::command]
fn save_outputs(merged: bool, files: Vec<OutFile>) -> Result<Value, String> {
    if files.is_empty() {
        return Ok(json!({ "saved": [] }));
    }
    if merged {
        let path = rfd::FileDialog::new()
            .add_filter("Markdown", &["md"])
            .set_file_name(&files[0].name)
            .save_file();
        match path {
            Some(p) => {
                std::fs::write(&p, &files[0].content).map_err(|e| e.to_string())?;
                Ok(json!({ "saved": [p.to_string_lossy()] }))
            }
            None => Ok(json!({ "saved": [] })),
        }
    } else {
        let dir = rfd::FileDialog::new().pick_folder();
        match dir {
            Some(d) => {
                let mut saved = Vec::new();
                for f in &files {
                    let p = d.join(&f.name);
                    std::fs::write(&p, &f.content).map_err(|e| e.to_string())?;
                    saved.push(p.to_string_lossy().to_string());
                }
                Ok(json!({ "saved": saved }))
            }
            None => Ok(json!({ "saved": [] })),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calibration_count_endpoint_and_legacy_fallback() {
        use std::io::{BufRead, Read, Write};
        for (status, body, fallback) in [
            ("200 OK", r#"{"input_tokens":16444}"#, false),
            ("404 Not Found", "missing", true),
            ("405 Method Not Allowed", "unsupported", true),
            ("200 OK", "<html>runner</html>", true),
            ("401 Unauthorized", "denied", false),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let mut requests = Vec::new();
                for i in 0..if fallback { 2 } else { 1 } {
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                    let mut socket = loop {
                        match listener.accept() {
                            Ok((socket, _)) => break socket,
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                assert!(std::time::Instant::now() < deadline, "missing request");
                                std::thread::sleep(std::time::Duration::from_millis(5));
                            }
                            Err(e) => panic!("{e}"),
                        }
                    };
                    socket
                        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                        .unwrap();
                    let mut reader = std::io::BufReader::new(&mut socket);
                    let mut path = String::new();
                    reader.read_line(&mut path).unwrap();
                    let mut length = 0;
                    let mut headers = Vec::new();
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        if line == "\r\n" {
                            break;
                        }
                        if let Some(n) = line.to_lowercase().strip_prefix("content-length:") {
                            length = n.trim().parse::<usize>().unwrap();
                        }
                        headers.push(line.trim().to_string());
                    }
                    let mut bytes = vec![0; length];
                    reader.read_exact(&mut bytes).unwrap();
                    requests.push((
                        path,
                        headers,
                        serde_json::from_slice::<Value>(&bytes).unwrap(),
                    ));
                    let (code, response) = if i == 0 {
                        (status, body)
                    } else {
                        ("200 OK", r#"{"usage":{"prompt_tokens":16444}}"#)
                    };
                    write!(
                        socket,
                        "HTTP/1.1 {code}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                        response.len()
                    )
                    .unwrap();
                }
                requests
            });
            let payload = json!({"model":"halogen-qwen3.8-flash-next", "max_tokens":1, "stream":false,
            "messages":[{"role":"user", "content":[
                {"type":"text", "text":"Count this"},
                {"type":"image_url", "image_url":{"url":"data:image/png;base64,YWJj"}}
            ]}]});
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let result = runtime.block_on(measure_tokens(
                &reqwest::Client::builder().no_proxy().build().unwrap(),
                &url,
                "",
                &payload,
            ));
            if status.starts_with("401") {
                assert!(result.unwrap_err().contains("401"));
            } else {
                assert_eq!(result.unwrap(), 16444);
            }
            let requests = server.join().unwrap();
            assert!(requests[0].0.starts_with("POST /v1/messages/count_tokens "));
            assert!(requests[0]
                .1
                .iter()
                .any(|h| h.eq_ignore_ascii_case("anthropic-version: 2023-06-01")));
            assert_eq!(
                requests[0].2["messages"][0]["content"][1],
                json!({
                    "type":"image", "source":{"type":"base64", "media_type":"image/png", "data":"YWJj"}
                })
            );
            assert!(requests[0].2.get("max_tokens").is_none());
            if fallback {
                assert!(requests[1].0.starts_with("POST /v1/chat/completions "));
                assert_eq!(requests[1].2, payload);
            }
        }
    }

    #[test]
    fn count_tokens_sends_anthropic_headers() {
        use std::io::{BufRead, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(&mut socket);
            let mut req_line = String::new();
            reader.read_line(&mut req_line).unwrap();
            let mut length = 0;
            let mut headers = Vec::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(n) = line.to_lowercase().strip_prefix("content-length:") {
                    length = n.trim().parse::<usize>().unwrap();
                }
                headers.push(line.trim().to_string());
            }
            let mut bytes = vec![0; length];
            reader.read_exact(&mut bytes).unwrap();
            let body = r#"{"input_tokens":42}"#;
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            (req_line, headers)
        });
        let payload = json!({"model": "halogen-qwen3.8-flash-next", "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]});
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let count = runtime
            .block_on(measure_tokens(
                &reqwest::Client::builder().no_proxy().build().unwrap(),
                &url,
                "hal-secret",
                &payload,
            ))
            .unwrap();
        assert_eq!(count, 42);
        let (req_line, headers) = server.join().unwrap();
        assert!(req_line.starts_with("POST /v1/messages/count_tokens "));
        assert!(headers
            .iter()
            .any(|h| h.eq_ignore_ascii_case("anthropic-version: 2023-06-01")));
        assert!(headers
            .iter()
            .any(|h| h.eq_ignore_ascii_case("x-api-key: hal-secret")));
        assert!(headers
            .iter()
            .any(|h| h.eq_ignore_ascii_case("authorization: Bearer hal-secret")));
    }

    #[test]
    fn attach_page_images_targets_final_user_message() {
        let mut standard = json!({
            "messages": [
                { "role": "system", "content": "Transcribe" },
                { "role": "user", "content": [] }
            ]
        });
        attach_page_images(
            &mut standard,
            vec![json!({"type": "image_url", "image_url": {"url": "data:image/png;base64,QQ=="}})],
        )
        .unwrap();
        assert_eq!(standard["messages"][1]["content"].as_array().unwrap().len(), 1);
        assert_eq!(standard["messages"][0]["content"], "Transcribe");

        let mut forked = json!({
            "messages": [
                { "role": "system", "content": "Transcribe" },
                { "role": "user", "content": "Acknowledge" },
                { "role": "assistant", "content": "Ready." },
                { "role": "user", "content": [{ "type": "text", "text": "Transcribe these pages." }] }
            ]
        });
        attach_page_images(
            &mut forked,
            vec![
                json!({"type": "image_url", "image_url": {"url": "data:image/png;base64,MQ=="}}),
                json!({"type": "image_url", "image_url": {"url": "data:image/png;base64,Mg=="}}),
            ],
        )
        .unwrap();
        let last_content = forked["messages"][3]["content"].as_array().unwrap();
        assert_eq!(last_content.len(), 3);
        assert_eq!(last_content[0]["type"], "text");
        assert_eq!(last_content[2]["image_url"]["url"], "data:image/png;base64,Mg==");
    }

    #[test]
    fn request_stats_survive_separate_usage_and_empty_timings() {
        let mut timings = None;
        let mut usage = None;
        collect_stream_stats(&mut timings, &mut usage, &json!({"timings": null}));
        assert!(timings.is_none());
        assert!(usage.is_none());
        collect_stream_stats(
            &mut timings,
            &mut usage,
            &json!({
                "timings": {"draft_n": 12, "draft_n_accepted": 9, "cache_n": 150, "prompt_n": 50},
                "usage": {"prompt_tokens": 200, "prompt_tokens_details": {"cached_tokens": 150}}
            }),
        );
        collect_stream_stats(
            &mut timings,
            &mut usage,
            &json!({
                "usage": {
                    "completion_tokens": 30,
                    "completion_tokens_details": {
                        "reasoning_tokens": 10,
                        "reasoning_closed_by": "answer_room"
                    }
                },
                "timings": {"draft_n": null, "predicted_n": 30}
            }),
        );
        assert_eq!(
            timings.unwrap(),
            json!({"draft_n": 12, "draft_n_accepted": 9, "cache_n": 150, "prompt_n": 50, "predicted_n": 30})
        );
        assert_eq!(
            usage.unwrap(),
            json!({
                "prompt_tokens": 200,
                "completion_tokens": 30,
                "prompt_tokens_details": {"cached_tokens": 150},
                "completion_tokens_details": {
                    "reasoning_tokens": 10,
                    "reasoning_closed_by": "answer_room"
                }
            })
        );
    }

    #[test]
    fn empty_or_truncated_streams_cannot_finish_successfully() {
        assert!(validate_stream_end(false, false, None).is_err());
        assert!(validate_stream_end(true, false, Some("stop")).is_err());
        assert_eq!(
            validate_stream_end(true, true, Some("length")),
            Err(TRUNCATED_MSG.to_string())
        );
        assert!(validate_stream_end(true, true, Some("stop")).is_ok());
    }

    fn parse(chunks: &[&str]) -> Vec<(String, String)> {
        let mut buf = String::new();
        let mut in_think = false;
        let mut events = Vec::new();
        let mut emit = |kind: &str, text: String| events.push((kind.to_string(), text));
        for c in chunks {
            buf.push_str(c);
            drain_content(&mut buf, &mut in_think, &mut emit);
        }
        flush_content(&mut buf, in_think, &mut emit);
        events
    }

    fn joined(events: &[(String, String)], kind: &str) -> String {
        events
            .iter()
            .filter(|(k, _)| k == kind)
            .map(|(_, t)| t.clone())
            .collect()
    }

    #[test]
    fn plain_output() {
        let ev = parse(&["Hello", " world"]);
        assert_eq!(joined(&ev, "output"), "Hello world");
        assert_eq!(joined(&ev, "thinking"), "");
    }

    #[test]
    fn kimi_style_markers() {
        let ev = parse(&["◁think▷reasoning here◁/think▷The answer"]);
        assert_eq!(joined(&ev, "thinking"), "reasoning here");
        assert_eq!(joined(&ev, "output"), "The answer");
    }

    #[test]
    fn xml_style_markers() {
        let ev = parse(&["<think>hmm</think>42"]);
        assert_eq!(joined(&ev, "thinking"), "hmm");
        assert_eq!(joined(&ev, "output"), "42");
    }

    #[test]
    fn marker_split_across_chunks() {
        let ev = parse(&["text◁th", "ink▷why ", "not◁/think▷", "done"]);
        assert_eq!(joined(&ev, "output"), "textdone");
        assert_eq!(joined(&ev, "thinking"), "why not");
    }

    #[test]
    fn thinking_open_at_stream_end() {
        let ev = parse(&["<think>unterminated thought"]);
        assert_eq!(joined(&ev, "thinking"), "unterminated thought");
    }

    #[test]
    fn multibyte_at_holdback_boundary_does_not_panic() {
        let s = "é".repeat(40);
        let ev = parse(&[&s]);
        assert_eq!(joined(&ev, "output"), s);

        let mixed = "café — “quotes” → 🚀🚀🚀 done";
        let chunks: Vec<String> = mixed.chars().map(|c| c.to_string()).collect();
        let refs: Vec<&str> = chunks.iter().map(|s| s.as_str()).collect();
        let ev = parse(&refs);
        assert_eq!(joined(&ev, "output"), mixed);
    }

    #[test]
    fn multibyte_around_think_markers() {
        let ev = parse(&["◁think▷héllo — ünïcode◁/think▷résumé 🚀"]);
        assert_eq!(joined(&ev, "thinking"), "héllo — ünïcode");
        assert_eq!(joined(&ev, "output"), "résumé 🚀");
    }

    #[test]
    fn floor_char_boundary_basics() {
        let s = "a🚀b";
        assert_eq!(floor_char_boundary(s, 0), 0);
        assert_eq!(floor_char_boundary(s, 1), 1);
        assert_eq!(floor_char_boundary(s, 2), 1);
        assert_eq!(floor_char_boundary(s, 4), 1);
        assert_eq!(floor_char_boundary(s, 5), 5);
        assert_eq!(floor_char_boundary(s, 100), s.len());
    }

    #[test]
    fn meminfo_parser_reads_kib_values() {
        let meminfo = "MemTotal:       1048576 kB\nMemAvailable:    262144 kB\n";
        assert_eq!(meminfo_kib(meminfo, "MemTotal"), Some(1_048_576));
        assert_eq!(meminfo_kib(meminfo, "MemAvailable"), Some(262_144));
        assert_eq!(meminfo_kib(meminfo, "Missing"), None);
    }

    #[test]
    fn normalize_accepts_server_root_or_openai_api_base() {
        assert_eq!(normalize("http://localhost:8731"), "http://localhost:8731");
        assert_eq!(normalize("http://localhost:8731/"), "http://localhost:8731");
        assert_eq!(
            normalize(" http://localhost:8731/v1/ "),
            "http://localhost:8731"
        );
        assert_eq!(
            normalize("http://localhost:8731/V1"),
            "http://localhost:8731"
        );
    }

    #[test]
    fn mupdf_renders_test_pdf_at_pixel_target() {
        let input = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/test-assets/test.pdf");
        let doc = open_pdf(&input).expect("open test.pdf");
        let sizes = pdf_page_sizes(&doc).unwrap();
        assert_eq!(sizes.len(), 3);
        let dir = std::env::temp_dir().join(format!("docproc4-halogen-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let target = 3_686_400;
        let dpi = dpi_for_target(sizes[0].0, sizes[0].1, target);
        let out = dir.join("page.png");
        render_page_png(&doc, 0, (dpi / 72.0) as f32, &out).unwrap();
        let png = fs::read(&out).unwrap();
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(&png[1..4], b"PNG");
        let w = u32::from_be_bytes(png[16..20].try_into().unwrap()) as f64;
        let h = u32::from_be_bytes(png[20..24].try_into().unwrap()) as f64;
        assert!((w * h - target as f64).abs() / (target as f64) < 0.01, "{w}x{h}");
    }

    #[test]
    fn dpi_hits_pixel_target() {
        let dpi = dpi_for_target(612.0, 792.0, 3_686_400);
        let px = (612.0 * dpi / 72.0) * (792.0 * dpi / 72.0);
        assert!((px - 3_686_400.0).abs() / 3_686_400.0 < 0.001, "{dpi} → {px}");
        assert_eq!(dpi_for_target(10.0, 10.0, 3_686_400), MAX_DPI);
        assert_eq!(dpi_for_target(100_000.0, 100_000.0, 3_686_400), MIN_DPI);
        assert_eq!(parse_target_px("1").unwrap(), MIN_TARGET_PX);
        assert!(parse_target_px("abc").is_err());
    }

    #[test]
    fn atomic_write_replaces_file_and_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!("docproc4-halogen-atomic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("last-run.json");
        write_atomic(&path, r#"{"v":1}"#).unwrap();
        write_atomic(&path, r#"{"v":2}"#).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"v":2}"#);
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn error_body_extraction() {
        let v = json!({"error":{"message":"image exceeds 4x HALOGEN_VISION_MAX_PIXELS","type":"invalid_request_error"}});
        assert_eq!(
            error_message(&v).unwrap(),
            "image exceeds 4x HALOGEN_VISION_MAX_PIXELS"
        );
        let v = json!({"error":{"code":"model_not_found","message":"Model 'x' was not found."}});
        assert_eq!(error_message(&v).unwrap(), "Model 'x' was not found.");
        assert_eq!(error_message(&json!({"error":"boom"})).unwrap(), "boom");
        assert!(error_message(&json!({"choices":[]})).is_none());
    }
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            http: reqwest::Client::new(),
            aborts: Mutex::new(HashMap::new()),
            cpu_sample: Mutex::new(None),
            last_server: Mutex::new((String::new(), String::new())),
            active_handle: Mutex::new(None),
            render_session: Mutex::new(None),
            render_lock: Mutex::new(()),
        })
        .manage(power::PowerState::default())
        .setup(|app| {
            remove_stale_render_caches(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health,
            list_models,
            system_stats,
            halogen::halogen_status,
            halogen::halogen_cache,
            halogen::halogen_warm_prefix,
            halogen::halogen_release_handle,
            halogen::halogen_list_handles,
            power::inhibit_suspend,
            render_pdf_mupdf,
            begin_pdf_render,
            store_page_png,
            ensure_full_pages,
            page_thumbnail,
            page_preview,
            clear_pdf_render,
            chat_stream,
            chat_cancel,
            measure_prompt_tokens,
            read_persisted,
            write_settings,
            write_instructions,
            save_outputs,
            write_recovery,
            read_recovery,
            clear_recovery,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<AppState>();
                for (_, h) in state.aborts.lock().unwrap().drain() {
                    h.abort();
                }
                clear_pdf_render(state.clone(), None);
                window.state::<power::PowerState>().release();
                let handle = state.active_handle.lock().unwrap().take();
                let (base, key) = state.last_server.lock().unwrap().clone();
                if let Some(handle_name) = handle {
                    if base.is_empty() {
                        return;
                    }
                    let client = state.http.clone();
                    let (tx, rx) = std::sync::mpsc::channel::<()>();
                    std::thread::spawn(move || {
                        if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                            .enable_all()
                            .build()
                        {
                            rt.block_on(async move {
                                let _ = tokio::time::timeout(
                                    std::time::Duration::from_secs(2),
                                    halogen::release_handle_direct(&client, &base, &key, &handle_name),
                                )
                                .await;
                            });
                        }
                        let _ = tx.send(());
                    });
                    let _ = rx.recv_timeout(std::time::Duration::from_secs(2));
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running DocProc4 Halogen");
}
