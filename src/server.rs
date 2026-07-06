//! HTTP server: JSON API over one loaded OCEL log + embedded frontend assets.
//!
//! The log is reloaded lazily: every API request compares the file's mtime with
//! the loaded snapshot and re-reads on change, so incremental connector pulls
//! show up on the next poll without any push machinery.

use std::collections::HashMap;
use std::error::Error;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use std::borrow::Cow;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt};

use chrono::{DateTime, NaiveDate, Utc};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

const MAX_PAGE: usize = 500;

#[derive(RustEmbed)]
#[folder = "frontend/dist/"]
struct Assets;

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
fn logs_by_recency(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| is_ocel_file(p) && p.file_name() != Some(std::ffi::OsStr::new("sources.json")))
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

struct Loaded {
    path: PathBuf,
    modified: SystemTime,
    log: ocel::Ocel,
    by_time: Vec<usize>,
    violations: Vec<String>,
    type_stats: Vec<ocel_mine::TypeStats>,
}

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
struct SourceConfig {
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

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum RunPhase {
    Running,
    Succeeded,
    Failed,
}

/// A contract-v2 `progress` event, as last reported by the connector.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunProgress {
    stage: String,
    done: u64,
    total: Option<u64>,
}

/// A contract-v2 `done` summary.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunSummary {
    events: u64,
    objects: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunState {
    state: RunPhase,
    started: DateTime<Utc>,
    finished: Option<DateTime<Utc>>,
    exit_code: Option<i32>,
    /// Last chunk of stderr, shown when a run fails.
    stderr_tail: Option<String>,
    /// Live progress from contract-v2 connectors (None for v1).
    progress: Option<RunProgress>,
    /// Contract-v2 log events, capped.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    logs: Vec<String>,
    /// Contract-v2 completion summary.
    summary: Option<RunSummary>,
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

struct AppState {
    data_dir: PathBuf,
    config_dir: PathBuf,
    loaded: RwLock<Option<Loaded>>,
    sources: RwLock<Vec<SourceConfig>>,
    runs: RwLock<HashMap<String, RunState>>,
}

type ApiError = (StatusCode, String);

fn sources_file(config_dir: &Path) -> PathBuf {
    config_dir.join("sources.json")
}

fn load_sources(config_dir: &Path) -> Vec<SourceConfig> {
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
    let state = Arc::new(AppState {
        data_dir,
        config_dir,
        loaded: RwLock::new(loaded),
        sources: RwLock::new(sources),
        runs: RwLock::new(HashMap::new()),
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

/// Optional global time window (dates, inclusive). Filters events; cases
/// spanning the boundary appear truncated — stated in the UI guide.
#[derive(Deserialize, Default)]
struct RangeQuery {
    from: Option<String>,
    to: Option<String>,
}

fn parse_day(s: &str) -> Result<NaiveDate, ApiError> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("bad date {s}: {e}")))
}

/// Borrow the log as-is, or build a windowed copy holding only the events
/// inside the range (all declarations and objects are kept).
fn window<'a>(log: &'a ocel::Ocel, range: &RangeQuery) -> Result<Cow<'a, ocel::Ocel>, ApiError> {
    if range.from.is_none() && range.to.is_none() {
        return Ok(Cow::Borrowed(log));
    }
    let from: Option<DateTime<Utc>> = range
        .from
        .as_deref()
        .map(parse_day)
        .transpose()?
        .map(|d| d.and_hms_opt(0, 0, 0).expect("midnight is valid").and_utc());
    let to: Option<DateTime<Utc>> = range.to.as_deref().map(parse_day).transpose()?.map(|d| {
        d.and_hms_opt(23, 59, 59)
            .expect("end of day is valid")
            .and_utc()
    });
    let events: Vec<ocel::Event> = log
        .events
        .iter()
        .filter(|e| from.is_none_or(|f| e.time >= f) && to.is_none_or(|t| e.time <= t))
        .cloned()
        .collect();
    Ok(Cow::Owned(ocel::Ocel {
        event_types: log.event_types.clone(),
        object_types: log.object_types.clone(),
        events,
        objects: log.objects.clone(),
    }))
}

/// Time-sorted event indices for a (possibly windowed) log.
fn time_order(log: &ocel::Ocel) -> Vec<usize> {
    let mut order: Vec<usize> = (0..log.events.len()).collect();
    order.sort_unstable_by_key(|&i| (log.events[i].time, i));
    order
}

#[derive(Serialize)]
struct TypeCount {
    name: String,
    count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TimeRange {
    start: DateTime<Utc>,
    end: DateTime<Utc>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    path: String,
    modified: DateTime<Utc>,
    events: usize,
    objects: usize,
    event_types: Vec<TypeCount>,
    object_types: Vec<TypeCount>,
    type_stats: Vec<ocel_mine::TypeStats>,
    time_range: Option<TimeRange>,
    violations: Vec<String>,
}

/// Observed counts per type, seeded with every declared type at zero.
fn type_counts<'a>(
    declared: impl Iterator<Item = &'a str>,
    observed: impl Iterator<Item = &'a str>,
) -> Vec<TypeCount> {
    let mut counts: HashMap<&str, usize> = declared.map(|name| (name, 0)).collect();
    for name in observed {
        *counts.entry(name).or_insert(0) += 1;
    }
    let mut out: Vec<TypeCount> = counts
        .into_iter()
        .map(|(name, count)| TypeCount {
            name: name.to_owned(),
            count,
        })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
    out
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn summary(
    State(state): State<Arc<AppState>>,
    Query(range): Query<RangeQuery>,
) -> Result<Json<Summary>, ApiError> {
    ensure_fresh(&state).await?;
    let guard = state.loaded.read().await;
    let loaded = guard.as_ref().ok_or_else(no_log)?;
    let log = window(&loaded.log, &range)?;
    let windowed = matches!(log, Cow::Owned(_));
    let by_time = if windowed {
        time_order(&log)
    } else {
        loaded.by_time.clone()
    };
    let time_range = (!by_time.is_empty()).then(|| TimeRange {
        start: log.events[by_time[0]].time,
        end: log.events[by_time[by_time.len() - 1]].time,
    });
    Ok(Json(Summary {
        path: loaded.path.display().to_string(),
        modified: loaded.modified.into(),
        events: log.events.len(),
        objects: log.objects.len(),
        event_types: type_counts(
            log.event_types.iter().map(|t| t.name.as_str()),
            log.events.iter().map(|e| e.event_type.as_str()),
        ),
        object_types: type_counts(
            log.object_types.iter().map(|t| t.name.as_str()),
            log.objects.iter().map(|o| o.object_type.as_str()),
        ),
        type_stats: if windowed {
            ocel_mine::type_stats(&log)
        } else {
            loaded.type_stats.clone()
        },
        time_range,
        violations: loaded.violations.clone(),
    }))
}

#[derive(Deserialize)]
struct PageQuery {
    #[serde(flatten)]
    range: RangeQuery,
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize {
    100
}

#[derive(Serialize)]
struct RelatedObject {
    id: String,
    qualifier: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EventRow {
    id: String,
    event_type: String,
    time: DateTime<Utc>,
    objects: Vec<RelatedObject>,
}

#[derive(Serialize)]
struct EventsPage {
    total: usize,
    offset: usize,
    items: Vec<EventRow>,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn events(
    State(state): State<Arc<AppState>>,
    Query(page): Query<PageQuery>,
) -> Result<Json<EventsPage>, ApiError> {
    ensure_fresh(&state).await?;
    let guard = state.loaded.read().await;
    let loaded = guard.as_ref().ok_or_else(no_log)?;
    let log = window(&loaded.log, &page.range)?;
    let by_time = if matches!(log, Cow::Owned(_)) {
        time_order(&log)
    } else {
        loaded.by_time.clone()
    };
    let limit = page.limit.min(MAX_PAGE);
    let items = by_time
        .iter()
        .skip(page.offset)
        .take(limit)
        .map(|&i| {
            let event = &log.events[i];
            EventRow {
                id: event.id.clone(),
                event_type: event.event_type.clone(),
                time: event.time,
                objects: event
                    .relationships
                    .iter()
                    .map(|r| RelatedObject {
                        id: r.object_id.clone(),
                        qualifier: r.qualifier.clone(),
                    })
                    .collect(),
            }
        })
        .collect();
    Ok(Json(EventsPage {
        total: by_time.len(),
        offset: page.offset,
        items,
    }))
}

#[derive(Deserialize)]
struct VariantsQuery {
    #[serde(flatten)]
    range: RangeQuery,
    #[serde(rename = "type")]
    object_type: String,
    #[serde(default = "default_variants_limit")]
    limit: usize,
}

fn default_variants_limit() -> usize {
    50
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VariantsResponse {
    object_type: String,
    objects: usize,
    with_events: usize,
    total_variants: usize,
    variants: Vec<ocel_mine::Variant>,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn variants(
    State(state): State<Arc<AppState>>,
    Query(query): Query<VariantsQuery>,
) -> Result<Json<VariantsResponse>, ApiError> {
    ensure_fresh(&state).await?;
    let guard = state.loaded.read().await;
    let loaded = guard.as_ref().ok_or_else(no_log)?;
    let log = window(&loaded.log, &query.range)?;
    let mut report = ocel_mine::variants(&log, &query.object_type);
    let total_variants = report.variants.len();
    report.variants.truncate(query.limit.min(MAX_PAGE));
    Ok(Json(VariantsResponse {
        object_type: report.object_type,
        objects: report.objects,
        with_events: report.with_events,
        total_variants,
        variants: report.variants,
    }))
}

#[derive(Deserialize)]
struct DfgQuery {
    #[serde(flatten)]
    range: RangeQuery,
    #[serde(rename = "type")]
    object_type: String,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn dfg(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DfgQuery>,
) -> Result<Json<ocel_mine::Dfg>, ApiError> {
    ensure_fresh(&state).await?;
    let guard = state.loaded.read().await;
    let loaded = guard.as_ref().ok_or_else(no_log)?;
    let log = window(&loaded.log, &query.range)?;
    Ok(Json(ocel_mine::dfg(&log, &query.object_type)))
}

#[derive(Deserialize)]
struct OcDfgQuery {
    #[serde(flatten)]
    range: RangeQuery,
    /// Comma-separated object types to overlay.
    types: String,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn ocdfg(
    State(state): State<Arc<AppState>>,
    Query(query): Query<OcDfgQuery>,
) -> Result<Json<ocel_mine::OcDfg>, ApiError> {
    ensure_fresh(&state).await?;
    let guard = state.loaded.read().await;
    let loaded = guard.as_ref().ok_or_else(no_log)?;
    let log = window(&loaded.log, &query.range)?;
    let types: Vec<&str> = query
        .types
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .collect();
    if types.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "types is empty".to_owned()));
    }
    Ok(Json(ocel_mine::oc_dfg(&log, &types)))
}

#[derive(Deserialize)]
struct CasesQuery {
    #[serde(flatten)]
    range: RangeQuery,
    #[serde(rename = "type")]
    object_type: String,
    /// Activity sequence joined by the unit separator (U+001F).
    variant: Option<String>,
    /// A single transition "from<U+001F>to"; matches consecutive steps.
    edge: Option<String>,
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_limit")]
    limit: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CasesPage {
    total: usize,
    offset: usize,
    items: Vec<ocel_mine::CaseSummary>,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn cases(
    State(state): State<Arc<AppState>>,
    Query(query): Query<CasesQuery>,
) -> Result<Json<CasesPage>, ApiError> {
    ensure_fresh(&state).await?;
    let guard = state.loaded.read().await;
    let loaded = guard.as_ref().ok_or_else(no_log)?;
    let log = window(&loaded.log, &query.range)?;
    let all = ocel_mine::cases(&log, &query.object_type);
    let filtered: Vec<ocel_mine::CaseSummary> = if let Some(joined) = &query.variant {
        let want: Vec<&str> = joined.split('\u{1f}').collect();
        all.into_iter()
            .filter(|c| {
                c.activities.len() == want.len()
                    && c.activities.iter().zip(&want).all(|(a, b)| a == b)
            })
            .collect()
    } else if let Some(pair) = &query.edge {
        let mut split = pair.split('\u{1f}');
        let (from, to) = (split.next().unwrap_or(""), split.next().unwrap_or(""));
        all.into_iter()
            .filter(|c| c.activities.windows(2).any(|w| w[0] == from && w[1] == to))
            .collect()
    } else {
        all
    };
    let total = filtered.len();
    let items = filtered
        .into_iter()
        .skip(query.offset)
        .take(query.limit.min(MAX_PAGE))
        .collect();
    Ok(Json(CasesPage {
        total,
        offset: query.offset,
        items,
    }))
}

#[derive(Deserialize)]
struct CaseQuery {
    #[serde(flatten)]
    range: RangeQuery,
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaseDetail {
    object_id: String,
    items: Vec<EventRow>,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn case_detail(
    State(state): State<Arc<AppState>>,
    Query(query): Query<CaseQuery>,
) -> Result<Json<CaseDetail>, ApiError> {
    ensure_fresh(&state).await?;
    let guard = state.loaded.read().await;
    let loaded = guard.as_ref().ok_or_else(no_log)?;
    let log = window(&loaded.log, &query.range)?;
    let by_time = if matches!(log, Cow::Owned(_)) {
        time_order(&log)
    } else {
        loaded.by_time.clone()
    };
    let items: Vec<EventRow> = by_time
        .iter()
        .map(|&i| &log.events[i])
        .filter(|event| event.relationships.iter().any(|r| r.object_id == query.id))
        .map(|event| EventRow {
            id: event.id.clone(),
            event_type: event.event_type.clone(),
            time: event.time,
            objects: event
                .relationships
                .iter()
                .map(|r| RelatedObject {
                    id: r.object_id.clone(),
                    qualifier: r.qualifier.clone(),
                })
                .collect(),
        })
        .collect();
    Ok(Json(CaseDetail {
        object_id: query.id,
        items,
    }))
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn leadtimes(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DfgQuery>,
) -> Result<Json<ocel_mine::LeadTimeReport>, ApiError> {
    ensure_fresh(&state).await?;
    let guard = state.loaded.read().await;
    let loaded = guard.as_ref().ok_or_else(no_log)?;
    let log = window(&loaded.log, &query.range)?;
    Ok(Json(ocel_mine::lead_times(&log, &query.object_type)))
}

#[derive(Deserialize)]
struct ModelQuery {
    #[serde(flatten)]
    range: RangeQuery,
    #[serde(rename = "type")]
    object_type: String,
    #[serde(default)]
    algo: Option<String>,
    /// Inductive: fraction of the strongest edge below which a rare
    /// directly-follows edge is ignored.
    #[serde(default)]
    noise: Option<f64>,
    /// Heuristics: minimum dependency value for an edge.
    #[serde(default)]
    dependency: Option<f64>,
    /// Heuristics: drop edges observed fewer times than this.
    #[serde(default)]
    min_edge: Option<usize>,
}

#[derive(Serialize)]
#[serde(tag = "algo", rename_all = "camelCase")]
enum ModelResult {
    Inductive {
        tree: ocel_mine::ProcessTree,
        replay: ocel_mine::ReplayReport,
        precision: ocel_mine::PrecisionReport,
    },
    Alpha {
        net: ocel_mine::PetriNet,
        replay: ocel_mine::ReplayReport,
        precision: ocel_mine::PrecisionReport,
    },
    Heuristics {
        net: ocel_mine::HeuristicsNet,
    },
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn model(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ModelQuery>,
) -> Result<Json<ModelResult>, ApiError> {
    ensure_fresh(&state).await?;
    let guard = state.loaded.read().await;
    let loaded = guard.as_ref().ok_or_else(no_log)?;
    let log = window(&loaded.log, &query.range)?;
    let result = match query.algo.as_deref().unwrap_or("inductive") {
        "inductive" => {
            let tree = ocel_mine::inductive(
                &log,
                &query.object_type,
                query.noise.unwrap_or(0.0).clamp(0.0, 1.0),
            );
            let replay = ocel_mine::tree_replay(&log, &query.object_type, &tree);
            let precision = ocel_mine::tree_precision(&log, &query.object_type, &tree);
            ModelResult::Inductive {
                tree,
                replay,
                precision,
            }
        }
        "alpha" => {
            let net = ocel_mine::alpha(&log, &query.object_type);
            let replay = ocel_mine::net_replay(&log, &query.object_type, &net);
            let precision = ocel_mine::net_precision(&log, &query.object_type, &net);
            ModelResult::Alpha {
                net,
                replay,
                precision,
            }
        }
        "heuristics" => {
            let params = ocel_mine::HeuristicsParams {
                dependency_threshold: query.dependency.unwrap_or(0.9).clamp(0.0, 1.0),
                min_edge_frequency: query.min_edge.unwrap_or(1),
                ..ocel_mine::HeuristicsParams::default()
            };
            ModelResult::Heuristics {
                net: ocel_mine::heuristics(&log, &query.object_type, &params),
            }
        }
        other => {
            return Err((StatusCode::BAD_REQUEST, format!("unknown algo: {other}")));
        }
    };
    Ok(Json(result))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    loaded: bool,
    modified: Option<DateTime<Utc>>,
    /// Where the sample would be saved — shown in the empty state.
    data_dir: String,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn status(State(state): State<Arc<AppState>>) -> Result<Json<Status>, ApiError> {
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
async fn sample(State(state): State<Arc<AppState>>) -> Result<Json<Status>, ApiError> {
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
struct LogsResponse {
    data_dir: String,
    /// Workspace logs, newest first.
    logs: Vec<LogEntry>,
    /// Path of the active log when it lives outside the workspace.
    active_outside: Option<String>,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn logs(State(state): State<Arc<AppState>>) -> Result<Json<LogsResponse>, ApiError> {
    let active_path = state.loaded.read().await.as_ref().map(|l| l.path.clone());
    let mut logs: Vec<LogEntry> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&state.data_dir) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            // on macOS config_dir == data_dir, so the sources file would
            // otherwise show up as a .json log
            if !is_ocel_file(&path) || path == sources_file(&state.config_dir) {
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
struct OpenBody {
    /// Bare file name inside the workspace — never a path.
    name: String,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn open_log(
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

fn valid_source_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

// --- transform recipes -------------------------------------------------------

fn recipes_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("recipes")
}

/// A stored recipe plus the absolute file path a transform source needs.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecipeView {
    #[serde(flatten)]
    recipe: ocel_transform::Recipe,
    file: String,
}

fn recipe_views(config_dir: &Path) -> Vec<RecipeView> {
    let Ok(entries) = std::fs::read_dir(recipes_dir(config_dir)) else {
        return Vec::new();
    };
    let mut views: Vec<RecipeView> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|path| {
            let raw = std::fs::read_to_string(&path).ok()?;
            match serde_json::from_str::<ocel_transform::Recipe>(&raw) {
                Ok(recipe) => Some(RecipeView {
                    recipe,
                    file: path.display().to_string(),
                }),
                Err(err) => {
                    eprintln!("ignoring unreadable recipe {}: {err}", path.display());
                    None
                }
            }
        })
        .collect();
    views.sort_by(|a, b| a.recipe.name.cmp(&b.recipe.name));
    views
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn recipes_list(State(state): State<Arc<AppState>>) -> Json<Vec<RecipeView>> {
    Json(recipe_views(&state.config_dir))
}

/// Save a recipe (create or replace), one JSON file per recipe.
#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn recipes_upsert(
    State(state): State<Arc<AppState>>,
    Json(recipe): Json<ocel_transform::Recipe>,
) -> Result<Json<Vec<RecipeView>>, ApiError> {
    if !valid_source_name(&recipe.name) {
        return Err((
            StatusCode::BAD_REQUEST,
            "recipe names are 1-64 chars of letters, digits, - and _".to_owned(),
        ));
    }
    let dir = recipes_dir(&state.config_dir);
    std::fs::create_dir_all(&dir).map_err(|e| internal(&e))?;
    let raw = serde_json::to_string_pretty(&recipe).map_err(|e| internal(&e))?;
    std::fs::write(dir.join(format!("{}.json", recipe.name)), raw).map_err(|e| internal(&e))?;
    Ok(Json(recipe_views(&state.config_dir)))
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn recipes_delete(
    State(state): State<Arc<AppState>>,
    UrlPath(name): UrlPath<String>,
) -> Result<Json<Vec<RecipeView>>, ApiError> {
    if !valid_source_name(&name) {
        return Err((StatusCode::BAD_REQUEST, "not a recipe name".to_owned()));
    }
    let path = recipes_dir(&state.config_dir).join(format!("{name}.json"));
    if !path.exists() {
        return Err((StatusCode::NOT_FOUND, format!("no such recipe: {name}")));
    }
    std::fs::remove_file(&path).map_err(|e| internal(&e))?;
    Ok(Json(recipe_views(&state.config_dir)))
}

/// What a recipe would do to the currently loaded log: per-step before/after
/// counts and a sample of the events each step deletes. Nothing is written.
#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn transform_preview(
    State(state): State<Arc<AppState>>,
    Json(recipe): Json<ocel_transform::Recipe>,
) -> Result<Json<TransformPreview>, ApiError> {
    ensure_fresh(&state).await?;
    let guard = state.loaded.read().await;
    let loaded = guard.as_ref().ok_or_else(no_log)?;
    let log = loaded.log.clone();
    drop(guard);
    let (result, steps) = ocel_transform::preview(&recipe, log, PREVIEW_SAMPLE)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(TransformPreview {
        steps,
        events: result.events.len(),
        objects: result.objects.len(),
    }))
}

const PREVIEW_SAMPLE: usize = 20;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TransformPreview {
    steps: Vec<ocel_transform::StepPreview>,
    events: usize,
    objects: usize,
}

// -----------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceView {
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
async fn sources_list(State(state): State<Arc<AppState>>) -> Json<Vec<SourceView>> {
    Json(source_views(&state).await)
}

/// Register a source, or replace the one with the same name.
#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn sources_upsert(
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
async fn sources_delete(
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
    Ok(Json(source_views(&state).await))
}

/// Run a source's command (one run per source at a time). The child runs
/// with the workspace as its working directory, so a relative --out lands
/// there; stdout is reserved by the contract and discarded until v2.
#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn sources_run(
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
        let mut failed = RunState::running(Utc::now());
        failed.state = RunPhase::Failed;
        failed.finished = Some(Utc::now());
        failed.stderr_tail = Some(message);
        state.runs.write().await.insert(name.clone(), failed);
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
    if let Some(run) = state.runs.write().await.get_mut(&name) {
        run.state = phase;
        run.finished = Some(Utc::now());
        run.exit_code = exit_code;
        run.stderr_tail = stderr_tail;
    }
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
struct SecretBody {
    account: String,
    value: String,
}

/// Store a secret in the OS keychain (service `ocel-studio`). Write-only:
/// there is no endpoint that reads a secret back.
#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn secret_set(Json(body): Json<SecretBody>) -> Result<StatusCode, ApiError> {
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
async fn secret_delete(UrlPath(account): UrlPath<String>) -> Result<StatusCode, ApiError> {
    keyring::Entry::new(KEYRING_SERVICE, &account)
        .and_then(|entry| entry.delete_credential())
        .map_err(|e| internal(&e))?;
    Ok(StatusCode::NO_CONTENT)
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
