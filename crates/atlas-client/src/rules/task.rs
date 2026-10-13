//! Tasks: the store mapping (`taskMapper.ts`) and the task rules (`taskOps.ts`): create, update,
//! complete (a recurring task spawns its next occurrence), reopen and soft delete. A task this
//! device cannot decrypt is read-only.

use atlas_core::EntityKind;
use jiff::tz::TimeZone;
use serde::Serialize;
use serde_json::{Map, Number, Value};

use super::recurrence::{advance_series, anchor_month_day};
use super::zoned::{day_offset, make_instant, zoned_parts, MAX_DATE_MS};
use crate::crypto::is_encrypted_envelope;
use crate::store::Store;

/// A task as the app maps it, field for field in the TypeScript order.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Task {
    pub id: String,
    pub project_id: Option<String>,
    pub section_id: Option<String>,
    pub parent_id: Option<String>,
    pub title: String,
    pub notes: String,
    pub priority: u8,
    pub start_at: Option<Number>,
    pub due_at: Option<Number>,
    pub is_completed: bool,
    pub completed_at: Option<Number>,
    pub archived_at: Option<Number>,
    pub deleted_at: Option<Number>,
    pub recurrence: Option<String>,
    pub assignee_id: Option<String>,
    pub estimate_min: Option<Number>,
    pub label_ids: Vec<String>,
    pub sort_order: Number,
    pub created_at: Number,
    pub updated_at: Number,
    /// Some field is undecryptable here; the typed fields hold placeholders.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub locked: bool,
}

/// Milliseconds of a JSON number (`Number` keeps an integer an integer in the output).
pub fn ms(n: &Number) -> i64 {
    n.as_i64()
        .unwrap_or_else(|| n.as_f64().map_or(0, |f| f as i64))
}

pub fn num(n: i64) -> Number {
    Number::from(n)
}

fn f64_of(n: &Number) -> f64 {
    n.as_f64().unwrap_or(0.0)
}

fn str_or_none(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_owned)
}

fn num_or_none(v: Option<&Value>) -> Option<Number> {
    match v {
        Some(Value::Number(n)) if n.as_f64().is_some_and(|f| f.abs() <= MAX_DATE_MS as f64) => {
            Some(n.clone())
        }
        _ => None,
    }
}

pub fn to_task(id: &str, fields: &Map<String, Value>) -> Task {
    let priority = match fields.get("priority").and_then(Value::as_f64) {
        Some(p) if p == 1.0 || p == 2.0 || p == 3.0 || p == 4.0 => p as u8,
        _ => 4,
    };
    Task {
        id: id.to_owned(),
        project_id: str_or_none(fields.get("project_id")),
        section_id: str_or_none(fields.get("section_id")),
        parent_id: str_or_none(fields.get("parent_id")),
        title: str_or_none(fields.get("title")).unwrap_or_default(),
        notes: str_or_none(fields.get("notes")).unwrap_or_default(),
        priority,
        start_at: num_or_none(fields.get("start_at")),
        due_at: num_or_none(fields.get("due_at")),
        is_completed: fields.get("is_completed") == Some(&Value::Bool(true)),
        completed_at: num_or_none(fields.get("completed_at")),
        archived_at: num_or_none(fields.get("archived_at")),
        deleted_at: num_or_none(fields.get("deleted_at")),
        recurrence: str_or_none(fields.get("recurrence")).filter(|r| !r.is_empty()),
        assignee_id: str_or_none(fields.get("assignee_id")),
        estimate_min: match fields.get("estimate_min") {
            Some(Value::Number(n)) => Some(n.clone()),
            _ => None,
        },
        label_ids: fields
            .get("label_ids")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        sort_order: match fields.get("sort_order") {
            Some(Value::Number(n)) => n.clone(),
            _ => num(0),
        },
        created_at: num_or_none(fields.get("created_at")).unwrap_or(num(0)),
        updated_at: num_or_none(fields.get("updated_at")).unwrap_or(num(0)),
        locked: fields.values().any(is_encrypted_envelope),
    }
}

impl Task {
    /// The task's value of a field as the app reads `task[field]`; `None` is `undefined`.
    pub fn field(&self, name: &str) -> Option<Value> {
        let v = serde_json::to_value(self).expect("a task serializes");
        v.get(name).cloned()
    }

    pub fn due_ms(&self) -> Option<i64> {
        self.due_at.as_ref().map(ms)
    }
}

/// `allTasks`: every task in the store by sort order, then creation time.
pub fn all_tasks(store: &Store) -> Vec<Task> {
    let mut tasks: Vec<Task> = store
        .list(EntityKind::Task)
        .into_iter()
        .map(|e| to_task(&e.id, &e.fields))
        .collect();
    tasks.sort_by(|a, b| {
        let by_order = f64_of(&a.sort_order) - f64_of(&b.sort_order);
        let d = if by_order != 0.0 {
            by_order
        } else {
            f64_of(&a.created_at) - f64_of(&b.created_at)
        };
        d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    tasks
}

/// `CreateTaskInput`.
#[derive(Debug, Clone, Default)]
pub struct CreateTaskInput {
    pub title: String,
    pub notes: Option<String>,
    pub priority: Option<u8>,
    pub project_id: Option<String>,
    pub section_id: Option<String>,
    pub parent_id: Option<String>,
    pub start_at: Option<Number>,
    pub due_at: Option<Number>,
    pub recurrence: Option<String>,
    pub assignee_id: Option<String>,
    pub estimate_min: Option<Number>,
    pub label_ids: Option<Vec<String>>,
    pub sort_order: Option<Number>,
}

/// The fields a new task is written with, link fields first (`taskCreateFields`).
pub fn task_create_fields(input: &CreateTaskInput, now: i64) -> Vec<(&'static str, Value)> {
    let mut f: Vec<(&'static str, Value)> = Vec::new();
    if let Some(v) = &input.project_id {
        f.push(("project_id", v.clone().into()));
    }
    if let Some(v) = &input.section_id {
        f.push(("section_id", v.clone().into()));
    }
    if let Some(v) = &input.parent_id {
        f.push(("parent_id", v.clone().into()));
    }
    f.push(("title", input.title.clone().into()));
    f.push(("priority", input.priority.unwrap_or(4).into()));
    f.push(("is_completed", false.into()));
    f.push(("created_at", now.into()));
    f.push(("updated_at", now.into()));
    if let Some(v) = &input.notes {
        f.push(("notes", v.clone().into()));
    }
    if let Some(v) = &input.due_at {
        f.push(("due_at", Value::Number(v.clone())));
    }
    if let Some(v) = &input.start_at {
        f.push(("start_at", Value::Number(v.clone())));
    }
    if let Some(v) = &input.recurrence {
        f.push(("recurrence", v.clone().into()));
    }
    if let Some(v) = &input.assignee_id {
        f.push(("assignee_id", v.clone().into()));
    }
    if let Some(v) = &input.estimate_min {
        f.push(("estimate_min", Value::Number(v.clone())));
    }
    if let Some(v) = input.label_ids.as_ref().filter(|l| !l.is_empty()) {
        f.push(("label_ids", v.clone().into()));
    }
    if let Some(v) = &input.sort_order {
        f.push(("sort_order", Value::Number(v.clone())));
    }
    f
}

pub fn is_task_locked(store: &Store, id: &str) -> bool {
    store
        .get(EntityKind::Task, id)
        .is_some_and(|f| f.values().any(is_encrypted_envelope))
}

fn locked(store: &Store, task: &Task) -> bool {
    task.locked || is_task_locked(store, &task.id)
}

/// Create a task; a recurring one takes its day of month from its due date. Returns its id.
pub fn create_task(store: &mut Store, input: &CreateTaskInput, tz: &TimeZone, now: i64) -> String {
    let id = store.new_entity_id();
    let mut input = input.clone();
    if let (Some(rule), Some(due)) = (&input.recurrence, &input.due_at) {
        input.recurrence = Some(anchor_month_day(rule, ms(due), tz));
    }
    for (field, value) in task_create_fields(&input, now) {
        store.set(EntityKind::Task, &id, field, value);
    }
    id
}

/// `String(n)` for a millisecond count.
fn js_number_string(v: &Value) -> Option<String> {
    let n = v.as_number()?;
    Some(match n.as_i64() {
        Some(i) => i.to_string(),
        None => {
            let f = n.as_f64().unwrap_or(0.0);
            if f.fract() == 0.0 && f.abs() < 1e21 {
                format!("{f:.0}")
            } else {
                f.to_string()
            }
        }
    })
}

/// Append an activity entry; nothing without an actor (`writeActivity`).
pub fn write_activity(
    store: &mut Store,
    actor_id: Option<&str>,
    task_id: &str,
    kind: &str,
    from: Option<String>,
    to: Option<String>,
    now: i64,
) {
    let Some(actor) = actor_id.filter(|a| !a.is_empty()) else {
        return;
    };
    let id = store.new_entity_id();
    store.set(EntityKind::Activity, &id, "task_id", task_id.into());
    store.set(EntityKind::Activity, &id, "actor_id", actor.into());
    store.set(EntityKind::Activity, &id, "kind", kind.into());
    if let Some(f) = from {
        store.set(EntityKind::Activity, &id, "from", f.into());
    }
    if let Some(t) = to {
        store.set(EntityKind::Activity, &id, "to", t.into());
    }
    store.set(EntityKind::Activity, &id, "created_at", now.into());
}

fn shift_with_due(ms_value: i64, from_due: i64, to_due: i64, tz: &TimeZone) -> i64 {
    let days = day_offset(to_due, from_due, tz);
    let Some(p) = zoned_parts(ms_value, tz) else {
        return ms_value;
    };
    make_instant(
        p.year,
        p.month,
        p.day + days,
        p.hour,
        p.minute,
        p.second,
        tz,
    ) + ms_value.rem_euclid(1000)
}

/// Complete or reopen (`toggleTask`). Completing a recurring task with a due date spawns its next
/// occurrence, moving its start and reminders by the same days. Returns the spawned id.
pub fn toggle_task(
    store: &mut Store,
    task: &Task,
    actor_id: Option<&str>,
    now: i64,
    tz: &TimeZone,
) -> Option<String> {
    if locked(store, task) {
        return None;
    }
    let now_completed = !task.is_completed;
    let mut spawned = None;
    if let (true, Some(rule), Some(due)) = (now_completed, &task.recurrence, task.due_ms()) {
        if let Some((next, rule)) = advance_series(rule, due, now, tz) {
            let shift = |v: i64| shift_with_due(v, due, next, tz);
            let id = create_task(
                store,
                &CreateTaskInput {
                    title: task.title.clone(),
                    notes: Some(task.notes.clone()),
                    priority: Some(task.priority),
                    project_id: task.project_id.clone(),
                    section_id: task.section_id.clone(),
                    parent_id: task.parent_id.clone(),
                    start_at: task.start_at.as_ref().map(|s| num(shift(ms(s)))),
                    due_at: Some(num(next)),
                    recurrence: Some(rule),
                    estimate_min: task.estimate_min.clone(),
                    label_ids: Some(task.label_ids.clone()),
                    assignee_id: task.assignee_id.clone(),
                    sort_order: None,
                },
                tz,
                now,
            );
            for e in store.list(EntityKind::Reminder) {
                if e.fields.get("task_id").and_then(Value::as_str) != Some(task.id.as_str()) {
                    continue;
                }
                let reminder = store.new_entity_id();
                store.set(
                    EntityKind::Reminder,
                    &reminder,
                    "task_id",
                    id.clone().into(),
                );
                if let Some(Value::Number(at)) = e.fields.get("at") {
                    store.set(EntityKind::Reminder, &reminder, "at", shift(ms(at)).into());
                }
                if let Some(offset) = e
                    .fields
                    .get("offset_min_before_due")
                    .filter(|v| !v.is_null())
                {
                    store.set(
                        EntityKind::Reminder,
                        &reminder,
                        "offset_min_before_due",
                        offset.clone(),
                    );
                }
                store.set(EntityKind::Reminder, &reminder, "created_at", now.into());
            }
            spawned = Some(id);
        }
    }
    store.set(
        EntityKind::Task,
        &task.id,
        "is_completed",
        now_completed.into(),
    );
    store.set(
        EntityKind::Task,
        &task.id,
        "completed_at",
        if now_completed {
            now.into()
        } else {
            Value::Null
        },
    );
    let status = if now_completed {
        "completed"
    } else {
        "reopened"
    };
    write_activity(
        store,
        actor_id,
        &task.id,
        "status",
        None,
        Some(status.into()),
        now,
    );
    spawned
}

/// JavaScript's `===` between a task's field and a patch value: arrays and objects never match.
fn strict_equal(a: Option<&Value>, b: &Value) -> bool {
    match (a, b) {
        (Some(Value::Null), Value::Null) => true,
        (Some(Value::Bool(x)), Value::Bool(y)) => x == y,
        (Some(Value::String(x)), Value::String(y)) => x == y,
        (Some(Value::Number(x)), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => false,
    }
}

/// Write the fields of `patch` that differ (`updateTask`); a new recurrence rule takes its day of
/// month from the due date. Returns whether anything changed.
pub fn update_task(
    store: &mut Store,
    task: &Task,
    patch: &[(String, Value)],
    actor_id: Option<&str>,
    now: i64,
    tz: &TimeZone,
) -> bool {
    if locked(store, task) {
        return false;
    }
    let patched_due = patch
        .iter()
        .find(|(k, _)| k == "due_at")
        .map(|(_, v)| v.clone());
    let due = match &patched_due {
        Some(v) => v.as_number().map(ms),
        None => task.due_ms(),
    };
    let mut changed = false;
    for (field, value) in patch {
        let mut value = value.clone();
        if field == "recurrence" {
            if let (Some(rule), Some(due)) = (value.as_str().filter(|r| !r.is_empty()), due) {
                value = anchor_month_day(rule, due, tz).into();
            }
        }
        let current = task.field(field);
        if strict_equal(current.as_ref(), &value) {
            continue;
        }
        store.set(EntityKind::Task, &task.id, field, value.clone());
        changed = true;
        if field == "due_at" {
            let from = task
                .due_at
                .as_ref()
                .and_then(|d| js_number_string(&Value::Number(d.clone())));
            write_activity(
                store,
                actor_id,
                &task.id,
                "due",
                from,
                js_number_string(&value),
                now,
            );
        } else if field == "assignee_id" {
            write_activity(
                store,
                actor_id,
                &task.id,
                "assignee",
                task.assignee_id.clone(),
                value.as_str().map(str::to_owned),
                now,
            );
        }
    }
    if changed {
        store.set(EntityKind::Task, &task.id, "updated_at", now.into());
    }
    changed
}

/// Move to the trash (`softDeleteTask`).
pub fn soft_delete_task(store: &mut Store, task: &Task, now: i64) -> bool {
    if locked(store, task) {
        return false;
    }
    store.set(EntityKind::Task, &task.id, "deleted_at", now.into());
    true
}
