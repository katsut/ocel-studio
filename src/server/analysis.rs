//! Read-only analysis endpoints over the declaration the request carries:
//! the loaded log, put through a recipe, narrowed to what the case type
//! reaches, then cut to the period.

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLockReadGuard;

use super::recipes::load_recipe;
use super::{ensure_fresh, internal, no_log, ApiError, AppState, Loaded, Resolved, ResolvedKey};

const MAX_PAGE: usize = 500;

/// One analysis declaration as it travels on the URL. The frontend expands a
/// saved declaration set into these parameters, so a named set and an unnamed
/// one take exactly the same path through the server.
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ViewQuery {
    /// The case type. Required by every handler that mines a flow; summary
    /// and events work without one.
    #[serde(rename = "type")]
    pub(super) object_type: Option<String>,
    pub(super) from: Option<String>,
    pub(super) to: Option<String>,
    /// Name of a stored recipe, applied before anything else.
    pub(super) recipe: Option<String>,
    /// Comma-separated object types the reachability walk may pass through.
    pub(super) via: Option<String>,
    /// Comma-separated object types the walk stops at.
    pub(super) not_via: Option<String>,
}

impl ViewQuery {
    pub(super) fn required_type(&self) -> Result<&str, ApiError> {
        self.object_type
            .as_deref()
            .filter(|t| !t.is_empty())
            .ok_or_else(|| (StatusCode::BAD_REQUEST, "type is required".to_owned()))
    }

    pub(super) fn window<'a>(&self, log: &'a ocel::Ocel) -> Result<Cow<'a, ocel::Ocel>, ApiError> {
        window(log, self.from.as_deref(), self.to.as_deref())
    }
}

pub(super) fn split_types(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

/// `via` and `notVia` are two readings of the same walk; a declaration that
/// carries both states nothing definite.
pub(super) fn exclusive(via: &[String], not_via: &[String]) -> Result<(), ApiError> {
    if via.is_empty() || not_via.is_empty() {
        return Ok(());
    }
    Err((
        StatusCode::BAD_REQUEST,
        "via and notVia are mutually exclusive".to_owned(),
    ))
}

/// The log a declaration resolves to, holding the locks that own it: the
/// loaded snapshot for provenance, and the cached resolution when the
/// declaration asked for one.
pub(super) struct Resolution<'a> {
    loaded: RwLockReadGuard<'a, Loaded>,
    resolved: Option<RwLockReadGuard<'a, Resolved>>,
}

impl Resolution<'_> {
    pub(super) fn log(&self) -> &ocel::Ocel {
        self.resolved.as_ref().map_or(&self.loaded.log, |r| &r.log)
    }

    fn by_time(&self) -> &[usize] {
        self.resolved
            .as_ref()
            .map_or(self.loaded.by_time.as_slice(), |r| r.by_time.as_slice())
    }

    fn type_stats(&self) -> &[ocel_mine::TypeStats] {
        self.resolved
            .as_ref()
            .map_or(self.loaded.type_stats.as_slice(), |r| {
                r.type_stats.as_slice()
            })
    }
}

/// Apply the declaration's recipe and reachability filter to a log.
fn resolve_log(
    loaded: &Loaded,
    config_dir: &Path,
    key: &ResolvedKey,
) -> Result<ocel::Ocel, ApiError> {
    let base_dir = loaded
        .path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    let mut log = loaded.log.clone();
    if let Some(name) = &key.recipe {
        let recipe = load_recipe(config_dir, name)?;
        log = ocel_transform::apply(&recipe, log, &base_dir)
            .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
            .0;
    }
    if let Some(object_type) = &key.object_type {
        let recipe = ocel_transform::Recipe {
            name: "declaration".to_owned(),
            steps: vec![ocel_transform::Step::KeepRelatedTo(
                ocel_transform::RelatedTo {
                    object_type: object_type.clone(),
                    via: (!key.via.is_empty()).then(|| key.via.clone()),
                    not_via: (!key.not_via.is_empty()).then(|| key.not_via.clone()),
                },
            )],
        };
        log = ocel_transform::apply(&recipe, log, &base_dir)
            .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
            .0;
    }
    Ok(log)
}

/// The key a declaration resolves under. Without a case type there is
/// nothing to walk from, so `via` / `notVia` are dropped and summary and
/// events still answer.
fn resolved_key(
    modified: std::time::SystemTime,
    view: &ViewQuery,
) -> Result<ResolvedKey, ApiError> {
    let via = split_types(view.via.as_deref());
    let not_via = split_types(view.not_via.as_deref());
    exclusive(&via, &not_via)?;
    let walks = !via.is_empty() || !not_via.is_empty();
    let object_type = view
        .object_type
        .as_deref()
        .filter(|t| !t.is_empty() && walks)
        .map(ToOwned::to_owned);
    let (via, not_via) = if object_type.is_some() {
        (via, not_via)
    } else {
        (Vec::new(), Vec::new())
    };
    Ok(ResolvedKey {
        modified,
        recipe: view
            .recipe
            .as_deref()
            .filter(|n| !n.is_empty())
            .map(ToOwned::to_owned),
        object_type,
        via,
        not_via,
    })
}

/// Resolve the declaration to a log every handler then aggregates over.
/// A declaration that neither transforms nor narrows borrows the loaded log
/// as-is; anything else is computed once and cached, keyed on the file's
/// mtime and the declaration itself.
pub(super) async fn resolve<'a>(
    state: &'a AppState,
    view: &ViewQuery,
) -> Result<Resolution<'a>, ApiError> {
    ensure_fresh(state).await?;
    let guard = state.loaded.read().await;
    let loaded = RwLockReadGuard::try_map(guard, Option::as_ref).map_err(|_| no_log())?;
    let key = resolved_key(loaded.modified, view)?;
    if key.recipe.is_none() && key.object_type.is_none() {
        return Ok(Resolution {
            loaded,
            resolved: None,
        });
    }
    {
        let cached = state.resolved.read().await;
        if cached.as_ref().is_some_and(|r| r.key == key) {
            let resolved = RwLockReadGuard::try_map(cached, Option::as_ref)
                .map_err(|_| internal("the cached resolution disappeared"))?;
            return Ok(Resolution {
                loaded,
                resolved: Some(resolved),
            });
        }
    }
    let log = resolve_log(&loaded, &state.config_dir, &key)?;
    let entry = Resolved {
        key,
        by_time: time_order(&log),
        type_stats: ocel_mine::type_stats(&log),
        log,
    };
    let mut slot = state.resolved.write().await;
    *slot = Some(entry);
    let resolved = RwLockReadGuard::try_map(slot.downgrade(), Option::as_ref)
        .map_err(|_| internal("the cached resolution disappeared"))?;
    Ok(Resolution {
        loaded,
        resolved: Some(resolved),
    })
}

fn parse_day(s: &str) -> Result<NaiveDate, ApiError> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("bad date {s}: {e}")))
}

/// Borrow the log as-is, or build a windowed copy holding only the events
/// inside the range (all declarations and objects are kept). Cases spanning
/// the boundary appear truncated — stated in the UI guide.
pub(super) fn window<'a>(
    log: &'a ocel::Ocel,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Cow<'a, ocel::Ocel>, ApiError> {
    if from.is_none() && to.is_none() {
        return Ok(Cow::Borrowed(log));
    }
    let from: Option<DateTime<Utc>> = from
        .map(parse_day)
        .transpose()?
        .map(|d| d.and_hms_opt(0, 0, 0).expect("midnight is valid").and_utc());
    let to: Option<DateTime<Utc>> = to.map(parse_day).transpose()?.map(|d| {
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

/// Time-sorted event indices.
pub(super) fn time_order(log: &ocel::Ocel) -> Vec<usize> {
    let mut order: Vec<usize> = (0..log.events.len()).collect();
    order.sort_unstable_by_key(|&i| (log.events[i].time, i));
    order
}

/// Event order for a log that may have been windowed after resolution.
fn order_for(resolution: &Resolution<'_>, log: &ocel::Ocel, windowed: bool) -> Vec<usize> {
    if windowed {
        time_order(log)
    } else {
        resolution.by_time().to_vec()
    }
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
    Query(view): Query<ViewQuery>,
) -> Result<Json<Summary>, ApiError> {
    let resolution = resolve(&state, &view).await?;
    let log = view.window(resolution.log())?;
    let windowed = matches!(log, Cow::Owned(_));
    let by_time = order_for(&resolution, &log, windowed);
    let time_range = (!by_time.is_empty()).then(|| TimeRange {
        start: log.events[by_time[0]].time,
        end: log.events[by_time[by_time.len() - 1]].time,
    });
    Ok(Json(Summary {
        path: resolution.loaded.path.display().to_string(),
        modified: resolution.loaded.modified.into(),
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
            resolution.type_stats().to_vec()
        },
        time_range,
        violations: resolution.loaded.violations.clone(),
    }))
}

#[derive(Deserialize)]
pub(super) struct PageQuery {
    #[serde(flatten)]
    view: ViewQuery,
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

fn event_row(event: &ocel::Event) -> EventRow {
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
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn events(
    State(state): State<Arc<AppState>>,
    Query(page): Query<PageQuery>,
) -> Result<Json<EventsPage>, ApiError> {
    let resolution = resolve(&state, &page.view).await?;
    let log = page.view.window(resolution.log())?;
    let by_time = order_for(&resolution, &log, matches!(log, Cow::Owned(_)));
    let limit = page.limit.min(MAX_PAGE);
    let items = by_time
        .iter()
        .skip(page.offset)
        .take(limit)
        .map(|&i| event_row(&log.events[i]))
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
    view: ViewQuery,
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
    let object_type = query.view.required_type()?.to_owned();
    let resolution = resolve(&state, &query.view).await?;
    let log = query.view.window(resolution.log())?;
    let mut report = ocel_mine::variants(&log, &object_type);
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

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn dfg(
    State(state): State<Arc<AppState>>,
    Query(view): Query<ViewQuery>,
) -> Result<Json<ocel_mine::Dfg>, ApiError> {
    let object_type = view.required_type()?.to_owned();
    let resolution = resolve(&state, &view).await?;
    let log = view.window(resolution.log())?;
    Ok(Json(ocel_mine::dfg(&log, &object_type)))
}

#[derive(Deserialize)]
pub(super) struct OcDfgQuery {
    #[serde(flatten)]
    view: ViewQuery,
    /// Comma-separated object types to overlay.
    types: String,
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn ocdfg(
    State(state): State<Arc<AppState>>,
    Query(query): Query<OcDfgQuery>,
) -> Result<Json<ocel_mine::OcDfg>, ApiError> {
    let types: Vec<&str> = query
        .types
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .collect();
    let Some(first) = types.first() else {
        return Err((StatusCode::BAD_REQUEST, "types is empty".to_owned()));
    };
    // the overlay shows several types, but the walk needs one seed
    let view = ViewQuery {
        object_type: Some((*first).to_owned()),
        ..query.view.clone()
    };
    let resolution = resolve(&state, &view).await?;
    let log = view.window(resolution.log())?;
    Ok(Json(ocel_mine::oc_dfg(&log, &types)))
}

#[derive(Deserialize)]
pub(super) struct CasesQuery {
    #[serde(flatten)]
    view: ViewQuery,
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
    let object_type = query.view.required_type()?.to_owned();
    let resolution = resolve(&state, &query.view).await?;
    let log = query.view.window(resolution.log())?;
    let all = ocel_mine::cases(&log, &object_type);
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
    view: ViewQuery,
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
    let resolution = resolve(&state, &query.view).await?;
    let log = query.view.window(resolution.log())?;
    let by_time = order_for(&resolution, &log, matches!(log, Cow::Owned(_)));
    let items: Vec<EventRow> = by_time
        .iter()
        .map(|&i| &log.events[i])
        .filter(|event| event.relationships.iter().any(|r| r.object_id == query.id))
        .map(event_row)
        .collect();
    Ok(Json(CaseDetail {
        object_id: query.id,
        items,
    }))
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn leadtimes(
    State(state): State<Arc<AppState>>,
    Query(view): Query<ViewQuery>,
) -> Result<Json<ocel_mine::LeadTimeReport>, ApiError> {
    let object_type = view.required_type()?.to_owned();
    let resolution = resolve(&state, &view).await?;
    let log = view.window(resolution.log())?;
    Ok(Json(ocel_mine::lead_times(&log, &object_type)))
}

#[derive(Deserialize)]
pub(super) struct ModelQuery {
    #[serde(flatten)]
    view: ViewQuery,
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
    let object_type = query.view.required_type()?.to_owned();
    let resolution = resolve(&state, &query.view).await?;
    let log = query.view.window(resolution.log())?;
    let result = match query.algo.as_deref().unwrap_or("inductive") {
        "inductive" => {
            let tree = ocel_mine::inductive(
                &log,
                &object_type,
                query.noise.unwrap_or(0.0).clamp(0.0, 1.0),
            );
            let replay = ocel_mine::tree_replay(&log, &object_type, &tree);
            let precision = ocel_mine::tree_precision(&log, &object_type, &tree);
            ModelResult::Inductive {
                tree,
                replay,
                precision,
            }
        }
        "powl" => {
            let model = ocel_mine::powl(
                &log,
                &object_type,
                query.noise.unwrap_or(0.0).clamp(0.0, 1.0),
            );
            let replay = ocel_mine::powl_replay(&log, &object_type, &model);
            let precision = ocel_mine::powl_precision(&log, &object_type, &model);
            ModelResult::Powl {
                model,
                replay,
                precision,
            }
        }
        "alpha" => {
            let net = ocel_mine::alpha(&log, &object_type);
            let replay = ocel_mine::net_replay(&log, &object_type, &net);
            let precision = ocel_mine::net_precision(&log, &object_type, &net);
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
                net: ocel_mine::heuristics(&log, &object_type, &params),
            }
        }
        other => {
            return Err((StatusCode::BAD_REQUEST, format!("unknown algo: {other}")));
        }
    };
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::SystemTime;

    use super::*;

    fn event(id: &str, event_type: &str, day: u32, object: &str) -> ocel::Event {
        ocel::Event {
            id: id.to_owned(),
            event_type: event_type.to_owned(),
            time: NaiveDate::from_ymd_opt(2026, 4, day)
                .expect("valid day")
                .and_hms_opt(9, 0, 0)
                .expect("valid time")
                .and_utc(),
            attributes: Vec::new(),
            relationships: vec![ocel::Relationship {
                object_id: object.to_owned(),
                qualifier: "subject".to_owned(),
            }],
        }
    }

    fn object(id: &str, object_type: &str) -> ocel::Object {
        ocel::Object {
            id: id.to_owned(),
            object_type: object_type.to_owned(),
            attributes: Vec::new(),
            relationships: Vec::new(),
        }
    }

    /// Two unconnected islands: an order with one event, a ticket with
    /// another. Nothing links them, so a walk seeded on orders must not
    /// reach the ticket.
    fn two_islands() -> ocel::Ocel {
        ocel::Ocel {
            event_types: vec![
                ocel::EventType {
                    name: "placed".to_owned(),
                    attributes: Vec::new(),
                },
                ocel::EventType {
                    name: "asked".to_owned(),
                    attributes: Vec::new(),
                },
            ],
            object_types: vec![
                ocel::ObjectType {
                    name: "order".to_owned(),
                    attributes: Vec::new(),
                },
                ocel::ObjectType {
                    name: "ticket".to_owned(),
                    attributes: Vec::new(),
                },
            ],
            events: vec![
                event("e1", "placed", 1, "o1"),
                event("e2", "asked", 2, "t1"),
            ],
            objects: vec![object("o1", "order"), object("t1", "ticket")],
        }
    }

    fn loaded(log: ocel::Ocel) -> Loaded {
        let by_time = time_order(&log);
        Loaded {
            path: PathBuf::from("/nonexistent/log.json"),
            modified: SystemTime::UNIX_EPOCH,
            log,
            by_time,
            violations: Vec::new(),
            type_stats: Vec::new(),
        }
    }

    fn view(object_type: Option<&str>, via: Option<&str>, not_via: Option<&str>) -> ViewQuery {
        ViewQuery {
            object_type: object_type.map(ToOwned::to_owned),
            via: via.map(ToOwned::to_owned),
            not_via: not_via.map(ToOwned::to_owned),
            ..ViewQuery::default()
        }
    }

    #[test]
    fn via_narrows_the_log_to_what_the_case_type_reaches() {
        let loaded = loaded(two_islands());
        let key = resolved_key(loaded.modified, &view(Some("order"), Some("order"), None))
            .expect("key builds");
        let resolved = resolve_log(&loaded, Path::new("."), &key).expect("resolves");
        assert_eq!(resolved.objects.len(), 1);
        assert_eq!(resolved.objects[0].id, "o1");
        let ids: Vec<&str> = resolved.events.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["e1"]);
    }

    #[test]
    fn not_via_keeps_everything_the_walk_can_still_reach() {
        let loaded = loaded(two_islands());
        let key = resolved_key(loaded.modified, &view(Some("order"), None, Some("ticket")))
            .expect("key builds");
        let resolved = resolve_log(&loaded, Path::new("."), &key).expect("resolves");
        let ids: Vec<&str> = resolved.events.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["e1"]);
    }

    #[test]
    fn via_and_not_via_together_are_rejected() {
        match resolved_key(
            SystemTime::UNIX_EPOCH,
            &view(Some("order"), Some("order"), Some("ticket")),
        ) {
            Ok(_) => panic!("via and notVia together must be rejected"),
            Err(err) => assert_eq!(err.0, StatusCode::BAD_REQUEST),
        }
    }

    #[test]
    fn without_a_type_the_walk_is_skipped() {
        let key = resolved_key(SystemTime::UNIX_EPOCH, &view(None, Some("order"), None))
            .expect("key builds");
        assert!(key.object_type.is_none());
        assert!(key.via.is_empty());
        assert!(key.recipe.is_none());
    }

    #[test]
    fn a_plain_declaration_needs_no_resolution() {
        let key = resolved_key(SystemTime::UNIX_EPOCH, &view(Some("order"), None, None))
            .expect("key builds");
        assert!(key.object_type.is_none());
        assert!(key.recipe.is_none());
    }

    #[test]
    fn the_period_is_cut_after_resolution() {
        let log = two_islands();
        let cut = window(&log, Some("2026-04-02"), None).expect("windows");
        let ids: Vec<&str> = cut.events.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["e2"]);
        assert!(matches!(
            window(&log, None, None).expect("borrows"),
            Cow::Borrowed(_)
        ));
    }
}
