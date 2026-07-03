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

use axum::extract::{Query, State};
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

const MAX_PAGE: usize = 500;

#[derive(RustEmbed)]
#[folder = "frontend/dist/"]
struct Assets;

struct Loaded {
    modified: SystemTime,
    log: ocel::Ocel,
    by_time: Vec<usize>,
    violations: Vec<String>,
    type_stats: Vec<ocel_mine::TypeStats>,
}

struct AppState {
    path: PathBuf,
    loaded: RwLock<Loaded>,
}

type ApiError = (StatusCode, String);

pub async fn run(path: PathBuf, port: u16) -> Result<(), Box<dyn Error>> {
    let loaded = load(&path)?;
    eprintln!(
        "opened {}: {} events / {} objects",
        path.display(),
        loaded.log.events.len(),
        loaded.log.objects.len()
    );
    let state = Arc::new(AppState {
        path,
        loaded: RwLock::new(loaded),
    });

    let app = Router::new()
        .route("/api/summary", get(summary))
        .route("/api/events", get(events))
        .route("/api/variants", get(variants))
        .route("/api/dfg", get(dfg))
        .route("/api/model", get(model))
        .route("/api/leadtimes", get(leadtimes))
        .route("/api/status", get(status))
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

/// Re-read the log when the file changed on disk since the loaded snapshot.
async fn ensure_fresh(state: &AppState) -> Result<(), ApiError> {
    let modified = std::fs::metadata(&state.path)
        .and_then(|m| m.modified())
        .map_err(|e| internal(&e))?;
    if state.loaded.read().await.modified != modified {
        let loaded = load(&state.path).map_err(|e| internal(&*e))?;
        eprintln!(
            "reloaded {}: {} events / {} objects",
            state.path.display(),
            loaded.log.events.len(),
            loaded.log.objects.len()
        );
        *state.loaded.write().await = loaded;
    }
    Ok(())
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
async fn summary(State(state): State<Arc<AppState>>) -> Result<Json<Summary>, ApiError> {
    ensure_fresh(&state).await?;
    let loaded = state.loaded.read().await;
    let log = &loaded.log;
    let time_range = (!loaded.by_time.is_empty()).then(|| TimeRange {
        start: log.events[loaded.by_time[0]].time,
        end: log.events[loaded.by_time[loaded.by_time.len() - 1]].time,
    });
    Ok(Json(Summary {
        path: state.path.display().to_string(),
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
        type_stats: loaded.type_stats.clone(),
        time_range,
        violations: loaded.violations.clone(),
    }))
}

#[derive(Deserialize)]
struct PageQuery {
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
    let loaded = state.loaded.read().await;
    let log = &loaded.log;
    let limit = page.limit.min(MAX_PAGE);
    let items = loaded
        .by_time
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
        total: loaded.by_time.len(),
        offset: page.offset,
        items,
    }))
}

#[derive(Deserialize)]
struct VariantsQuery {
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
    let loaded = state.loaded.read().await;
    let mut report = ocel_mine::variants(&loaded.log, &query.object_type);
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
    #[serde(rename = "type")]
    object_type: String,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn dfg(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DfgQuery>,
) -> Result<Json<ocel_mine::Dfg>, ApiError> {
    ensure_fresh(&state).await?;
    let loaded = state.loaded.read().await;
    Ok(Json(ocel_mine::dfg(&loaded.log, &query.object_type)))
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn leadtimes(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DfgQuery>,
) -> Result<Json<ocel_mine::LeadTimeReport>, ApiError> {
    ensure_fresh(&state).await?;
    let loaded = state.loaded.read().await;
    Ok(Json(ocel_mine::lead_times(&loaded.log, &query.object_type)))
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn model(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DfgQuery>,
) -> Result<Json<ocel_mine::ProcessTree>, ApiError> {
    ensure_fresh(&state).await?;
    let loaded = state.loaded.read().await;
    Ok(Json(ocel_mine::inductive(&loaded.log, &query.object_type)))
}

#[derive(Serialize)]
struct Status {
    modified: DateTime<Utc>,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
async fn status(State(state): State<Arc<AppState>>) -> Result<Json<Status>, ApiError> {
    let modified = std::fs::metadata(&state.path)
        .and_then(|m| m.modified())
        .map_err(|e| internal(&e))?;
    Ok(Json(Status {
        modified: modified.into(),
    }))
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
