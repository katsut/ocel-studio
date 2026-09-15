//! The three numbers that check the unit a declaration picked: how much an
//! event is duplicated by the case type (convergence), how often one case
//! repeats the same activity (divergence), and how far the reachability walk
//! merges cases into one blob (connectivity).
//!
//! Nothing here is stored. The numbers are derived from the resolved,
//! windowed log on every request, exactly the log the screens aggregate.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde::Serialize;

use super::analysis::{resolve, split_types, ViewQuery};
use super::{ApiError, AppState};

/// The activity a metric is worst for, with the metric's value for it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorstActivity {
    name: String,
    /// Convergence: the activity's own mean. Divergence: its share of cases.
    #[serde(skip_serializing_if = "Option::is_none")]
    mean: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    share: Option<f64>,
}

/// How many times one event is seen again once the log is flattened on the
/// case type.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Convergence {
    linked_events: usize,
    flattened_events: usize,
    mean: f64,
    max: usize,
    worst_activity: Option<WorstActivity>,
}

/// How often the same activity comes back inside one case.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Divergence {
    cases: usize,
    with_repeat: usize,
    share: f64,
    mean_max_repeat: f64,
    max_repeat: usize,
    worst_activity: Option<WorstActivity>,
}

/// How much the walk the declaration allows glues cases together.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Connectivity {
    walk_types: Vec<String>,
    case_objects: usize,
    components: usize,
    largest_cases: usize,
    largest_share: f64,
    collapsed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Verification {
    case_type: String,
    convergence: Convergence,
    divergence: Divergence,
    connectivity: Connectivity,
}

#[allow(clippy::cast_precision_loss)] // counts here stay far below 2^53
fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        0.0
    } else {
        numerator as f64 / denominator as f64
    }
}

/// Object ids of `case_type`, and the type of every object by id.
fn case_ids<'a>(log: &'a ocel::Ocel, case_type: &str) -> HashSet<&'a str> {
    log.objects
        .iter()
        .filter(|o| o.object_type == case_type)
        .map(|o| o.id.as_str())
        .collect()
}

fn convergence(log: &ocel::Ocel, cases: &HashSet<&str>) -> Convergence {
    let mut linked_events = 0usize;
    let mut flattened_events = 0usize;
    let mut max = 0usize;
    // per activity: (linked events, flattened events)
    let mut by_activity: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for event in &log.events {
        seen.clear();
        for rel in &event.relationships {
            if cases.contains(rel.object_id.as_str()) {
                seen.insert(rel.object_id.as_str());
            }
        }
        let count = seen.len();
        if count == 0 {
            continue;
        }
        linked_events += 1;
        flattened_events += count;
        max = max.max(count);
        let entry = by_activity.entry(event.event_type.as_str()).or_default();
        entry.0 += 1;
        entry.1 += count;
    }
    let worst_activity = by_activity
        .iter()
        .map(|(name, (linked, flattened))| (*name, ratio(*flattened, *linked)))
        .fold(None::<(&str, f64)>, |best, next| match best {
            Some(best) if best.1 >= next.1 => Some(best),
            _ => Some(next),
        })
        .map(|(name, mean)| WorstActivity {
            name: name.to_owned(),
            mean: Some(mean),
            share: None,
        });
    Convergence {
        linked_events,
        flattened_events,
        mean: ratio(flattened_events, linked_events),
        max,
        worst_activity,
    }
}

fn divergence(log: &ocel::Ocel, cases: &HashSet<&str>) -> Divergence {
    // one activity histogram per case object that has events at all
    let mut traces: HashMap<&str, HashMap<&str, usize>> = HashMap::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for event in &log.events {
        seen.clear();
        for rel in &event.relationships {
            let id = rel.object_id.as_str();
            if cases.contains(id) && seen.insert(id) {
                *traces
                    .entry(id)
                    .or_default()
                    .entry(event.event_type.as_str())
                    .or_default() += 1;
            }
        }
    }
    let case_count = traces.len();
    let mut with_repeat = 0usize;
    let mut max_repeat = 0usize;
    let mut sum_max_repeat = 0usize;
    let mut repeating_cases: BTreeMap<&str, usize> = BTreeMap::new();
    for histogram in traces.values() {
        let case_max = histogram.values().copied().max().unwrap_or(0);
        sum_max_repeat += case_max;
        max_repeat = max_repeat.max(case_max);
        if case_max >= 2 {
            with_repeat += 1;
        }
        for (activity, count) in histogram {
            if *count >= 2 {
                *repeating_cases.entry(activity).or_default() += 1;
            }
        }
    }
    let worst_activity = repeating_cases
        .iter()
        .fold(None::<(&str, usize)>, |best, (name, count)| match best {
            Some(best) if best.1 >= *count => Some(best),
            _ => Some((*name, *count)),
        })
        .map(|(name, count)| WorstActivity {
            name: name.to_owned(),
            mean: None,
            share: Some(ratio(count, case_count)),
        });
    Divergence {
        cases: case_count,
        with_repeat,
        share: ratio(with_repeat, case_count),
        mean_max_repeat: ratio(sum_max_repeat, case_count),
        max_repeat,
        worst_activity,
    }
}

/// The object types the walk may pass through, case type first and the rest
/// by name — the same rule `keep_related_to` applies, read off the
/// declaration instead of the transform.
fn walk_types(
    log: &ocel::Ocel,
    case_type: &str,
    via: &[String],
    not_via: &[String],
) -> Vec<String> {
    let all: BTreeSet<&str> = log
        .object_types
        .iter()
        .map(|t| t.name.as_str())
        .chain(log.objects.iter().map(|o| o.object_type.as_str()))
        .collect();
    let allowed: BTreeSet<&str> = if !via.is_empty() {
        all.into_iter()
            .filter(|t| *t == case_type || via.iter().any(|v| v == t))
            .collect()
    } else if not_via.is_empty() {
        all
    } else {
        all.into_iter()
            .filter(|t| !not_via.iter().any(|n| n == t))
            .collect()
    };
    let leads = allowed.contains(case_type);
    let mut types: Vec<String> = allowed
        .into_iter()
        .filter(|t| *t != case_type)
        .map(ToOwned::to_owned)
        .collect();
    if leads {
        types.insert(0, case_type.to_owned());
    }
    types
}

/// Union-find over the object positions of the log.
struct Union {
    parent: Vec<usize>,
}

impl Union {
    fn new(len: usize) -> Self {
        Self {
            parent: (0..len).collect(),
        }
    }

    fn find(&mut self, mut node: usize) -> usize {
        while self.parent[node] != node {
            self.parent[node] = self.parent[self.parent[node]];
            node = self.parent[node];
        }
        node
    }

    fn union(&mut self, a: usize, b: usize) {
        let (a, b) = (self.find(a), self.find(b));
        if a != b {
            self.parent[b] = a;
        }
    }
}

fn connectivity(
    log: &ocel::Ocel,
    case_type: &str,
    via: &[String],
    not_via: &[String],
) -> Connectivity {
    let walk = walk_types(log, case_type, via, not_via);
    let walkable_types: HashSet<&str> = walk.iter().map(String::as_str).collect();
    let index: HashMap<&str, usize> = log
        .objects
        .iter()
        .enumerate()
        .map(|(i, o)| (o.id.as_str(), i))
        .collect();
    let walkable: Vec<bool> = log
        .objects
        .iter()
        .map(|o| walkable_types.contains(o.object_type.as_str()))
        .collect();

    let graph = log.object_graph();
    let mut union = Union::new(log.objects.len());
    for (i, object) in log.objects.iter().enumerate() {
        if !walkable[i] {
            continue;
        }
        for neighbor in graph.neighbors(object.id.as_str()) {
            // both endpoints must be walkable: a leaf of a blocked type
            // never joins two cases
            if let Some(&j) = index.get(neighbor) {
                if walkable[j] {
                    union.union(i, j);
                }
            }
        }
    }

    let mut per_component: HashMap<usize, usize> = HashMap::new();
    let mut case_objects = 0usize;
    for (i, object) in log.objects.iter().enumerate() {
        if object.object_type != case_type {
            continue;
        }
        case_objects += 1;
        let root = union.find(i);
        *per_component.entry(root).or_default() += 1;
    }
    let components = per_component.len();
    let largest_cases = per_component.values().copied().max().unwrap_or(0);
    Connectivity {
        walk_types: walk,
        case_objects,
        components,
        largest_cases,
        largest_share: ratio(largest_cases, case_objects),
        collapsed: case_objects >= 2 && components == 1,
    }
}

/// The whole check, over a log that is already resolved and windowed.
fn compute(log: &ocel::Ocel, case_type: &str, via: &[String], not_via: &[String]) -> Verification {
    let cases = case_ids(log, case_type);
    Verification {
        case_type: case_type.to_owned(),
        convergence: convergence(log, &cases),
        divergence: divergence(log, &cases),
        connectivity: connectivity(log, case_type, via, not_via),
    }
}

#[allow(clippy::needless_pass_by_value)] // axum handlers take extractors by value
pub(super) async fn verify(
    State(state): State<Arc<AppState>>,
    Query(view): Query<ViewQuery>,
) -> Result<Json<Verification>, ApiError> {
    let case_type = view.required_type()?.to_owned();
    let via = split_types(view.via.as_deref());
    let not_via = split_types(view.not_via.as_deref());
    let resolution = resolve(&state, &view).await?;
    let log = view.window(resolution.log())?;
    Ok(Json(compute(&log, &case_type, &via, &not_via)))
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use chrono::{TimeZone, Utc};

    use super::*;

    fn object(id: &str, object_type: &str) -> ocel::Object {
        ocel::Object {
            id: id.to_owned(),
            object_type: object_type.to_owned(),
            attributes: Vec::new(),
            relationships: Vec::new(),
        }
    }

    fn event(id: &str, activity: &str, minute: u32, objects: &[&str]) -> ocel::Event {
        ocel::Event {
            id: id.to_owned(),
            event_type: activity.to_owned(),
            time: Utc
                .with_ymd_and_hms(2026, 4, 1, 9, minute, 0)
                .single()
                .expect("valid time"),
            attributes: Vec::new(),
            relationships: objects
                .iter()
                .map(|o| ocel::Relationship {
                    object_id: (*o).to_owned(),
                    qualifier: "subject".to_owned(),
                })
                .collect(),
        }
    }

    fn types(
        object_types: &[&str],
        event_types: &[&str],
    ) -> (Vec<ocel::ObjectType>, Vec<ocel::EventType>) {
        (
            object_types
                .iter()
                .map(|n| ocel::ObjectType {
                    name: (*n).to_owned(),
                    attributes: Vec::new(),
                })
                .collect(),
            event_types
                .iter()
                .map(|n| ocel::EventType {
                    name: (*n).to_owned(),
                    attributes: Vec::new(),
                })
                .collect(),
        )
    }

    fn log(
        object_types: &[&str],
        event_types: &[&str],
        objects: Vec<ocel::Object>,
        events: Vec<ocel::Event>,
    ) -> ocel::Ocel {
        let (object_types, event_types) = types(object_types, event_types);
        ocel::Ocel {
            event_types,
            object_types,
            events,
            objects,
        }
    }

    /// One event touching three items: flattening on items shows it 3 times.
    #[test]
    fn convergence_counts_each_copy_of_a_shared_event() {
        let log = log(
            &["order", "item"],
            &["place order"],
            vec![
                object("o1", "order"),
                object("i1", "item"),
                object("i2", "item"),
                object("i3", "item"),
            ],
            vec![event("e1", "place order", 0, &["o1", "i1", "i2", "i3"])],
        );
        let result = compute(&log, "item", &[], &[]);
        assert_eq!(result.convergence.linked_events, 1);
        assert_eq!(result.convergence.flattened_events, 3);
        assert!((result.convergence.mean - 3.0).abs() < f64::EPSILON);
        assert_eq!(result.convergence.max, 3);
        let worst = result.convergence.worst_activity.expect("one activity");
        assert_eq!(worst.name, "place order");
        assert!((worst.mean.expect("mean") - 3.0).abs() < f64::EPSILON);
    }

    /// One order sees "pick" twice; the other case is clean.
    #[test]
    fn divergence_counts_cases_that_repeat_an_activity() {
        let log = log(
            &["order"],
            &["pick", "ship"],
            vec![object("o1", "order"), object("o2", "order")],
            vec![
                event("e1", "pick", 0, &["o1"]),
                event("e2", "pick", 1, &["o1"]),
                event("e3", "ship", 2, &["o1"]),
                event("e4", "pick", 3, &["o2"]),
            ],
        );
        let result = compute(&log, "order", &[], &[]);
        assert_eq!(result.divergence.cases, 2);
        assert_eq!(result.divergence.with_repeat, 1);
        assert_eq!(result.divergence.max_repeat, 2);
        assert!((result.divergence.share - 0.5).abs() < f64::EPSILON);
        assert!((result.divergence.mean_max_repeat - 1.5).abs() < f64::EPSILON);
        let worst = result.divergence.worst_activity.expect("one repeater");
        assert_eq!(worst.name, "pick");
        assert!((worst.share.expect("share") - 0.5).abs() < f64::EPSILON);
    }

    /// Two orders share one resource. Walking everything merges them;
    /// walking only the case type leaves them apart.
    #[test]
    fn connectivity_depends_on_which_types_the_walk_may_cross() {
        let log = log(
            &["order", "resource"],
            &["handle"],
            vec![
                object("o1", "order"),
                object("o2", "order"),
                object("r1", "resource"),
            ],
            vec![
                event("e1", "handle", 0, &["o1", "r1"]),
                event("e2", "handle", 1, &["o2", "r1"]),
            ],
        );
        let any = compute(&log, "order", &[], &[]);
        assert_eq!(any.connectivity.walk_types, ["order", "resource"]);
        assert_eq!(any.connectivity.case_objects, 2);
        assert_eq!(any.connectivity.components, 1);
        assert_eq!(any.connectivity.largest_cases, 2);
        assert!((any.connectivity.largest_share - 1.0).abs() < f64::EPSILON);
        assert!(any.connectivity.collapsed);

        let via = compute(&log, "order", &[String::from("order")], &[]);
        assert_eq!(via.connectivity.walk_types, ["order"]);
        assert_eq!(via.connectivity.components, 2);
        assert_eq!(via.connectivity.largest_cases, 1);
        assert!(!via.connectivity.collapsed);

        let not_via = compute(&log, "order", &[], &[String::from("resource")]);
        assert_eq!(not_via.connectivity.walk_types, ["order"]);
        assert_eq!(not_via.connectivity.components, 2);
    }

    #[test]
    fn a_declaration_without_a_type_is_rejected() {
        let view = ViewQuery::default();
        let err = view.required_type().expect_err("type is required");
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn an_empty_log_answers_with_zeroes() {
        let empty = log(&["order"], &[], Vec::new(), Vec::new());
        let result = compute(&empty, "order", &[], &[]);
        assert_eq!(result.convergence.linked_events, 0);
        assert!((result.convergence.mean - 0.0).abs() < f64::EPSILON);
        assert_eq!(result.divergence.cases, 0);
        assert_eq!(result.connectivity.components, 0);
        assert!(!result.connectivity.collapsed);
    }
}
