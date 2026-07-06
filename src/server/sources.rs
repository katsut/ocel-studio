//! Data sources: connector configs, runs + history, and keychain secrets.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt};

use super::{internal, ApiError, AppState};

/// The keychain service under which all studio secrets live.
const KEYRING_SERVICE: &str = "ocel-studio";

/// One environment variable for a connector: a plain value, or a reference
/// into the OS keychain resolved at spawn time. Secrets never appear in the
/// config file, API responses, or logs.
#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum EnvValue {
    Plain { value: String },
    Keyring { keyring: String },
}

/// A registered data source: a command that (re)writes one OCEL file in the
/// workspace (connector contract v1/v2).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SourceConfig {
    name: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    env: std::collections::BTreeMap<String, EnvValue>,
    /// Workspace file this source reads (transform sources) — a pipeline
    /// edge for the DAG view; purely descriptive metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    input: Option<String>,
    /// Workspace file this source (re)writes — the other DAG edge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    output: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum RunPhase {
    Running,
    Succeeded,
    Failed,
}

/// A contract-v2 `progress` event, as last reported by the connector.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RunProgress {
    stage: String,
    done: u64,
    total: Option<u64>,
}

/// A contract-v2 `done` summary.
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RunSummary {
    events: u64,
    objects: u64,
}

/// One completed run, as kept in `<config_dir>/runs.json` across restarts.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RunRecord {
    pub(super) source: String,
    /// `Succeeded` or `Failed` — running runs are in-memory only.
    pub(super) state: RunPhase,
    pub(super) started: DateTime<Utc>,
    pub(super) finished: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) stderr_tail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) summary: Option<RunSummary>,
}

/// Completed runs kept per source; older ones fall off.
const MAX_HISTORY_PER_SOURCE: usize = 50;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RunState {
    pub(super) state: RunPhase,
    pub(super) started: DateTime<Utc>,
    pub(super) finished: Option<DateTime<Utc>>,
    pub(super) exit_code: Option<i32>,
    /// Last chunk of stderr, shown when a run fails.
    pub(super) stderr_tail: Option<String>,
    /// Live progress from contract-v2 connectors (None for v1).
    pub(super) progress: Option<RunProgress>,
    /// Contract-v2 log events, capped.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(super) logs: Vec<String>,
    /// Contract-v2 completion summary.
    pub(super) summary: Option<RunSummary>,
}

impl RunState {
    fn running(started: DateTime<Utc>) -> RunState {
        RunState {
            state: RunPhase::Running,
            started,
            finished: None,
            exit_code: None,
            stderr_tail: None,
            progress: None,
            logs: Vec::new(),
            summary: None,
        }
    }
}

const MAX_RUN_LOGS: usize = 50;

/// Apply one stdout line to the run state. Contract v2: NDJSON events;
/// anything unparseable or unknown is ignored, so v1 connectors (quiet or
/// chatty stdout) never break.
fn apply_v2_line(run: &mut RunState, line: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    match value.get("event").and_then(|e| e.as_str()) {
        Some("progress") => {
            run.progress = Some(RunProgress {
                stage: value
                    .get("stage")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_owned(),
                done: value
                    .get("done")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
                total: value.get("total").and_then(serde_json::Value::as_u64),
            });
        }
        Some("log") => {
            if run.logs.len() < MAX_RUN_LOGS {
                let level = value
                    .get("level")
                    .and_then(|s| s.as_str())
                    .unwrap_or("info");
                let message = value.get("message").and_then(|s| s.as_str()).unwrap_or("");
                run.logs.push(format!("{level}: {message}"));
            }
        }
        Some("done") => {
            run.summary = Some(RunSummary {
                events: value
                    .get("events")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
                objects: value
                    .get("objects")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
            });
        }
        _ => {}
    }
}

pub(super) fn sources_file(config_dir: &Path) -> PathBuf {
    config_dir.join("sources.json")
}

pub(super) fn runs_file(config_dir: &Path) -> PathBuf {
    config_dir.join("runs.json")
}

pub(super) fn load_sources(config_dir: &Path) -> Vec<SourceConfig> {
    let Ok(raw) = std::fs::read_to_string(sources_file(config_dir)) else {
        return Vec::new();
    };
    match serde_json::from_str(&raw) {
        Ok(sources) => sources,
        Err(err) => {
            eprintln!("ignoring unreadable sources.json: {err}");
            Vec::new()
        }
    }
}

fn save_sources(config_dir: &Path, sources: &[SourceConfig]) -> Result<(), ApiError> {
    std::fs::create_dir_all(config_dir).map_err(|e| internal(&e))?;
    let raw = serde_json::to_string_pretty(sources).map_err(|e| internal(&e))?;
    std::fs::write(sources_file(config_dir), raw).map_err(|e| internal(&e))
}

pub(super) fn load_history(config_dir: &Path) -> Vec<RunRecord> {
    let Ok(raw) = std::fs::read_to_string(runs_file(config_dir)) else {
        return Vec::new();
    };
    match serde_json::from_str(&raw) {
        Ok(history) => history,
        Err(err) => {
            eprintln!("ignoring unreadable runs.json: {err}");
            Vec::new()
        }
    }
}

fn save_history(config_dir: &Path, history: &[RunRecord]) {
    let write = std::fs::create_dir_all(config_dir)
        .map_err(|e| e.to_string())
        .and_then(|()| serde_json::to_string_pretty(history).map_err(|e| e.to_string()))
        .and_then(|raw| std::fs::write(runs_file(config_dir), raw).map_err(|e| e.to_string()));
    if let Err(err) = write {
        // history is best-effort bookkeeping; never fail the run over it
        eprintln!("cannot write runs.json: {err}");
    }
}

/// Prepend a completed run and persist, dropping this source's oldest
/// entries past the cap.
async fn record_run(state: &AppState, record: RunRecord) {
    let mut history = state.history.write().await;
    history.insert(0, record);
    let mut kept = 0usize;
    let source = history[0].source.clone();
    history.retain(|r| {
        if r.source != source {
            return true;
        }
        kept += 1;
        kept <= MAX_HISTORY_PER_SOURCE
    });
    save_history(&state.config_dir, &history);
}

pub(super) fn valid_source_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SourceView {
    #[serde(flatten)]
    config: SourceConfig,
    run: Option<RunState>,
}

async fn source_views(state: &AppState) -> Vec<SourceView> {
    let sources = state.sources.read().await.clone();
    let runs = state.runs.read().await;
    sources
        .into_iter()
        .map(|config| SourceView {
            run: runs.get(&config.name).cloned(),
            config,
        })
        .collect()
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn sources_list(State(state): State<Arc<AppState>>) -> Json<Vec<SourceView>> {
    Json(source_views(&state).await)
}

/// Register a source, or replace the one with the same name.
#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn sources_upsert(
    State(state): State<Arc<AppState>>,
    Json(config): Json<SourceConfig>,
) -> Result<Json<Vec<SourceView>>, ApiError> {
    if !valid_source_name(&config.name) {
        return Err((
            StatusCode::BAD_REQUEST,
            "source names are 1-64 chars of letters, digits, - and _".to_owned(),
        ));
    }
    if config.command.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "command is empty".to_owned()));
    }
    {
        let mut sources = state.sources.write().await;
        if let Some(existing) = sources.iter_mut().find(|s| s.name == config.name) {
            *existing = config;
        } else {
            sources.push(config);
        }
        save_sources(&state.config_dir, &sources)?;
    }
    Ok(Json(source_views(&state).await))
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn sources_delete(
    State(state): State<Arc<AppState>>,
    UrlPath(name): UrlPath<String>,
) -> Result<Json<Vec<SourceView>>, ApiError> {
    if state
        .runs
        .read()
        .await
        .get(&name)
        .is_some_and(|r| r.state == RunPhase::Running)
    {
        return Err((StatusCode::CONFLICT, "source is running".to_owned()));
    }
    {
        let mut sources = state.sources.write().await;
        let before = sources.len();
        sources.retain(|s| s.name != name);
        if sources.len() == before {
            return Err((StatusCode::NOT_FOUND, format!("no such source: {name}")));
        }
        save_sources(&state.config_dir, &sources)?;
    }
    state.runs.write().await.remove(&name);
    {
        let mut history = state.history.write().await;
        history.retain(|r| r.source != name);
        save_history(&state.config_dir, &history);
    }
    Ok(Json(source_views(&state).await))
}

#[derive(Deserialize)]
pub(super) struct RunsQuery {
    source: Option<String>,
    limit: Option<usize>,
}

/// Completed runs, newest first, surviving restarts.
#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn runs_list(
    State(state): State<Arc<AppState>>,
    Query(query): Query<RunsQuery>,
) -> Json<Vec<RunRecord>> {
    let history = state.history.read().await;
    let records: Vec<RunRecord> = history
        .iter()
        .filter(|r| query.source.as_ref().is_none_or(|s| &r.source == s))
        .take(query.limit.unwrap_or(20))
        .cloned()
        .collect();
    Json(records)
}

/// Run a source's command (one run per source at a time). The child runs
/// with the workspace as its working directory, so a relative --out lands
/// there; stdout is reserved by the contract and discarded until v2.
#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn sources_run(
    State(state): State<Arc<AppState>>,
    UrlPath(name): UrlPath<String>,
) -> Result<Json<Vec<SourceView>>, ApiError> {
    let Some(config) = state
        .sources
        .read()
        .await
        .iter()
        .find(|s| s.name == name)
        .cloned()
    else {
        return Err((StatusCode::NOT_FOUND, format!("no such source: {name}")));
    };
    {
        let mut runs = state.runs.write().await;
        if runs
            .get(&name)
            .is_some_and(|r| r.state == RunPhase::Running)
        {
            return Err((StatusCode::CONFLICT, "source is already running".to_owned()));
        }
        runs.insert(name.clone(), RunState::running(Utc::now()));
    }

    let fail_run = |message: String| async {
        let now = Utc::now();
        let mut failed = RunState::running(now);
        failed.state = RunPhase::Failed;
        failed.finished = Some(now);
        failed.stderr_tail = Some(message.clone());
        state.runs.write().await.insert(name.clone(), failed);
        record_run(
            &state,
            RunRecord {
                source: name.clone(),
                state: RunPhase::Failed,
                started: now,
                finished: now,
                exit_code: None,
                stderr_tail: Some(message),
                summary: None,
            },
        )
        .await;
    };

    let resolved_env = match resolve_env(&config.env) {
        Ok(resolved) => resolved,
        Err(message) => {
            fail_run(message).await;
            return Ok(Json(source_views(&state).await));
        }
    };

    std::fs::create_dir_all(&state.data_dir).map_err(|e| internal(&e))?;
    let spawned = tokio::process::Command::new(&config.command)
        .args(&config.args)
        .envs(resolved_env)
        .current_dir(&state.data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let child = match spawned {
        Ok(child) => child,
        Err(err) => {
            fail_run(err.to_string()).await;
            return Ok(Json(source_views(&state).await));
        }
    };

    tokio::spawn(watch_child(Arc::clone(&state), name, child));

    Ok(Json(source_views(&state).await))
}

/// Follow a running connector: stream stderr into a bounded tail, apply
/// contract-v2 stdout events live, and record the final state on exit.
async fn watch_child(state: Arc<AppState>, name: String, mut child: tokio::process::Child) {
    const TAIL: usize = 8 * 1024;
    let stderr = child.stderr.take();
    let stdout = child.stdout.take();

    let read_stderr = async {
        let mut tail: Vec<u8> = Vec::new();
        if let Some(mut stderr) = stderr {
            let mut buf = [0u8; 4096];
            loop {
                match stderr.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        tail.extend_from_slice(&buf[..n]);
                        if tail.len() > TAIL {
                            let cut = tail.len() - TAIL;
                            tail.drain(..cut);
                        }
                    }
                }
            }
        }
        tail
    };
    // contract v2: NDJSON events, applied live so the UI poll sees them
    let read_stdout = async {
        if let Some(stdout) = stdout {
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut runs = state.runs.write().await;
                if let Some(run) = runs.get_mut(&name) {
                    apply_v2_line(run, &line);
                }
            }
        }
    };
    let (tail, ()) = tokio::join!(read_stderr, read_stdout);

    let status = child.wait().await;
    let (phase, exit_code) = match status {
        Ok(status) if status.success() => (RunPhase::Succeeded, status.code()),
        Ok(status) => (RunPhase::Failed, status.code()),
        Err(_) => (RunPhase::Failed, None),
    };
    let stderr_tail = (phase == RunPhase::Failed && !tail.is_empty())
        .then(|| String::from_utf8_lossy(&tail).into_owned());
    let finished = Utc::now();
    let record = {
        let mut runs = state.runs.write().await;
        let Some(run) = runs.get_mut(&name) else {
            return;
        };
        run.state = phase;
        run.finished = Some(finished);
        run.exit_code = exit_code;
        run.stderr_tail = stderr_tail;
        RunRecord {
            source: name.clone(),
            state: phase,
            started: run.started,
            finished,
            exit_code,
            stderr_tail: run.stderr_tail.clone(),
            summary: run.summary,
        }
    };
    record_run(&state, record).await;
}

/// Resolve a source's environment before spawning: plain values pass
/// through, keychain refs are fetched at spawn time. The error message
/// names the missing account, never the secret.
fn resolve_env(
    env: &std::collections::BTreeMap<String, EnvValue>,
) -> Result<Vec<(String, String)>, String> {
    let mut resolved = Vec::with_capacity(env.len());
    for (key, value) in env {
        match value {
            EnvValue::Plain { value } => resolved.push((key.clone(), value.clone())),
            EnvValue::Keyring { keyring: account } => {
                let secret = keyring::Entry::new(KEYRING_SERVICE, account)
                    .and_then(|entry| entry.get_password())
                    .map_err(|err| format!("secret '{account}' unavailable: {err}"))?;
                resolved.push((key.clone(), secret));
            }
        }
    }
    Ok(resolved)
}

#[derive(Deserialize)]
pub(super) struct SecretBody {
    account: String,
    value: String,
}

/// Store a secret in the OS keychain (service `ocel-studio`). Write-only:
/// there is no endpoint that reads a secret back.
#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn secret_set(Json(body): Json<SecretBody>) -> Result<StatusCode, ApiError> {
    if !valid_source_name(&body.account) {
        return Err((
            StatusCode::BAD_REQUEST,
            "secret accounts are 1-64 chars of letters, digits, - and _".to_owned(),
        ));
    }
    if body.value.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "secret value is empty".to_owned()));
    }
    keyring::Entry::new(KEYRING_SERVICE, &body.account)
        .and_then(|entry| entry.set_password(&body.value))
        .map_err(|e| internal(&e))?;
    Ok(StatusCode::NO_CONTENT)
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn secret_delete(
    UrlPath(account): UrlPath<String>,
) -> Result<StatusCode, ApiError> {
    keyring::Entry::new(KEYRING_SERVICE, &account)
        .and_then(|entry| entry.delete_credential())
        .map_err(|e| internal(&e))?;
    Ok(StatusCode::NO_CONTENT)
}
