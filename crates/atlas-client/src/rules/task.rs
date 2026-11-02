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

/// Create a task; a recurring one takes its day of month from its due date. An actor records a
/// `created` entry; spawned occurrences pass none. Returns its id.
pub fn create_task(
    store: &mut Store,
    input: &CreateTaskInput,
    actor_id: Option<&str>,
    tz: &TimeZone,
    now: i64,
) -> String {
    let id = store.new_entity_id();
    let mut input = input.clone();
    if let (Some(rule), Some(due)) = (&input.recurrence, &input.due_at) {
        input.recurrence = Some(anchor_month_day(rule, ms(due), tz));
    }
    for (field, value) in task_create_fields(&input, now) {
        store.set(EntityKind::Task, &id, field, value);
    }
    write_activity(store, actor_id, &id, "created", None, None, now);
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

/// Title and description edits within this long of the actor's previous one extend that entry.
pub const ACTIVITY_MERGE_MS: i64 = 5 * 60 * 1000;
/// An actor reversing their own latest change to a field within this long takes that entry back.
pub const ACTIVITY_CANCEL_MS: i64 = 60 * 1000;

/// `hashText`: FNV-1a (32-bit) over the code points, as `#` and 8 hex digits. A description
/// entry's `to` holds this rather than the text.
pub fn hash_text(text: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for ch in text.chars() {
        h ^= ch as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("#{h:08x}")
}

/// The field group a task entry changes (`activityKeyOf`): the trash moves share one.
fn field_group(kind: &str) -> &str {
    match kind {
        "created" | "deleted" | "restored" => "trash",
        k => k,
    }
}

/// The latest entry on the task's field, when the actor wrote it, it undid nothing and it is at
/// most `window` old (`ownRecent`).
fn own_recent(
    store: &Store,
    actor: &str,
    task_id: &str,
    kind: &str,
    now: i64,
    window: i64,
) -> Option<(String, Map<String, Value>)> {
    let group = field_group(kind);
    let mut latest: Option<(String, Map<String, Value>, f64)> = None;
    for e in store.list(EntityKind::Activity) {
        let Some(k) = e.fields.get("kind").and_then(Value::as_str) else {
            continue;
        };
        if e.fields.get("task_id").and_then(Value::as_str) != Some(task_id)
            || field_group(k) != group
        {
            continue;
        }
        let at = e
            .fields
            .get("created_at")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let newer = match &latest {
            None => true,
            Some((id, _, latest_at)) => at > *latest_at || (at == *latest_at && e.id > *id),
        };
        if newer {
            latest = Some((e.id.clone(), e.fields.clone(), at));
        }
    }
    let (id, fields, at) = latest?;
    if fields.get("actor_id").and_then(Value::as_str) != Some(actor) {
        return None;
    }
    if fields
        .get("reverts")
        .and_then(Value::as_str)
        .is_some_and(|r| !r.is_empty())
    {
        return None;
    }
    let now = now as f64;
    if now < at || now - at > window as f64 {
        return None;
    }
    Some((id, fields))
}

/// Whether writing `kind` with `to` puts back what `prev` changed (`reverses`).
fn reverses(prev: &Map<String, Value>, kind: &str, to: Option<&str>) -> bool {
    let prev_kind = prev.get("kind").and_then(Value::as_str);
    let prev_from = prev.get("from").and_then(Value::as_str);
    match kind {
        "status" => prev_kind == Some("status") && prev.get("to").and_then(Value::as_str) != to,
        "restored" => prev_kind == Some("deleted"),
        "created" | "deleted" => false,
        "description" => {
            prev_kind == Some(kind) && to == Some(hash_text(prev_from.unwrap_or("")).as_str())
        }
        _ => prev_kind == Some(kind) && prev_from == to,
    }
}

/// Append an activity entry; nothing without an actor (`writeActivity`). A title or description
/// edit extends the actor's entry of the last [`ACTIVITY_MERGE_MS`] (its `to` and time move); a
/// change that puts back the actor's own latest one on that field within [`ACTIVITY_CANCEL_MS`]
/// removes that entry instead.
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
    let merged = kind == "title" || kind == "description";
    if merged {
        if let Some((id, _)) = own_recent(store, actor, task_id, kind, now, ACTIVITY_MERGE_MS) {
            store.set(
                EntityKind::Activity,
                &id,
                "to",
                to.map_or(Value::Null, Value::from),
            );
            store.set(EntityKind::Activity, &id, "created_at", now.into());
            return;
        }
    } else if let Some((id, prev)) =
        own_recent(store, actor, task_id, kind, now, ACTIVITY_CANCEL_MS)
    {
        if reverses(&prev, kind, to.as_deref()) {
            store.remove(EntityKind::Activity, &id);
            return;
        }
    }
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
                None,
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
    let mut moved = false;
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
        if field == "project_id" || field == "section_id" {
            let before = current.filter(|v| !v.is_null());
            let after = Some(value.clone()).filter(|v| !v.is_null());
            moved |= before != after;
            continue;
        }
        if let Some((kind, from, to)) = field_activity(field, current.as_ref(), &value) {
            write_activity(store, actor_id, &task.id, kind, from, to, now);
        }
    }
    if moved {
        let patched = |name: &str, current: &Option<String>| -> Option<String> {
            match patch.iter().find(|(k, _)| k == name) {
                Some((_, v)) => v.as_str().map(str::to_owned),
                None => current.clone(),
            }
        };
        let from = encode_place(task.project_id.as_deref(), task.section_id.as_deref());
        let to = encode_place(
            patched("project_id", &task.project_id).as_deref(),
            patched("section_id", &task.section_id).as_deref(),
        );
        write_activity(store, actor_id, &task.id, "move", Some(from), Some(to), now);
    }
    if changed {
        store.set(EntityKind::Task, &task.id, "updated_at", now.into());
    }
    changed
}

/// `move` entry values (`encodePlace`): `{"project_id","section_id"}` as JSON.
pub fn encode_place(project_id: Option<&str>, section_id: Option<&str>) -> String {
    let s = |v: Option<&str>| v.map_or(Value::Null, |x| Value::String(x.to_owned()));
    // serde_json keeps insertion order with preserve_order, sorts otherwise: write it by hand.
    format!(
        "{{\"project_id\":{},\"section_id\":{}}}",
        s(project_id),
        s(section_id)
    )
}

/// `labels` entry values (`encodeLabels`): the sorted ids as a JSON array.
pub fn encode_labels(v: Option<&Value>) -> String {
    let mut ids: Vec<&str> = v
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    ids.sort_unstable();
    Value::from(ids).to_string()
}

/// The activity entry a changed task field records, if it records one (`fieldActivity`).
fn field_activity(
    field: &str,
    before: Option<&Value>,
    after: &Value,
) -> Option<(&'static str, Option<String>, Option<String>)> {
    let num_string = |v: Option<&Value>| v.and_then(js_number_string);
    let str_or_none = |v: Option<&Value>| v.and_then(Value::as_str).map(str::to_owned);
    let text = |v: Option<&Value>| Some(str_or_none(v).unwrap_or_default());
    Some(match field {
        "due_at" => ("due", num_string(before), num_string(Some(after))),
        "start_at" => ("start", num_string(before), num_string(Some(after))),
        "priority" => ("priority", num_string(before), num_string(Some(after))),
        "assignee_id" => ("assignee", str_or_none(before), str_or_none(Some(after))),
        "title" => ("title", text(before), text(Some(after))),
        "notes" => (
            "description",
            text(before),
            Some(hash_text(after.as_str().unwrap_or(""))),
        ),
        "label_ids" => {
            let (from, to) = (encode_labels(before), encode_labels(Some(after)));
            if from == to {
                return None;
            }
            ("labels", Some(from), Some(to))
        }
        _ => return None,
    })
}

/// Move to the trash (`softDeleteTask`); an actor records a `deleted` entry.
pub fn soft_delete_task(store: &mut Store, task: &Task, actor_id: Option<&str>, now: i64) -> bool {
    if locked(store, task) {
        return false;
    }
    store.set(EntityKind::Task, &task.id, "deleted_at", now.into());
    write_activity(store, actor_id, &task.id, "deleted", None, None, now);
    true
}
