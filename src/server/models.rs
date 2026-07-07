//! Registered models: a registration freezes an agreement — object type,
//! scope (the time window it was mined on), algorithm, params, and the
//! discovered model itself — one JSON file per model under
//! `<config_dir>/models/`. Conformance replays the *current* log (honoring
//! the header time window) against a frozen model, so drift from the agreed
//! standard becomes visible period by period.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::analysis::{window, RangeQuery};
use super::sources::valid_source_name;
use super::{ensure_fresh, internal, no_log, ApiError, AppState};

fn models_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("models")
}

/// The time window the model was mined on (dates, inclusive; open ends
/// allowed). Kept for the record — conformance uses the *request's* window.
#[derive(Clone, Default, Serialize, Deserialize)]
struct Scope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    to: Option<String>,
}

/// Discovery tuning as frozen at registration (effective values, not the
/// raw request). Only `noise` applies to the registrable algorithms today;
/// the other knobs keep the stored shape stable.
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    noise: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dependency: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    min_edge: Option<usize>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fitness {
    fitting: usize,
    traces: usize,
}

/// What the scoped log looked like when the agreement was frozen — the
/// baseline the conformance screen shows next to fresh results.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    log_file: String,
    events: usize,
    objects: usize,
    fitness: Fitness,
    precision: f64,
}

/// Everything about a registered model except the model payload — what the
/// list endpoint returns.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModelMeta {
    name: String,
    #[serde(default)]
    note: String,
    created_at: DateTime<Utc>,
    object_type: String,
    #[serde(default)]
    scope: Scope,
    algo: String,
    #[serde(default)]
    params: Params,
    snapshot: Snapshot,
}

/// One stored registration: the meta plus the frozen model exactly as the
/// model endpoint serializes it (`ProcessTree` / `Powl` / `PetriNet` JSON,
/// discriminated by `algo`).
#[derive(Serialize, Deserialize)]
struct ModelRecord {
    #[serde(flatten)]
    meta: ModelMeta,
    model: serde_json::Value,
}

// --- Deserialize mirrors -----------------------------------------------------
// ocel-mine's model types derive only `Serialize`; these mirror the exact
// same JSON shapes so a frozen model can be rebuilt for replay.

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum TreeJson {
    Activity { label: String },
    Tau,
    Sequence { children: Vec<TreeJson> },
    Exclusive { children: Vec<TreeJson> },
    Parallel { children: Vec<TreeJson> },
    Loop { children: Vec<TreeJson> },
}

impl From<TreeJson> for ocel_mine::ProcessTree {
    fn from(tree: TreeJson) -> Self {
        let map = |children: Vec<TreeJson>| children.into_iter().map(Into::into).collect();
        match tree {
            TreeJson::Activity { label } => Self::Activity { label },
            TreeJson::Tau => Self::Tau,
            TreeJson::Sequence { children } => Self::Sequence {
                children: map(children),
            },
            TreeJson::Exclusive { children } => Self::Exclusive {
                children: map(children),
            },
            TreeJson::Parallel { children } => Self::Parallel {
                children: map(children),
            },
            TreeJson::Loop { children } => Self::Loop {
                children: map(children),
            },
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PowlJson {
    Activity {
        label: String,
    },
    Tau,
    Exclusive {
        children: Vec<PowlJson>,
    },
    Loop {
        children: Vec<PowlJson>,
    },
    PartialOrder {
        children: Vec<PowlJson>,
        order: Vec<(usize, usize)>,
    },
}

impl From<PowlJson> for ocel_mine::Powl {
    fn from(model: PowlJson) -> Self {
        let map = |children: Vec<PowlJson>| children.into_iter().map(Into::into).collect();
        match model {
            PowlJson::Activity { label } => Self::Activity { label },
            PowlJson::Tau => Self::Tau,
            PowlJson::Exclusive { children } => Self::Exclusive {
                children: map(children),
            },
            PowlJson::Loop { children } => Self::Loop {
                children: map(children),
            },
            PowlJson::PartialOrder { children, order } => Self::PartialOrder {
                children: map(children),
                order,
            },
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaceJson {
    id: String,
    inputs: Vec<String>,
    outputs: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetriNetJson {
    object_type: String,
    transitions: Vec<String>,
    places: Vec<PlaceJson>,
    warnings: Vec<String>,
}

impl From<PetriNetJson> for ocel_mine::PetriNet {
    fn from(net: PetriNetJson) -> Self {
        Self {
            object_type: net.object_type,
            transitions: net.transitions,
            places: net
                .places
                .into_iter()
                .map(|p| ocel_mine::Place {
                    id: p.id,
                    inputs: p.inputs,
                    outputs: p.outputs,
                })
                .collect(),
            warnings: net.warnings,
        }
    }
}

// --- registry ------------------------------------------------------------------

fn model_views(config_dir: &Path) -> Vec<ModelMeta> {
    let Ok(entries) = std::fs::read_dir(models_dir(config_dir)) else {
        return Vec::new();
    };
    let mut views: Vec<ModelMeta> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|path| {
            let raw = std::fs::read_to_string(&path).ok()?;
            match serde_json::from_str::<ModelRecord>(&raw) {
                Ok(record) => Some(record.meta),
                Err(err) => {
                    eprintln!("ignoring unreadable model {}: {err}", path.display());
                    None
                }
            }
        })
        .collect();
    views.sort_by(|a, b| a.name.cmp(&b.name));
    views
}

fn load_record(config_dir: &Path, name: &str) -> Result<ModelRecord, ApiError> {
    let path = models_dir(config_dir).join(format!("{name}.json"));
    let raw = std::fs::read_to_string(&path)
        .map_err(|_| (StatusCode::NOT_FOUND, format!("no such model: {name}")))?;
    serde_json::from_str(&raw).map_err(|e| internal(&e))
}

fn has_object_type(log: &ocel::Ocel, name: &str) -> bool {
    log.object_types.iter().any(|t| t.name == name)
        || log.objects.iter().any(|o| o.object_type == name)
}

fn clean(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.is_empty())
}

/// Mine the scoped log with the requested algorithm and freeze the result:
/// the model's JSON, its evaluation, and the effective params. Only the
/// algorithms with replay + precision can become an agreement — a standard
/// you cannot check against is not a standard.
fn freeze(
    log: &ocel::Ocel,
    object_type: &str,
    algo: &str,
    requested: Params,
) -> Result<
    (
        serde_json::Value,
        ocel_mine::ReplayReport,
        ocel_mine::PrecisionReport,
        Params,
    ),
    ApiError,
> {
    let noise = requested.noise.unwrap_or(0.0).clamp(0.0, 1.0);
    let with_noise = Params {
        noise: Some(noise),
        ..Params::default()
    };
    match algo {
        "inductive" => {
            let tree = ocel_mine::inductive(log, object_type, noise);
            let replay = ocel_mine::tree_replay(log, object_type, &tree);
            let precision = ocel_mine::tree_precision(log, object_type, &tree);
            let json = serde_json::to_value(&tree).map_err(|e| internal(&e))?;
            Ok((json, replay, precision, with_noise))
        }
        "powl" => {
            let model = ocel_mine::powl(log, object_type, noise);
            let replay = ocel_mine::powl_replay(log, object_type, &model);
            let precision = ocel_mine::powl_precision(log, object_type, &model);
            let json = serde_json::to_value(&model).map_err(|e| internal(&e))?;
            Ok((json, replay, precision, with_noise))
        }
        "alpha" => {
            let net = ocel_mine::alpha(log, object_type);
            let replay = ocel_mine::net_replay(log, object_type, &net);
            let precision = ocel_mine::net_precision(log, object_type, &net);
            let json = serde_json::to_value(&net).map_err(|e| internal(&e))?;
            Ok((json, replay, precision, Params::default()))
        }
        other => Err((
            StatusCode::BAD_REQUEST,
            format!("algo must be inductive, powl or alpha — '{other}' has no replay/precision to check against"),
        )),
    }
}

/// Rebuild a frozen model from its stored JSON and replay the (windowed)
/// current log against it.
fn evaluate(
    log: &ocel::Ocel,
    object_type: &str,
    algo: &str,
    model: serde_json::Value,
) -> Result<(ocel_mine::ReplayReport, ocel_mine::PrecisionReport), ApiError> {
    match algo {
        "inductive" => {
            let tree: TreeJson = serde_json::from_value(model).map_err(|e| internal(&e))?;
            let tree = ocel_mine::ProcessTree::from(tree);
            Ok((
                ocel_mine::tree_replay(log, object_type, &tree),
                ocel_mine::tree_precision(log, object_type, &tree),
            ))
        }
        "powl" => {
            let powl: PowlJson = serde_json::from_value(model).map_err(|e| internal(&e))?;
            let powl = ocel_mine::Powl::from(powl);
            Ok((
                ocel_mine::powl_replay(log, object_type, &powl),
                ocel_mine::powl_precision(log, object_type, &powl),
            ))
        }
        "alpha" => {
            let net: PetriNetJson = serde_json::from_value(model).map_err(|e| internal(&e))?;
            let net = ocel_mine::PetriNet::from(net);
            Ok((
                ocel_mine::net_replay(log, object_type, &net),
                ocel_mine::net_precision(log, object_type, &net),
            ))
        }
        other => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("stored model has unknown algo '{other}'"),
        )),
    }
}

// --- handlers ------------------------------------------------------------------

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn models_list(State(state): State<Arc<AppState>>) -> Json<Vec<ModelMeta>> {
    Json(model_views(&state.config_dir))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RegisterBody {
    name: String,
    #[serde(default)]
    note: String,
    object_type: String,
    algo: String,
    #[serde(default)]
    params: Params,
    #[serde(default)]
    scope: Scope,
}

/// Register a model: re-mine the scoped (time-windowed) log with the given
/// params and freeze the result. Registration never overwrites — delete
/// first if the agreement changed.
#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn models_register(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RegisterBody>,
) -> Result<Json<Vec<ModelMeta>>, ApiError> {
    if !valid_source_name(&body.name) {
        return Err((
            StatusCode::BAD_REQUEST,
            "model names are 1-64 chars of letters, digits, - and _".to_owned(),
        ));
    }
    let dir = models_dir(&state.config_dir);
    let file = dir.join(format!("{}.json", body.name));
    if file.exists() {
        return Err((
            StatusCode::CONFLICT,
            format!("model '{}' already exists", body.name),
        ));
    }
    ensure_fresh(&state).await?;
    let guard = state.loaded.read().await;
    let loaded = guard.as_ref().ok_or_else(no_log)?;
    let scope = Scope {
        from: clean(body.scope.from),
        to: clean(body.scope.to),
    };
    let range = RangeQuery {
        from: scope.from.clone(),
        to: scope.to.clone(),
    };
    let log = window(&loaded.log, &range)?;
    if !has_object_type(&log, &body.object_type) {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "object type '{}' is not in the current log",
                body.object_type
            ),
        ));
    }
    let (model, replay, precision, params) =
        freeze(&log, &body.object_type, &body.algo, body.params)?;
    let record = ModelRecord {
        meta: ModelMeta {
            name: body.name,
            note: body.note,
            created_at: Utc::now(),
            object_type: body.object_type,
            scope,
            algo: body.algo,
            params,
            snapshot: Snapshot {
                log_file: loaded
                    .path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default()
                    .to_owned(),
                events: log.events.len(),
                objects: log.objects.len(),
                fitness: Fitness {
                    fitting: replay.fitting,
                    traces: replay.traces,
                },
                precision: precision.precision,
            },
        },
        model,
    };
    std::fs::create_dir_all(&dir).map_err(|e| internal(&e))?;
    let raw = serde_json::to_string_pretty(&record).map_err(|e| internal(&e))?;
    std::fs::write(&file, raw).map_err(|e| internal(&e))?;
    Ok(Json(model_views(&state.config_dir)))
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn models_delete(
    State(state): State<Arc<AppState>>,
    UrlPath(name): UrlPath<String>,
) -> Result<Json<Vec<ModelMeta>>, ApiError> {
    if !valid_source_name(&name) {
        return Err((StatusCode::BAD_REQUEST, "not a model name".to_owned()));
    }
    let path = models_dir(&state.config_dir).join(format!("{name}.json"));
    if !path.exists() {
        return Err((StatusCode::NOT_FOUND, format!("no such model: {name}")));
    }
    std::fs::remove_file(&path).map_err(|e| internal(&e))?;
    Ok(Json(model_views(&state.config_dir)))
}

#[derive(Deserialize)]
pub(super) struct ConformanceQuery {
    /// Name of the registered model to check against.
    model: String,
    #[serde(flatten)]
    range: RangeQuery,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ConformanceReport {
    model: ModelMeta,
    replay: ocel_mine::ReplayReport,
    precision: ocel_mine::PrecisionReport,
}

/// Check the current log — windowed by the request's `from`/`to`, not the
/// registration scope — against a registered model. The whole point is
/// asking whether *new* periods still follow the frozen agreement.
#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn conformance(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ConformanceQuery>,
) -> Result<Json<ConformanceReport>, ApiError> {
    if !valid_source_name(&query.model) {
        return Err((StatusCode::BAD_REQUEST, "not a model name".to_owned()));
    }
    let record = load_record(&state.config_dir, &query.model)?;
    ensure_fresh(&state).await?;
    let guard = state.loaded.read().await;
    let loaded = guard.as_ref().ok_or_else(no_log)?;
    let log = window(&loaded.log, &query.range)?;
    if !has_object_type(&log, &record.meta.object_type) {
        return Err((
            StatusCode::CONFLICT,
            format!(
                "object type '{}' is not in the current log — this model cannot be checked against it",
                record.meta.object_type
            ),
        ));
    }
    let (replay, precision) = evaluate(
        &log,
        &record.meta.object_type,
        &record.meta.algo,
        record.model,
    )?;
    Ok(Json(ConformanceReport {
        model: record.meta,
        replay,
        precision,
    }))
}
