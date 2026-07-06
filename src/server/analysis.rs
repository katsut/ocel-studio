//! Read-only analysis endpoints over the loaded log, with an optional time window.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

use super::{ensure_fresh, no_log, ApiError, AppState};

const MAX_PAGE: usize = 500;

/// Optional global time window (dates, inclusive). Filters events; cases
/// spanning the boundary appear truncated — stated in the UI guide.
#[derive(Deserialize, Default)]
pub(super) struct RangeQuery {
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
pub(super) struct Summary {
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
pub(super) async fn summary(
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
pub(super) struct PageQuery {
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
pub(super) struct EventsPage {
    total: usize,
    offset: usize,
    items: Vec<EventRow>,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn events(
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
pub(super) struct VariantsQuery {
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
pub(super) struct VariantsResponse {
    object_type: String,
    objects: usize,
    with_events: usize,
    total_variants: usize,
    variants: Vec<ocel_mine::Variant>,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn variants(
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
pub(super) struct DfgQuery {
    #[serde(flatten)]
    range: RangeQuery,
    #[serde(rename = "type")]
    object_type: String,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn dfg(
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
pub(super) struct OcDfgQuery {
    #[serde(flatten)]
    range: RangeQuery,
    /// Comma-separated object types to overlay.
    types: String,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn ocdfg(
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
pub(super) struct CasesQuery {
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
pub(super) struct CasesPage {
    total: usize,
    offset: usize,
    items: Vec<ocel_mine::CaseSummary>,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn cases(
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
pub(super) struct CaseQuery {
    #[serde(flatten)]
    range: RangeQuery,
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CaseDetail {
    object_id: String,
    items: Vec<EventRow>,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn case_detail(
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
pub(super) async fn leadtimes(
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
pub(super) struct ModelQuery {
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
pub(super) enum ModelResult {
    Inductive {
        tree: ocel_mine::ProcessTree,
        replay: ocel_mine::ReplayReport,
        precision: ocel_mine::PrecisionReport,
    },
    Powl {
        model: ocel_mine::Powl,
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
pub(super) async fn model(
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
        "powl" => {
            let model = ocel_mine::powl(
                &log,
                &query.object_type,
                query.noise.unwrap_or(0.0).clamp(0.0, 1.0),
            );
            let replay = ocel_mine::powl_replay(&log, &query.object_type, &model);
            let precision = ocel_mine::powl_precision(&log, &query.object_type, &model);
            ModelResult::Powl {
                model,
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
