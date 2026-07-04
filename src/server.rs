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
use tokio::io::AsyncReadExt;

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

/// The most recently modified OCEL file in the data directory, if any.
/// The sources config is never a log (on macOS `config_dir` == `data_dir`).
pub fn latest_log(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| is_ocel_file(p) && p.file_name() != Some(std::ffi::OsStr::new("sources.json")))
        .max_by_key(|p| {
            std::fs::metadata(p)
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH)
        })
}

struct Loaded {
    path: PathBuf,
    modified: SystemTime,
    log: ocel::Ocel,
    by_time: Vec<usize>,
    violations: Vec<String>,
    type_stats: Vec<ocel_mine::TypeStats>,
}

/// A registered data source: a command that (re)writes one OCEL file in the
/// workspace (connector contract v1). Secrets are out of scope here — env
/// injection from the OS keychain arrives with contract v2 support.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceConfig {
    name: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum RunPhase {
    Running,
    Succeeded,
    Failed,
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
    initial: Option<PathBuf>,
    data_dir: PathBuf,
    config_dir: PathBuf,
    port: u16,
) -> Result<(), Box<dyn Error>> {
    let loaded = if let Some(path) = initial {
        let loaded = load(&path)?;
        eprintln!(
            "opened {}: {} events / {} objects",
            path.display(),
            loaded.log.events.len(),
            loaded.log.objects.len()
        );
        Some(loaded)
    } else {
        eprintln!("no log loaded — the studio offers the official sample on first visit");
        None
    };
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
    },
    Alpha {
        net: ocel_mine::PetriNet,
        replay: ocel_mine::ReplayReport,
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
            ModelResult::Inductive { tree, replay }
        }
        "alpha" => {
            let net = ocel_mine::alpha(&log, &query.object_type);
            let replay = ocel_mine::net_replay(&log, &query.object_type, &net);
            ModelResult::Alpha { net, replay }
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
        runs.insert(
            name.clone(),
            RunState {
                state: RunPhase::Running,
                started: Utc::now(),
                finished: None,
                exit_code: None,
                stderr_tail: None,
            },
        );
    }

    std::fs::create_dir_all(&state.data_dir).map_err(|e| internal(&e))?;
    let spawned = tokio::process::Command::new(&config.command)
        .args(&config.args)
        .current_dir(&state.data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(err) => {
            state.runs.write().await.insert(
                name.clone(),
                RunState {
                    state: RunPhase::Failed,
                    started: Utc::now(),
                    finished: Some(Utc::now()),
                    exit_code: None,
                    stderr_tail: Some(err.to_string()),
                },
            );
            return Ok(Json(source_views(&state).await));
        }
    };

    let watcher_state = Arc::clone(&state);
    tokio::spawn(async move {
        const TAIL: usize = 8 * 1024;
        let mut tail: Vec<u8> = Vec::new();
        if let Some(mut stderr) = child.stderr.take() {
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
        let status = child.wait().await;
        let (phase, exit_code) = match status {
            Ok(status) if status.success() => (RunPhase::Succeeded, status.code()),
            Ok(status) => (RunPhase::Failed, status.code()),
            Err(_) => (RunPhase::Failed, None),
        };
        let stderr_tail = (phase == RunPhase::Failed && !tail.is_empty())
            .then(|| String::from_utf8_lossy(&tail).into_owned());
        if let Some(run) = watcher_state.runs.write().await.get_mut(&name) {
            run.state = phase;
            run.finished = Some(Utc::now());
            run.exit_code = exit_code;
            run.stderr_tail = stderr_tail;
        }
    });

    Ok(Json(source_views(&state).await))
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
