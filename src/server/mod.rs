//! HTTP server: JSON API over one loaded OCEL log + embedded frontend assets.
//!
//! The log is reloaded lazily: every API request compares the file's mtime with
//! the loaded snapshot and re-reads on change, so incremental connector pulls
//! show up on the next poll without any push machinery.

mod analysis;
mod recipes;
mod sources;
mod workspace;

use std::collections::HashMap;
use std::error::Error;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::Router;
use rust_embed::RustEmbed;
use tokio::sync::RwLock;

use analysis::{case_detail, cases, dfg, events, leadtimes, model, ocdfg, summary, variants};
use recipes::{recipes_delete, recipes_list, recipes_upsert, transform_preview};
use sources::{
    load_history, load_sources, runs_list, secret_delete, secret_set, sources_delete, sources_list,
    sources_run, sources_upsert, RunRecord, RunState, SourceConfig,
};
use workspace::{logs, logs_by_recency, open_log, sample, status};

#[derive(RustEmbed)]
#[folder = "frontend/dist/"]
struct Assets;

struct Loaded {
    path: PathBuf,
    modified: SystemTime,
    log: ocel::Ocel,
    by_time: Vec<usize>,
    violations: Vec<String>,
    type_stats: Vec<ocel_mine::TypeStats>,
}

struct AppState {
    data_dir: PathBuf,
    config_dir: PathBuf,
    loaded: RwLock<Option<Loaded>>,
    sources: RwLock<Vec<SourceConfig>>,
    runs: RwLock<HashMap<String, RunState>>,
    /// Completed runs, newest first, persisted to `runs.json`.
    history: RwLock<Vec<RunRecord>>,
}

type ApiError = (StatusCode, String);

pub async fn run(
    explicit: Option<PathBuf>,
    data_dir: PathBuf,
    config_dir: PathBuf,
    port: u16,
) -> Result<(), Box<dyn Error>> {
    // an explicitly named log must open or we fail loudly; the auto-pick
    // walks the workspace newest-first and skips unreadable files, so one
    // broken connector output never blocks startup
    let loaded = if let Some(path) = explicit {
        Some(load(&path)?)
    } else {
        let mut found = None;
        for path in logs_by_recency(&data_dir) {
            match load(&path) {
                Ok(loaded) => {
                    found = Some(loaded);
                    break;
                }
                Err(err) => eprintln!("skipping unreadable {}: {err}", path.display()),
            }
        }
        found
    };
    match &loaded {
        Some(loaded) => eprintln!(
            "opened {}: {} events / {} objects",
            loaded.path.display(),
            loaded.log.events.len(),
            loaded.log.objects.len()
        ),
        None => eprintln!("no log loaded — the studio offers the official sample on first visit"),
    }
    let sources = load_sources(&config_dir);
    let history = load_history(&config_dir);
    // seed the live view from history so "last run" survives a restart
    let mut runs: HashMap<String, RunState> = HashMap::new();
    for record in history.iter().rev() {
        runs.insert(
            record.source.clone(),
            RunState {
                state: record.state,
                started: record.started,
                finished: Some(record.finished),
                exit_code: record.exit_code,
                stderr_tail: record.stderr_tail.clone(),
                progress: None,
                logs: Vec::new(),
                summary: record.summary,
            },
        );
    }
    let state = Arc::new(AppState {
        data_dir,
        config_dir,
        loaded: RwLock::new(loaded),
        sources: RwLock::new(sources),
        runs: RwLock::new(runs),
        history: RwLock::new(history),
    });

    let app = Router::new()
        .route("/api/summary", get(summary))
        .route("/api/events", get(events))
        .route("/api/variants", get(variants))
        .route("/api/dfg", get(dfg))
        .route("/api/ocdfg", get(ocdfg))
        .route("/api/model", get(model))
        .route("/api/leadtimes", get(leadtimes))
        .route("/api/cases", get(cases))
        .route("/api/case", get(case_detail))
        .route("/api/status", get(status))
        .route("/api/sample", post(sample))
        .route("/api/logs", get(logs))
        .route("/api/logs/open", post(open_log))
        .route("/api/sources", get(sources_list).post(sources_upsert))
        .route("/api/sources/{name}", delete(sources_delete))
        .route("/api/sources/{name}/run", post(sources_run))
        .route("/api/runs", get(runs_list))
        .route("/api/secrets", post(secret_set))
        .route("/api/secrets/{account}", delete(secret_delete))
        .route("/api/recipes", get(recipes_list).post(recipes_upsert))
        .route("/api/recipes/{name}", delete(recipes_delete))
        .route("/api/transform/preview", post(transform_preview))
        .fallback(get(asset))
        .with_state(state);

    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    eprintln!("ocel-studio running at http://{addr}/");
    axum::serve(listener, app).await?;
    Ok(())
}

fn load(path: &Path) -> Result<Loaded, Box<dyn Error>> {
    let modified = std::fs::metadata(path)?.modified()?;
    let log = ocel::io::read_path(path)?;
    let mut by_time: Vec<usize> = (0..log.events.len()).collect();
    by_time.sort_by_key(|&i| log.events[i].time);
    let violations = ocel::validate::validate(&log)
        .iter()
        .map(ToString::to_string)
        .collect();
    let type_stats = ocel_mine::type_stats(&log);
    Ok(Loaded {
        path: path.to_path_buf(),
        modified,
        log,
        by_time,
        violations,
        type_stats,
    })
}

fn internal<E: ToString + ?Sized>(err: &E) -> ApiError {
    (StatusCode::INTERNAL_SERVER_ERROR, err.to_string())
}

fn no_log() -> ApiError {
    (StatusCode::NOT_FOUND, "no log loaded".to_owned())
}

/// Re-read the log when the file changed on disk since the loaded snapshot.
async fn ensure_fresh(state: &AppState) -> Result<(), ApiError> {
    let path = match state.loaded.read().await.as_ref() {
        Some(loaded) => loaded.path.clone(),
        None => return Ok(()),
    };
    let modified = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .map_err(|e| internal(&e))?;
    let changed = state
        .loaded
        .read()
        .await
        .as_ref()
        .is_some_and(|l| l.modified != modified);
    if changed {
        let loaded = load(&path).map_err(|e| internal(&*e))?;
        eprintln!(
            "reloaded {}: {} events / {} objects",
            path.display(),
            loaded.log.events.len(),
            loaded.log.objects.len()
        );
        *state.loaded.write().await = Some(loaded);
    }
    Ok(())
}

/// Serve embedded frontend files; unknown paths fall back to the SPA index.
async fn asset(uri: Uri) -> Response {
    let requested = uri.path().trim_start_matches('/');
    let requested = if requested.is_empty() {
        "index.html"
    } else {
        requested
    };
    let (path, file) = match Assets::get(requested) {
        Some(file) => (requested, file),
        None => match Assets::get("index.html") {
            Some(file) => ("index.html", file),
            None => return (StatusCode::NOT_FOUND, "frontend not embedded").into_response(),
        },
    };
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    ([(header::CONTENT_TYPE, mime.as_ref())], file.data).into_response()
}
