//! Transform recipes: one JSON file per recipe, plus a dry-run preview.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::{Path as UrlPath, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;

use super::sources::valid_source_name;
use super::{ensure_fresh, internal, no_log, ApiError, AppState};

fn recipes_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("recipes")
}

/// A stored recipe plus the absolute file path a transform source needs.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecipeView {
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
pub(super) async fn recipes_list(State(state): State<Arc<AppState>>) -> Json<Vec<RecipeView>> {
    Json(recipe_views(&state.config_dir))
}

/// Save a recipe (create or replace), one JSON file per recipe.
#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn recipes_upsert(
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
pub(super) async fn recipes_delete(
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
pub(super) async fn transform_preview(
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
pub(super) struct TransformPreview {
    steps: Vec<ocel_transform::StepPreview>,
    events: usize,
    objects: usize,
}
