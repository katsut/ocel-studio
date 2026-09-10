//! Declaration sets: one named analysis declaration per JSON file. A set
//! names the case type, an optional recipe, the reachability filter and the
//! period — the whole "for this purpose, the log looks like this" statement,
//! saved instead of re-picked in the header every time.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::{Path as UrlPath, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

use super::sources::valid_source_name;
use super::{internal, ApiError, AppState};

fn views_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("views")
}

/// The saved period of a declaration set (`%Y-%m-%d`, either side optional).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Period {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    to: Option<String>,
}

/// One saved declaration. `baseLog` records which log the set was written
/// for; the server never resolves against it, the frontend only uses it to
/// offer a switch.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DeclarationSet {
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_log: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recipe: Option<String>,
    case_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    via: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    not_via: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    period: Option<Period>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

/// A stored declaration set plus the file it came from.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeclarationSetView {
    #[serde(flatten)]
    set: DeclarationSet,
    file: String,
}

fn declaration_views(config_dir: &Path) -> Vec<DeclarationSetView> {
    let Ok(entries) = std::fs::read_dir(views_dir(config_dir)) else {
        return Vec::new();
    };
    let mut views: Vec<DeclarationSetView> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|path| {
            let raw = std::fs::read_to_string(&path).ok()?;
            match serde_json::from_str::<DeclarationSet>(&raw) {
                Ok(set) => Some(DeclarationSetView {
                    set,
                    file: path.display().to_string(),
                }),
                Err(err) => {
                    eprintln!(
                        "ignoring unreadable declaration set {}: {err}",
                        path.display()
                    );
                    None
                }
            }
        })
        .collect();
    views.sort_by(|a, b| a.set.name.cmp(&b.set.name));
    views
}

/// `via` and `notVia` are alternative readings of the same walk — a set that
/// carries both says nothing definite, so it never gets saved.
fn check_exclusive(
    via: Option<&Vec<String>>,
    not_via: Option<&Vec<String>>,
) -> Result<(), ApiError> {
    if via.is_some_and(|v| !v.is_empty()) && not_via.is_some_and(|v| !v.is_empty()) {
        return Err((
            StatusCode::BAD_REQUEST,
            "via and notVia are mutually exclusive".to_owned(),
        ));
    }
    Ok(())
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn views_list(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<DeclarationSetView>> {
    Json(declaration_views(&state.config_dir))
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn views_upsert(
    State(state): State<Arc<AppState>>,
    Json(set): Json<DeclarationSet>,
) -> Result<Json<Vec<DeclarationSetView>>, ApiError> {
    if !valid_source_name(&set.name) {
        return Err((
            StatusCode::BAD_REQUEST,
            "declaration set names are 1-64 chars of letters, digits, - and _".to_owned(),
        ));
    }
    check_exclusive(set.via.as_ref(), set.not_via.as_ref())?;
    let dir = views_dir(&state.config_dir);
    std::fs::create_dir_all(&dir).map_err(|e| internal(&e))?;
    let raw = serde_json::to_string_pretty(&set).map_err(|e| internal(&e))?;
    std::fs::write(dir.join(format!("{}.json", set.name)), raw).map_err(|e| internal(&e))?;
    Ok(Json(declaration_views(&state.config_dir)))
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn views_delete(
    State(state): State<Arc<AppState>>,
    UrlPath(name): UrlPath<String>,
) -> Result<Json<Vec<DeclarationSetView>>, ApiError> {
    if !valid_source_name(&name) {
        return Err((
            StatusCode::BAD_REQUEST,
            "not a declaration set name".to_owned(),
        ));
    }
    let path = views_dir(&state.config_dir).join(format!("{name}.json"));
    if !path.exists() {
        return Err((
            StatusCode::NOT_FOUND,
            format!("no such declaration set: {name}"),
        ));
    }
    std::fs::remove_file(&path).map_err(|e| internal(&e))?;
    Ok(Json(declaration_views(&state.config_dir)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ocel-studio-views-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn set(name: &str) -> DeclarationSet {
        DeclarationSet {
            name: name.to_owned(),
            base_log: Some("orders.sqlite".to_owned()),
            recipe: None,
            case_type: "orders".to_owned(),
            via: Some(vec!["items".to_owned()]),
            not_via: None,
            period: Some(Period {
                from: Some("2026-04-01".to_owned()),
                to: None,
            }),
            note: Some("経理の視点".to_owned()),
        }
    }

    #[test]
    fn names_follow_the_source_name_rules() {
        assert!(valid_source_name("orders-standard"));
        assert!(valid_source_name("orders_2"));
        assert!(!valid_source_name(""));
        assert!(!valid_source_name("../escape"));
        assert!(!valid_source_name("経理"));
        assert!(!valid_source_name(&"a".repeat(65)));
    }

    #[test]
    fn via_and_not_via_together_are_rejected() {
        let via = vec!["items".to_owned()];
        let not_via = vec!["users".to_owned()];
        assert!(check_exclusive(Some(&via), None).is_ok());
        assert!(check_exclusive(None, Some(&not_via)).is_ok());
        assert!(check_exclusive(None, None).is_ok());
        let err = check_exclusive(Some(&via), Some(&not_via)).expect_err("must reject");
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn empty_lists_do_not_count_as_set() {
        let via = vec!["items".to_owned()];
        assert!(check_exclusive(Some(&via), Some(&Vec::new())).is_ok());
    }

    #[test]
    fn save_list_delete_round_trip() {
        let config = temp_dir("roundtrip");
        assert!(declaration_views(&config).is_empty());

        let dir = views_dir(&config);
        std::fs::create_dir_all(&dir).expect("views dir");
        let raw = serde_json::to_string_pretty(&set("orders-standard")).expect("serialize");
        std::fs::write(dir.join("orders-standard.json"), raw).expect("write");

        let views = declaration_views(&config);
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].set.name, "orders-standard");
        assert_eq!(views[0].set.case_type, "orders");
        assert_eq!(views[0].set.via.as_deref(), Some(&["items".to_owned()][..]));
        assert!(views[0].set.not_via.is_none());

        std::fs::remove_file(dir.join("orders-standard.json")).expect("remove");
        assert!(declaration_views(&config).is_empty());
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn unknown_fields_are_rejected_and_the_file_is_skipped() {
        let config = temp_dir("unknown");
        let dir = views_dir(&config);
        std::fs::create_dir_all(&dir).expect("views dir");
        std::fs::write(
            dir.join("bad.json"),
            r#"{"name":"bad","caseType":"orders","extra":1}"#,
        )
        .expect("write");
        assert!(declaration_views(&config).is_empty());
        let _ = std::fs::remove_dir_all(&config);
    }
}
