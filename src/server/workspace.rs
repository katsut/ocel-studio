//! Workspace log files: listing, opening, status, and the official sample.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::sources::{runs_file, sources_file};
use super::{internal, load, ApiError, AppState};

/// The official Zenodo Order Management sample (~35 MB sqlite, 21K events).
const SAMPLE_URL: &str =
    "https://zenodo.org/api/records/18373906/files/order-management.sqlite/content";
const SAMPLE_FILE: &str = "order-management.sqlite";

const OCEL_EXTENSIONS: [&str; 6] = ["json", "jsonocel", "sqlite", "db", "xml", "xmlocel"];

fn is_ocel_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| OCEL_EXTENSIONS.contains(&e))
        && path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| !n.starts_with('.'))
}

/// Workspace OCEL files, newest first. The sources config is never a log
/// (on macOS `config_dir` == `data_dir`).
pub(super) fn logs_by_recency(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            is_ocel_file(p)
                && p.file_name() != Some(std::ffi::OsStr::new("sources.json"))
                && p.file_name() != Some(std::ffi::OsStr::new("runs.json"))
        })
        .collect();
    paths.sort_by_key(|p| {
        std::cmp::Reverse(
            std::fs::metadata(p)
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH),
        )
    });
    paths
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Status {
    loaded: bool,
    modified: Option<DateTime<Utc>>,
    /// Where the sample would be saved — shown in the empty state.
    data_dir: String,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn status(State(state): State<Arc<AppState>>) -> Result<Json<Status>, ApiError> {
    let data_dir = state.data_dir.display().to_string();
    let Some(path) = state.loaded.read().await.as_ref().map(|l| l.path.clone()) else {
        return Ok(Json(Status {
            loaded: false,
            modified: None,
            data_dir,
        }));
    };
    let modified = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .map_err(|e| internal(&e))?;
    Ok(Json(Status {
        loaded: true,
        modified: Some(modified.into()),
        data_dir,
    }))
}

/// Fetch the official sample into the data directory (kept if already
/// there) and make it the active log. Triggered only by an explicit click —
/// the studio never reaches out on its own.
#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn sample(State(state): State<Arc<AppState>>) -> Result<Json<Status>, ApiError> {
    let target = state.data_dir.join(SAMPLE_FILE);
    if !target.exists() {
        let bytes = reqwest::get(SAMPLE_URL)
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|e| internal(&e))?
            .bytes()
            .await
            .map_err(|e| internal(&e))?;
        std::fs::create_dir_all(&state.data_dir).map_err(|e| internal(&e))?;
        let staging = state.data_dir.join(format!("{SAMPLE_FILE}.part"));
        std::fs::write(&staging, &bytes).map_err(|e| internal(&e))?;
        std::fs::rename(&staging, &target).map_err(|e| internal(&e))?;
        eprintln!("fetched sample to {}", target.display());
    }
    let loaded = load(&target).map_err(|e| internal(&*e))?;
    let modified = loaded.modified;
    *state.loaded.write().await = Some(loaded);
    Ok(Json(Status {
        loaded: true,
        modified: Some(modified.into()),
        data_dir: state.data_dir.display().to_string(),
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogEntry {
    name: String,
    size: u64,
    modified: DateTime<Utc>,
    active: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LogsResponse {
    data_dir: String,
    /// Workspace logs, newest first.
    logs: Vec<LogEntry>,
    /// Path of the active log when it lives outside the workspace.
    active_outside: Option<String>,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn logs(
    State(state): State<Arc<AppState>>,
) -> Result<Json<LogsResponse>, ApiError> {
    let active_path = state.loaded.read().await.as_ref().map(|l| l.path.clone());
    let mut logs: Vec<LogEntry> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&state.data_dir) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            // on macOS config_dir == data_dir, so the sources and run
            // history files would otherwise show up as .json logs
            if !is_ocel_file(&path)
                || path == sources_file(&state.config_dir)
                || path == runs_file(&state.config_dir)
            {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            logs.push(LogEntry {
                name: name.to_owned(),
                size: meta.len(),
                modified: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH).into(),
                active: active_path.as_deref() == Some(path.as_path()),
            });
        }
    }
    logs.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.name.cmp(&b.name))
    });
    let active_outside = active_path
        .filter(|p| !logs.iter().any(|l| l.active) && p.exists())
        .map(|p| p.display().to_string());
    Ok(Json(LogsResponse {
        data_dir: state.data_dir.display().to_string(),
        logs,
        active_outside,
    }))
}

#[derive(Deserialize)]
pub(super) struct OpenBody {
    /// Bare file name inside the workspace — never a path.
    name: String,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn open_log(
    State(state): State<Arc<AppState>>,
    Json(body): Json<OpenBody>,
) -> Result<Json<Status>, ApiError> {
    // names only: reject anything that does not stand alone as a file name
    let candidate = Path::new(&body.name);
    if candidate.file_name() != Some(std::ffi::OsStr::new(body.name.as_str())) {
        return Err((StatusCode::BAD_REQUEST, "not a file name".to_owned()));
    }
    let path = state.data_dir.join(&body.name);
    if !is_ocel_file(&path) || !path.exists() {
        return Err((StatusCode::NOT_FOUND, format!("no such log: {}", body.name)));
    }
    let loaded = load(&path).map_err(|e| internal(&*e))?;
    let modified = loaded.modified;
    eprintln!(
        "opened {}: {} events / {} objects",
        path.display(),
        loaded.log.events.len(),
        loaded.log.objects.len()
    );
    *state.loaded.write().await = Some(loaded);
    Ok(Json(Status {
        loaded: true,
        modified: Some(modified.into()),
        data_dir: state.data_dir.display().to_string(),
    }))
}
