//! The task-rule fixtures in `test-vectors/`, which `packages/shared/src/rulesVectors.test.ts` and
//! `packages/sdk/src/dates.test.ts` assert against the TypeScript rules.

use atlas_core::{Change, EntityKind};
use jiff::tz::TimeZone;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use super::dates::parse_due;
use super::filter::{evaluate, parse, EvalContext};
use super::quick_add::{parse_quick_add, QuickAddContext};
use super::task::{
    all_tasks, create_task, soft_delete_task, to_task, toggle_task, update_task, CreateTaskInput,
    Task,
};
use crate::store::Store;

fn fixture(name: &str) -> Value {
    let path = format!("{}/../../test-vectors/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn tz(v: &Value) -> TimeZone {
    TimeZone::get(v["tz"].as_str().unwrap()).unwrap()
}

#[test]
fn quick_add_vectors() {
    let f = fixture("quick_add_vectors.json");
    for c in f["cases"].as_array().unwrap() {
        let projects = c.get("projects").and_then(Value::as_object).cloned();
        let labels: Option<Vec<String>> = c
            .get("labels")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(|l| l.as_str().unwrap().to_owned()).collect());
        let by_name = |name: &str| -> Option<String> {
            projects.as_ref().and_then(|p| {
                p.iter()
                    .find(|(n, _)| n.to_lowercase() == name.to_lowercase())
                    .map(|(_, id)| id.as_str().unwrap().to_owned())
            })
        };
        let known = |name: &str| {
            labels
                .as_ref()
                .is_some_and(|l| l.iter().any(|x| x.to_lowercase() == name.to_lowercase()))
        };
        let ctx = QuickAddContext {
            project_id_by_name: projects
                .is_some()
                .then_some(&by_name as &dyn Fn(&str) -> Option<String>),
            is_known_label: labels.is_some().then_some(&known as &dyn Fn(&str) -> bool),
            language: c.get("language").and_then(Value::as_str),
            ..QuickAddContext::default()
        };
        let r = parse_quick_add(
            c["text"].as_str().unwrap(),
            c["now"].as_i64().unwrap(),
            &tz(c),
            &ctx,
        );
        let got = json!({
            "title": r.title,
            "priority": r.priority,
            "due_at": r.due_at,
            "recurrence": r.recurrence,
            "project_id": r.project_id,
            "labels": r.labels,
            "date_match": r.date_match,
        });
        assert_eq!(
            got, c["expected"],
            "quick add {:?} ({})",
            c["text"], c["tz"]
        );
    }
}

#[test]
fn filter_vectors() {
    let f = fixture("filter_vectors.json");
    let tasks = f["tasks"].as_array().unwrap();
    let as_task = |x: &Value| -> Task {
        let mut fields = Map::new();
        for k in ["title", "priority", "due_at", "is_completed"] {
            if let Some(v) = x.get(k) {
                fields.insert(k.into(), v.clone());
            }
        }
        to_task(x["id"].as_str().unwrap(), &fields)
    };
    let find = |t: &Task| {
        tasks
            .iter()
            .find(|x| x["id"] == json!(t.id))
            .unwrap()
            .clone()
    };
    let labels_of = |t: &Task| -> Vec<String> {
        find(t)["labels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l.as_str().unwrap().to_owned())
            .collect()
    };
    let project_of = |t: &Task| find(t)["project"].as_str().map(str::to_owned);
    for c in f["cases"].as_array().unwrap() {
        let query = c["query"].as_str().unwrap();
        let tz = tz(c);
        match parse(query) {
            Err(e) => {
                assert_eq!(json!(e.error), c["error"], "{query:?}");
                assert_eq!(json!(e.at), c["at"], "{query:?}");
            }
            Ok(ast) => {
                let cx = EvalContext {
                    now: c["now"].as_i64().unwrap(),
                    tz: &tz,
                    labels_of: &labels_of,
                    project_name_of: &project_of,
                    week_starts_on: 1,
                };
                let ids: Vec<String> = tasks
                    .iter()
                    .map(as_task)
                    .filter(|t| evaluate(&ast, t, &cx))
                    .map(|t| t.id)
                    .collect();
                assert_eq!(
                    json!(ids),
                    c["expected"],
                    "{query:?} at {} in {}",
                    c["now"],
                    c["tz"]
                );
            }
        }
    }
}

const TASK_ID: &str = "00000000-0000-4000-8000-000000000001";

fn input_of(v: &Value) -> CreateTaskInput {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    let n = |k: &str| v.get(k).and_then(Value::as_number).cloned();
    CreateTaskInput {
        title: s("title").unwrap_or_default(),
        notes: s("notes"),
        priority: v.get("priority").and_then(Value::as_u64).map(|p| p as u8),
        project_id: s("project_id"),
        section_id: s("section_id"),
        parent_id: s("parent_id"),
        start_at: n("start_at"),
        due_at: n("due_at"),
        recurrence: s("recurrence"),
        assignee_id: s("assignee_id"),
        estimate_min: n("estimate_min"),
        label_ids: v
            .get("label_ids")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(|l| l.as_str().unwrap().to_owned()).collect()),
        sort_order: n("sort_order"),
    }
}

#[test]
fn task_rule_vectors() {
    let f = fixture("task_rules_vectors.json");
    for s in f["scenarios"].as_array().unwrap() {
        let name = s["name"].as_str().unwrap();
        let now = s["now"].as_i64().unwrap();
        let tz = tz(s);
        let mut store = Store::with(
            Uuid::parse_str("00000000-0000-4000-8000-0000000000ff").unwrap(),
            Box::new(move || now as u64),
            Box::new(Uuid::new_v4),
        );
        if let Some(task) = s.get("task").and_then(Value::as_object) {
            for (k, v) in task {
                store.set(EntityKind::Task, TASK_ID, k, v.clone());
            }
        }
        for (i, r) in s
            .get("reminders")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            let id = format!("00000000-0000-4000-8000-0000000000{:x}", 0xa0 + i);
            store.set(EntityKind::Reminder, &id, "task_id", TASK_ID.into());
            for (k, v) in r.as_object().unwrap() {
                store.set(EntityKind::Reminder, &id, k, v.clone());
            }
        }
        let before = store.unsynced_ops().len();
        let task = all_tasks(&store).into_iter().find(|t| t.id == TASK_ID);
        let actor = s["actor"].as_str();
        let mut subject = TASK_ID.to_owned();
        let result = match s["action"].as_str().unwrap() {
            "create" => {
                subject = create_task(&mut store, &input_of(&s["input"]), &tz, now);
                Value::Null
            }
            "complete" | "reopen" => {
                json!(toggle_task(&mut store, task.as_ref().unwrap(), actor, now, &tz).is_some())
            }
            "update" => {
                let patch: Vec<(String, Value)> = s["patch"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| (p[0].as_str().unwrap().to_owned(), p[1].clone()))
                    .collect();
                json!(update_task(
                    &mut store,
                    task.as_ref().unwrap(),
                    &patch,
                    actor,
                    now,
                    &tz
                ))
            }
            "delete" => json!(soft_delete_task(&mut store, task.as_ref().unwrap(), now)),
            other => panic!("unknown action {other}"),
        };
        let ops = store.unsynced_ops()[before..].to_vec();
        let written = |entity: EntityKind| -> Vec<(String, Map<String, Value>)> {
            let mut out: Vec<(String, Map<String, Value>)> = Vec::new();
            for op in &ops {
                let Change::Set { field, value } = &op.change else {
                    continue;
                };
                if op.entity != entity {
                    continue;
                }
                let id = op.entity_id.to_string();
                let i = match out.iter().position(|(x, _)| *x == id) {
                    Some(i) => i,
                    None => {
                        out.push((id, Map::new()));
                        out.len() - 1
                    }
                };
                out[i].1.insert(field.clone(), value.clone());
            }
            out
        };
        let tasks = written(EntityKind::Task);
        let spawned = tasks
            .iter()
            .map(|(id, _)| id.clone())
            .find(|id| *id != subject && id != TASK_ID);
        let action = s["action"].as_str().unwrap();
        let clean = |f: Option<&Map<String, Value>>| -> Value {
            let Some(f) = f else { return Value::Null };
            Value::Object(
                f.iter()
                    .map(|(k, v)| {
                        let v = match v.as_str() {
                            Some(x) if Some(x) == spawned.as_deref() => json!("<spawned>"),
                            Some(x) if x == subject && action == "create" => json!("<created>"),
                            _ => v.clone(),
                        };
                        (k.clone(), v)
                    })
                    .collect(),
            )
        };
        let get = |id: &str| tasks.iter().find(|(x, _)| x == id).map(|(_, f)| f);
        let got = json!({
            "written": clean(get(&subject)),
            "spawned": spawned.as_deref().map_or(Value::Null, |id| clean(get(id))),
            "activities": written(EntityKind::Activity).iter().map(|(_, f)| clean(Some(f))).collect::<Vec<_>>(),
            "reminders": written(EntityKind::Reminder).iter().map(|(_, f)| clean(Some(f))).collect::<Vec<_>>(),
        });
        assert_eq!(result, s["result"], "{name}: result");
        assert_eq!(got, s["expected"], "{name}");
    }
}

#[test]
fn parse_due_vectors() {
    let f = fixture("parse_due_vectors.json");
    for c in f["cases"].as_array().unwrap() {
        let got = parse_due(&c["value"], &tz(c), c["now"].as_i64().unwrap());
        match c.get("error") {
            Some(err) => assert_eq!(
                got.map_err(|e| e.to_string()).unwrap_err(),
                err.as_str().unwrap(),
                "{} in {}",
                c["value"],
                c["tz"]
            ),
            None => assert_eq!(
                json!(got.unwrap()),
                c["expected"],
                "{} in {}",
                c["value"],
                c["tz"]
            ),
        }
    }
}
