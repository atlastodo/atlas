//! `AtlasClient` against the fake server, as `packages/sdk/src/client.test.ts` runs the TypeScript
//! one.

use atlas_client::client::{AtlasClient, CreateTask, Deleted, TaskQuery, TaskStatus};
use atlas_client::rules::dates::parse_due;
use atlas_client::rules::task::{create_task, CreateTaskInput};
use atlas_client::rules::zoned::resolve_time_zone;
use atlas_client::session::ConnectOptions;
use atlas_client::testing::{FakeServer, USER_ID};
use atlas_core::EntityKind;
use serde_json::{json, Value};

const TZ: &str = "Europe/Copenhagen";

fn connect(server: &FakeServer) -> AtlasClient {
    let mut opts = ConnectOptions::new("http://atlas.test/", &server.token_string());
    opts.transport = Some(server.transport());
    opts.time_zone = Some(TZ.into());
    AtlasClient::connect(opts).expect("connects")
}

/// Another device of the account, writing as the app does.
fn app_project(app: &mut AtlasClient, name: &str) -> String {
    let store = &mut app.session_mut().store;
    let id = store.new_entity_id();
    for (field, value) in [
        ("name", json!(name)),
        ("color", json!("")),
        ("icon", json!("")),
        ("kind", json!("project")),
        ("parent_id", Value::Null),
        ("sort_order", json!(0)),
        ("owner_id", json!(USER_ID)),
    ] {
        store.set(EntityKind::Project, &id, field, value);
    }
    id
}

fn app_task(app: &mut AtlasClient, input: CreateTaskInput) -> String {
    let tz = resolve_time_zone(Some(TZ));
    create_task(&mut app.session_mut().store, &input, &tz, 1_700_000_000_000)
}

fn titles(tasks: &[atlas_client::client::TaskView]) -> Vec<String> {
    tasks.iter().map(|t| t.task.title.clone()).collect()
}

#[test]
fn creates_a_task_the_server_only_holds_as_ciphertext() {
    let server = FakeServer::new();
    let mut atlas = connect(&server);
    let task = atlas
        .create_task(CreateTask {
            title: "Water the plants".into(),
            priority: Some(json!(2)),
            ..CreateTask::default()
        })
        .unwrap();
    assert_eq!(
        (
            task.task.title.as_str(),
            task.task.priority,
            task.task.is_completed
        ),
        ("Water the plants", 2, false)
    );
    let raw = serde_json::to_string(&server.state.lock().unwrap().ops).unwrap();
    assert!(!raw.contains("Water the plants"));
    let other = connect(&server);
    assert_eq!(
        other.task(&task.task.id).unwrap().task.title,
        "Water the plants"
    );
}

#[test]
fn lists_filters_updates_and_completes() {
    let server = FakeServer::new();
    let mut app = connect(&server);
    let work = app_project(&mut app, "Work");
    app_task(
        &mut app,
        CreateTaskInput {
            title: "Ship it".into(),
            project_id: Some(work.clone()),
            priority: Some(1),
            ..Default::default()
        },
    );
    app_task(
        &mut app,
        CreateTaskInput {
            title: "Buy milk".into(),
            ..Default::default()
        },
    );
    app.session_mut().push().unwrap();

    let mut atlas = connect(&server);
    assert_eq!(
        atlas
            .projects()
            .iter()
            .map(|p| p.name.clone())
            .collect::<Vec<_>>(),
        ["Work"]
    );
    let mut all = titles(&atlas.tasks(&TaskQuery::default()).unwrap());
    all.sort();
    assert_eq!(all, ["Buy milk", "Ship it"]);
    let ship = atlas
        .tasks(&TaskQuery {
            project: Some("work".into()),
            ..Default::default()
        })
        .unwrap()
        .remove(0);
    assert_eq!(ship.project_name.as_deref(), Some("Work"));
    assert_eq!(
        titles(
            &atlas
                .tasks(&TaskQuery {
                    filter: Some("p1".into()),
                    ..Default::default()
                })
                .unwrap()
        ),
        ["Ship it"]
    );
    assert_eq!(
        titles(
            &atlas
                .tasks(&TaskQuery {
                    search: Some("MILK".into()),
                    ..Default::default()
                })
                .unwrap()
        ),
        ["Buy milk"]
    );
    let err = atlas
        .tasks(&TaskQuery {
            project: Some("Nope".into()),
            ..Default::default()
        })
        .unwrap_err();
    assert!(
        matches!(err, atlas_client::Error::Atlas { ref code, .. } if code == "unknown_project")
    );
    let err = atlas
        .tasks(&TaskQuery {
            filter: Some("(p1".into()),
            ..Default::default()
        })
        .unwrap_err();
    assert_eq!(err.to_string(), "expected ')' (at 3)");

    let updated = atlas
        .update_task(
            &ship.task.id,
            vec![
                ("notes".into(), json!("friday")),
                ("priority".into(), json!(3)),
            ],
        )
        .unwrap();
    assert_eq!(
        (updated.task.notes.as_str(), updated.task.priority),
        ("friday", 3)
    );

    let done = atlas.complete_task(&ship.task.id).unwrap();
    assert!(done.task.task.is_completed);
    assert!(done.next.is_none());
    assert_eq!(
        titles(&atlas.tasks(&TaskQuery::default()).unwrap()),
        ["Buy milk"]
    );
    assert_eq!(
        titles(
            &atlas
                .tasks(&TaskQuery {
                    status: Some(TaskStatus::Completed),
                    ..Default::default()
                })
                .unwrap()
        ),
        ["Ship it"]
    );

    app.session_mut().sync_now().unwrap();
    let fields = app
        .session()
        .store
        .get(EntityKind::Task, &ship.task.id)
        .unwrap();
    assert_eq!(
        (fields["is_completed"].clone(), fields["notes"].clone()),
        (json!(true), json!("friday"))
    );
    // The activity of the completion names this account.
    assert!(app
        .session()
        .store
        .list(EntityKind::Activity)
        .iter()
        .any(|a| a.fields["to"] == "completed" && a.fields["actor_id"] == USER_ID));
}

#[test]
fn completing_a_recurring_task_spawns_the_next_occurrence() {
    let server = FakeServer::new();
    let mut atlas = connect(&server);
    let tz = resolve_time_zone(Some(TZ));
    let due = parse_due(&json!("2026-10-13"), &tz, 0).unwrap().unwrap();
    let task = atlas
        .create_task(CreateTask {
            title: "Stand-up".into(),
            due_at: Some(due),
            recurrence: Some("FREQ=DAILY".into()),
            ..Default::default()
        })
        .unwrap();
    let done = atlas.complete_task(&task.task.id).unwrap();
    let next = done.next.unwrap();
    assert_eq!(next.task.title, "Stand-up");
    assert_eq!(next.task.recurrence.as_deref(), Some("FREQ=DAILY"));
    assert!(!next.task.is_completed);
    assert!(next.task.due_ms().unwrap() > due);
    // Completing again is a no-op; reopening does not spawn.
    assert!(atlas.complete_task(&task.task.id).unwrap().next.is_none());
    assert!(atlas.reopen_task(&task.task.id).unwrap().next.is_none());
}

#[test]
fn quick_adds_with_the_apps_syntax() {
    let server = FakeServer::new();
    let mut app = connect(&server);
    app_project(&mut app, "Home");
    app.session_mut().push().unwrap();
    let mut atlas = connect(&server);
    let task = atlas.quick_add("Pay rent tomorrow #Home p1").unwrap();
    assert_eq!(
        (
            task.task.title.as_str(),
            task.task.priority,
            task.project_name.as_deref()
        ),
        ("Pay rent", 1, Some("Home"))
    );
    assert!(task.task.due_at.is_some());
}

#[test]
fn reports_what_changed_since_a_cursor() {
    let server = FakeServer::new();
    let mut app = connect(&server);
    let done = app_task(
        &mut app,
        CreateTaskInput {
            title: "Will be done".into(),
            ..Default::default()
        },
    );
    let edit = app_task(
        &mut app,
        CreateTaskInput {
            title: "Will be edited".into(),
            ..Default::default()
        },
    );
    let gone = app_task(
        &mut app,
        CreateTaskInput {
            title: "Will be trashed".into(),
            ..Default::default()
        },
    );
    app.session_mut().push().unwrap();

    let mut atlas = connect(&server);
    let since = atlas.cursor();
    let none = atlas.changes(since).unwrap();
    assert!(
        none.created.is_empty()
            && none.updated.is_empty()
            && none.completed.is_empty()
            && none.deleted.is_empty()
    );

    let new = app_task(
        &mut app,
        CreateTaskInput {
            title: "Brand new".into(),
            ..Default::default()
        },
    );
    let store = &mut app.session_mut().store;
    store.set(EntityKind::Task, &done, "is_completed", json!(true));
    store.set(EntityKind::Task, &edit, "title", json!("Was edited"));
    store.set(
        EntityKind::Task,
        &gone,
        "deleted_at",
        json!(1_700_000_000_000i64),
    );
    app.session_mut().push().unwrap();

    let changes = atlas.changes(since).unwrap();
    let ids = |v: &[atlas_client::client::TaskView]| {
        v.iter().map(|t| t.task.id.clone()).collect::<Vec<_>>()
    };
    assert_eq!(ids(&changes.created), [new]);
    assert_eq!(ids(&changes.completed), [done]);
    assert_eq!(titles(&changes.updated), ["Was edited"]);
    assert!(matches!(&changes.deleted[..], [Deleted::Task(t)] if t.task.id == gone));
    assert!(changes.cursor > since);
    let again = atlas.changes(changes.cursor).unwrap();
    assert!(again.created.is_empty() && again.updated.is_empty());
}

#[test]
fn deletes_to_the_trash_and_refuses_unknown_ids() {
    let server = FakeServer::new();
    let mut atlas = connect(&server);
    let task = atlas
        .create_task(CreateTask {
            title: "Bye".into(),
            ..Default::default()
        })
        .unwrap();
    atlas.delete_task(&task.task.id).unwrap();
    assert!(atlas.task(&task.task.id).unwrap().task.deleted_at.is_some());
    assert!(atlas.tasks(&TaskQuery::default()).unwrap().is_empty());
    let err = atlas
        .complete_task("00000000-0000-4000-8000-000000000999")
        .unwrap_err();
    assert_eq!(
        err.to_string(),
        "no task \"00000000-0000-4000-8000-000000000999\""
    );
    let err = atlas
        .create_task(CreateTask {
            title: "  ".into(),
            ..Default::default()
        })
        .unwrap_err();
    assert_eq!(err.to_string(), "a task needs a title");
    let err = atlas
        .create_task(CreateTask {
            title: "x".into(),
            priority: Some(json!(7)),
            ..Default::default()
        })
        .unwrap_err();
    assert_eq!(err.to_string(), "priority must be 1 (highest) to 4 (none)");
    let err = atlas
        .create_task(CreateTask {
            title: "x".into(),
            labels: vec!["nope".into()],
            ..Default::default()
        })
        .unwrap_err();
    assert_eq!(err.to_string(), "no label \"nope\"");
}
