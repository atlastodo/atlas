//! The headless client for integrations (`AtlasClient` in `packages/sdk/src/client.ts`): signs in
//! with an API token, holds the decrypted account in memory, and reads and writes tasks with the
//! app's own rules. Every write is pushed before the call returns.

use atlas_core::{Change, EntityKind, Operation};
use jiff::tz::TimeZone;
use serde::Serialize;
use serde_json::{Map, Number, Value};

use crate::error::{Error, Result};
use crate::rules::filter::{evaluate, parse as parse_filter, EvalContext};
use crate::rules::quick_add::{parse_quick_add, QuickAddContext};
use crate::rules::task::{
    all_tasks, create_task, num, soft_delete_task, to_task, toggle_task, update_task,
    CreateTaskInput, Task,
};
use crate::rules::zoned::resolve_time_zone;
use crate::session::{ConnectOptions, Session};
use crate::store::{now_ms, op_entity_id};

/// A project or folder (`toProject`).
#[derive(Debug, Clone, Serialize)]
pub struct Project {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub color: String,
    pub icon: String,
    pub sort_order: Number,
    pub is_favorite: bool,
    pub parent_id: Option<String>,
    pub kind: String,
    pub default_view: String,
    pub archived_at: Option<Number>,
    pub deleted_at: Option<Number>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Label {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub color: String,
}

/// A task as integrations see it: the app's task plus its project's name and its labels' names.
#[derive(Debug, Clone, Serialize)]
pub struct TaskView {
    #[serde(flatten)]
    pub task: Task,
    pub project_name: Option<String>,
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Open,
    Completed,
    All,
}

#[derive(Debug, Clone, Default)]
pub struct TaskQuery {
    /// A project id or name (case-insensitive).
    pub project: Option<String>,
    /// Open by default.
    pub status: Option<TaskStatus>,
    /// Unix ms bounds on the due date; tasks without one are left out when either is set.
    pub due_before: Option<i64>,
    pub due_after: Option<i64>,
    /// A label id or name (case-insensitive).
    pub label: Option<String>,
    /// Case-insensitive substring of the title or notes.
    pub search: Option<String>,
    /// The app's filter syntax.
    pub filter: Option<String>,
}

/// `CreateTaskOptions`: the new task's fields, with a project and labels by name too.
#[derive(Debug, Clone, Default)]
pub struct CreateTask {
    pub title: String,
    pub notes: Option<String>,
    /// As given; anything but 1 to 4 is refused.
    pub priority: Option<Value>,
    pub due_at: Option<i64>,
    pub start_at: Option<i64>,
    pub recurrence: Option<String>,
    pub project_id: Option<String>,
    /// A project name, used when `project_id` is not given.
    pub project: Option<String>,
    pub label_ids: Vec<String>,
    /// Label names; unknown ones are an error.
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Completion {
    pub task: TaskView,
    pub next: Option<TaskView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum Deleted {
    Task(Box<TaskView>),
    Purged { id: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct Changes {
    pub cursor: u64,
    pub created: Vec<TaskView>,
    pub updated: Vec<TaskView>,
    pub completed: Vec<TaskView>,
    pub deleted: Vec<Deleted>,
}

pub struct AtlasClient {
    session: Session,
    time_zone: TimeZone,
    now: Box<dyn Fn() -> i64 + Send>,
}

fn str_field(f: &Map<String, Value>, k: &str) -> String {
    f.get(k).and_then(Value::as_str).unwrap_or("").to_owned()
}

fn to_project(id: &str, f: &Map<String, Value>) -> Project {
    let number = |k: &str| match f.get(k) {
        Some(Value::Number(n)) => Some(n.clone()),
        _ => None,
    };
    Project {
        id: id.to_owned(),
        owner_id: str_field(f, "owner_id"),
        name: str_field(f, "name"),
        color: str_field(f, "color"),
        icon: str_field(f, "icon"),
        sort_order: number("sort_order").unwrap_or(num(0)),
        is_favorite: f.get("is_favorite") == Some(&Value::Bool(true)),
        parent_id: f
            .get("parent_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
        kind: if f.get("kind").and_then(Value::as_str) == Some("folder") {
            "folder"
        } else {
            "project"
        }
        .into(),
        default_view: if f.get("default_view").and_then(Value::as_str) == Some("board") {
            "board"
        } else {
            "list"
        }
        .into(),
        archived_at: number("archived_at"),
        deleted_at: number("deleted_at"),
    }
}

fn check_priority(p: &Value) -> Result<u8> {
    match p.as_f64() {
        Some(f) if f == 1.0 || f == 2.0 || f == 3.0 || f == 4.0 => Ok(f as u8),
        _ => Err(Error::atlas(
            "bad_input",
            "priority must be 1 (highest) to 4 (none)",
        )),
    }
}

fn locked_error(id: &str) -> Error {
    Error::atlas(
        "task_locked",
        format!("task \"{id}\" is in a shared project whose key this token cannot open"),
    )
}

impl AtlasClient {
    /// Sign in with the token, unwrap the keys it carries, pull and decrypt the account.
    pub fn connect(opts: ConnectOptions) -> Result<Self> {
        let time_zone = resolve_time_zone(opts.time_zone.as_deref());
        let session = Session::connect(opts)?;
        Ok(Self {
            session,
            time_zone,
            now: Box::new(|| now_ms() as i64),
        })
    }

    /// For tests: the clock the rules read.
    pub fn set_now(&mut self, now: Box<dyn Fn() -> i64 + Send>) {
        self.now = now;
    }

    pub fn user_id(&self) -> &str {
        &self.session.user_id
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    pub fn session_mut(&mut self) -> &mut Session {
        &mut self.session
    }

    /// The server cursor this client has pulled up to.
    pub fn cursor(&self) -> u64 {
        self.session.sync.cursor()
    }

    fn push(&mut self) -> Result<()> {
        self.session.push()
    }

    /// Projects and folders neither archived nor in the trash, by sort order.
    pub fn projects(&self) -> Vec<Project> {
        let mut out: Vec<Project> = self
            .session
            .store
            .list(EntityKind::Project)
            .iter()
            .map(|e| to_project(&e.id, &e.fields))
            .filter(|p| p.archived_at.is_none() && p.deleted_at.is_none())
            .collect();
        out.sort_by(|a, b| {
            let (x, y) = (
                a.sort_order.as_f64().unwrap_or(0.0),
                b.sort_order.as_f64().unwrap_or(0.0),
            );
            x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal)
        });
        out
    }

    pub fn labels(&self) -> Vec<Label> {
        self.session
            .store
            .list(EntityKind::Label)
            .iter()
            .filter(|e| e.fields.get("deleted_at").is_none_or(Value::is_null))
            .map(|e| Label {
                id: e.id.clone(),
                owner_id: str_field(&e.fields, "owner_id"),
                name: str_field(&e.fields, "name"),
                color: str_field(&e.fields, "color"),
            })
            .collect()
    }

    fn project_id(&self, reference: &str) -> Result<String> {
        let projects = self.projects();
        let lower = reference.to_lowercase();
        projects
            .iter()
            .find(|p| p.id == reference)
            .or_else(|| projects.iter().find(|p| p.name.to_lowercase() == lower))
            .map(|p| p.id.clone())
            .ok_or_else(|| Error::atlas("unknown_project", format!("no project \"{reference}\"")))
    }

    fn label_id(&self, reference: &str) -> Result<String> {
        let labels = self.labels();
        let lower = reference
            .strip_prefix('@')
            .unwrap_or(reference)
            .to_lowercase();
        labels
            .iter()
            .find(|l| l.id == reference)
            .or_else(|| labels.iter().find(|l| l.name.to_lowercase() == lower))
            .map(|l| l.id.clone())
            .ok_or_else(|| Error::atlas("unknown_label", format!("no label \"{reference}\"")))
    }

    fn view(&self, task: Task) -> TaskView {
        let labels = self.labels();
        let project_name = task
            .project_id
            .as_deref()
            .and_then(|p| self.session.store.get(EntityKind::Project, p))
            .and_then(|f| f.get("name").and_then(Value::as_str).map(str::to_owned));
        let names = task
            .label_ids
            .iter()
            .filter_map(|id| labels.iter().find(|l| l.id == *id).map(|l| l.name.clone()))
            .collect();
        TaskView {
            task,
            project_name,
            labels: names,
        }
    }

    fn raw_task(&self, id: &str) -> Result<Task> {
        self.session
            .store
            .get(EntityKind::Task, id)
            .map(|f| to_task(id, &f))
            .ok_or_else(|| Error::atlas("unknown_task", format!("no task \"{id}\"")))
    }

    /// One task by id, trashed or not.
    pub fn task(&self, id: &str) -> Option<TaskView> {
        self.raw_task(id).ok().map(|t| self.view(t))
    }

    /// Tasks neither in the trash nor archived, filtered by `query`.
    pub fn tasks(&self, query: &TaskQuery) -> Result<Vec<TaskView>> {
        let status = query.status.unwrap_or(TaskStatus::Open);
        let project_id = query
            .project
            .as_deref()
            .filter(|p| !p.is_empty())
            .map(|p| self.project_id(p))
            .transpose()?;
        let label_id = query
            .label
            .as_deref()
            .filter(|l| !l.is_empty())
            .map(|l| self.label_id(l))
            .transpose()?;
        let search = query
            .search
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(str::to_lowercase);
        let filter =
            match query.filter.as_deref().filter(|f| !f.is_empty()) {
                Some(f) => Some(parse_filter(f).map_err(|e| {
                    Error::atlas("bad_filter", format!("{} (at {})", e.error, e.at))
                })?),
                None => None,
            };
        let now = (self.now)();
        let labels = self.labels();
        let store = &self.session.store;
        let labels_of = |t: &Task| -> Vec<String> {
            t.label_ids
                .iter()
                .map(|id| {
                    labels
                        .iter()
                        .find(|l| l.id == *id)
                        .map(|l| l.name.clone())
                        .unwrap_or_default()
                })
                .collect()
        };
        let project_name_of = |t: &Task| -> Option<String> {
            let p = store.get(EntityKind::Project, t.project_id.as_deref()?)?;
            p.get("name").and_then(Value::as_str).map(str::to_owned)
        };
        let cx = EvalContext {
            now,
            tz: &self.time_zone,
            labels_of: &labels_of,
            project_name_of: &project_name_of,
            week_starts_on: 1,
        };
        Ok(all_tasks(store)
            .into_iter()
            .filter(|t| t.deleted_at.is_none() && t.archived_at.is_none())
            .filter(|t| {
                status == TaskStatus::All || t.is_completed == (status == TaskStatus::Completed)
            })
            .filter(|t| project_id.is_none() || t.project_id == project_id)
            .filter(|t| label_id.as_ref().is_none_or(|l| t.label_ids.contains(l)))
            .filter(|t| {
                if query.due_before.is_none() && query.due_after.is_none() {
                    return true;
                }
                let Some(due) = t.due_ms() else {
                    return false;
                };
                query.due_before.is_none_or(|b| due < b) && query.due_after.is_none_or(|a| due >= a)
            })
            .filter(|t| {
                search.as_ref().is_none_or(|s| {
                    t.title.to_lowercase().contains(s) || t.notes.to_lowercase().contains(s)
                })
            })
            .filter(|t| filter.as_ref().is_none_or(|f| evaluate(f, t, &cx)))
            .map(|t| self.view(t))
            .collect())
    }

    /// Create a task and push it.
    pub fn create_task(&mut self, input: CreateTask) -> Result<TaskView> {
        let title = input.title.trim();
        if title.is_empty() {
            return Err(Error::atlas("bad_input", "a task needs a title"));
        }
        let project_id = match (
            input.project_id.as_deref().filter(|p| !p.is_empty()),
            input.project.as_deref().filter(|p| !p.is_empty()),
        ) {
            (Some(id), _) => Some(self.project_id(id)?),
            (None, Some(name)) => Some(self.project_id(name)?),
            _ => None,
        };
        let mut label_ids = input.label_ids.clone();
        for l in &input.labels {
            label_ids.push(self.label_id(l)?);
        }
        let priority = input
            .priority
            .as_ref()
            .filter(|p| !p.is_null())
            .map(check_priority)
            .transpose()?;
        let create = CreateTaskInput {
            title: title.to_owned(),
            notes: input.notes,
            priority,
            project_id,
            start_at: input.start_at.map(num),
            due_at: input.due_at.map(num),
            recurrence: input.recurrence,
            label_ids: Some(label_ids),
            ..CreateTaskInput::default()
        };
        let now = (self.now)();
        let id = create_task(&mut self.session.store, &create, &self.time_zone, now);
        self.push()?;
        Ok(self.view(self.raw_task(&id)?))
    }

    /// Create a task from one line in the app's quick-add syntax.
    pub fn quick_add(&mut self, text: &str) -> Result<TaskView> {
        let projects = self.projects();
        let labels = self.labels();
        let by_name = |name: &str| -> Option<String> {
            projects
                .iter()
                .find(|p| p.name.to_lowercase() == name.to_lowercase())
                .map(|p| p.id.clone())
        };
        let known = |name: &str| {
            labels
                .iter()
                .any(|l| l.name.to_lowercase() == name.to_lowercase())
        };
        let ctx = QuickAddContext {
            project_id_by_name: Some(&by_name),
            is_known_label: Some(&known),
            ..QuickAddContext::default()
        };
        let parsed = parse_quick_add(text, (self.now)(), &self.time_zone, &ctx);
        self.create_task(CreateTask {
            title: parsed.title,
            priority: parsed.priority.map(Value::from),
            due_at: parsed.due_at,
            recurrence: parsed.recurrence,
            project_id: parsed.project_id,
            labels: parsed.labels,
            ..CreateTask::default()
        })
    }

    /// Change a task's fields (`patch`, in order) and push. Unchanged values are skipped.
    pub fn update_task(&mut self, id: &str, patch: Vec<(String, Value)>) -> Result<TaskView> {
        let task = self.raw_task(id)?;
        let mut clean = patch;
        // Resolved in the SDK's order: the project, the priority, then the labels.
        for name in ["project_id", "priority", "label_ids"] {
            let Some((_, value)) = clean.iter_mut().find(|(k, _)| k == name) else {
                continue;
            };
            *value = match (name, &*value) {
                ("project_id", Value::String(p)) if !p.is_empty() => {
                    Value::from(self.project_id(p)?)
                }
                ("priority", v) if !v.is_null() => Value::from(check_priority(v)?),
                ("label_ids", Value::Array(ids)) => Value::from(
                    ids.iter()
                        .map(|l| self.label_id(&json_text(l)))
                        .collect::<Result<Vec<String>>>()?,
                ),
                (_, v) => v.clone(),
            };
        }
        let now = (self.now)();
        let user = self.session.user_id.clone();
        if !update_task(
            &mut self.session.store,
            &task,
            &clean,
            Some(&user),
            now,
            &self.time_zone,
        ) {
            if task.locked || self.raw_task(id)?.locked {
                return Err(locked_error(id));
            }
            return Ok(self.view(task));
        }
        self.push()?;
        Ok(self.view(self.raw_task(id)?))
    }

    /// Complete a task (a no-op when it already is); a recurring one returns its next occurrence.
    pub fn complete_task(&mut self, id: &str) -> Result<Completion> {
        self.set_completed(id, true)
    }

    pub fn reopen_task(&mut self, id: &str) -> Result<Completion> {
        self.set_completed(id, false)
    }

    fn set_completed(&mut self, id: &str, completed: bool) -> Result<Completion> {
        let task = self.raw_task(id)?;
        if task.locked {
            return Err(locked_error(id));
        }
        if task.is_completed == completed {
            return Ok(Completion {
                task: self.view(task),
                next: None,
            });
        }
        let now = (self.now)();
        let user = self.session.user_id.clone();
        let spawned = toggle_task(
            &mut self.session.store,
            &task,
            Some(&user),
            now,
            &self.time_zone,
        );
        self.push()?;
        let next = match spawned {
            Some(s) => Some(self.view(self.raw_task(&s)?)),
            None => None,
        };
        Ok(Completion {
            task: self.view(self.raw_task(id)?),
            next,
        })
    }

    /// Move a task to the trash, as the app's delete does.
    pub fn delete_task(&mut self, id: &str) -> Result<()> {
        let task = self.raw_task(id)?;
        if task.deleted_at.is_some() {
            return Ok(());
        }
        let now = (self.now)();
        if !soft_delete_task(&mut self.session.store, &task, now) {
            return Err(locked_error(id));
        }
        self.push()
    }

    /// Tasks changed on the server after `since`: each once, under the first of deleted, created,
    /// completed, updated its changes match, with its current state.
    pub fn changes(&mut self, since: u64) -> Result<Changes> {
        self.session.sync_now()?;
        let until = self.cursor();
        let mut touched: Vec<(String, Vec<Operation>)> = Vec::new();
        let mut cursor = since;
        while cursor < until {
            let page =
                self.session
                    .api
                    .sync_pull(&self.session.store, &self.session.keyring, cursor)?;
            for op in &page.operations {
                if op.entity != EntityKind::Task {
                    continue;
                }
                let id = op_entity_id(op);
                match touched.iter_mut().find(|(x, _)| *x == id) {
                    Some((_, ops)) => ops.push(op.clone()),
                    None => touched.push((id, vec![op.clone()])),
                }
            }
            if page.operations.is_empty() || page.cursor <= cursor {
                break;
            }
            cursor = page.cursor;
        }
        let mut out = Changes {
            cursor: until.max(cursor),
            created: Vec::new(),
            updated: Vec::new(),
            completed: Vec::new(),
            deleted: Vec::new(),
        };
        for (id, ops) in touched {
            let Some(fields) = self.session.store.get(EntityKind::Task, &id) else {
                out.deleted.push(Deleted::Purged { id });
                continue;
            };
            let has = |field: &str, pred: &dyn Fn(&Value) -> bool| {
                ops.iter().any(|o| matches!(&o.change, Change::Set { field: f, value } if f == field && pred(value)))
            };
            let view = self.view(to_task(&id, &fields));
            if ops.iter().any(|o| o.change == Change::Delete)
                || has("deleted_at", &|v| !v.is_null())
            {
                out.deleted.push(Deleted::Task(Box::new(view)));
            } else if has("created_at", &|_| true) {
                out.created.push(view);
            } else if has("is_completed", &|v| *v == Value::Bool(true)) {
                out.completed.push(view);
            } else {
                out.updated.push(view);
            }
        }
        Ok(out)
    }
}

/// `String(x)` of a JSON value, as the CLI's label references are read.
fn json_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}
