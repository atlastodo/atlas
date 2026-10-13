use serde_json::{json, Value};

use super::*;

/// `test-vectors/conflict_vectors.json`, as `packages/client-core/src/conflict.test.ts` runs it:
/// each scenario's ops arrive in wire form and resolve to the expected entity in any order, batched
/// or not, and when delivered twice.
#[test]
fn shared_conflict_vectors() {
    let path = format!(
        "{}/../../test-vectors/conflict_vectors.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let entity = "00000000-0000-0000-0000-0000000000e1";
    let scenarios = fixture["scenarios"].as_array().unwrap();
    assert!(!scenarios.is_empty());
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let ops: Vec<Operation> = scenario["ops"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, spec)| {
                let mut wire = json!({
                    "id": Uuid::from_u128(i as u128 + 1),
                    "entity": "task",
                    "entity_id": entity,
                    "ts": spec["ts"],
                });
                if spec["delete"] == json!(true) {
                    wire["op"] = json!("delete");
                } else {
                    wire["op"] = json!("set");
                    wire["field"] = spec["field"].clone();
                    wire["value"] = spec["value"].clone();
                }
                serde_json::from_value(wire).unwrap()
            })
            .collect();
        let resolve = |ops: &[Operation], batch: bool| {
            let mut store = Store::new(Uuid::from_u128(0xff));
            if batch {
                store.apply_remote_batch(ops);
            } else {
                for op in ops {
                    store.apply_remote(op);
                }
            }
            let fields = store.get(EntityKind::Task, entity);
            let deleted = fields.is_none();
            (Value::Object(fields.unwrap_or_default()), deleted)
        };
        let forward = resolve(&ops, false);
        assert_eq!(
            forward.1,
            scenario["expected"]["deleted"].as_bool().unwrap(),
            "{name}"
        );
        assert_eq!(forward.0, scenario["expected"]["fields"], "{name}");
        let mut reversed = ops.clone();
        reversed.reverse();
        assert_eq!(resolve(&reversed, false), forward, "{name} reversed");
        assert_eq!(resolve(&ops, true), forward, "{name} batched");
        let twice: Vec<Operation> = ops.iter().chain(reversed.iter()).cloned().collect();
        assert_eq!(resolve(&twice, false), forward, "{name} redelivered");
    }
}

fn test_store() -> Store {
    let mut n = 0u128;
    Store::with(
        Uuid::from_u128(1),
        Box::new(|| 1_000_000),
        Box::new(move || {
            n += 1;
            Uuid::from_u128(0x1000 + n)
        }),
    )
}

#[test]
fn local_writes_queue_ops_and_resolve() {
    let mut store = test_store();
    let id = store.new_entity_id();
    store.set(EntityKind::Task, &id, "title", json!("a"));
    store.set(EntityKind::Task, &id, "title", json!("b"));
    assert_eq!(store.get(EntityKind::Task, &id).unwrap()["title"], "b");
    assert_eq!(store.unsynced_ops().len(), 2);
    let ids: Vec<Uuid> = store.unsynced_ops().iter().map(|o| o.id).collect();
    store.mark_synced(&ids[..1]);
    assert_eq!(store.unsynced_ops().len(), 1);
    store.remove(EntityKind::Task, &id);
    assert!(store.get(EntityKind::Task, &id).is_none());
    assert!(store.exists(EntityKind::Task, &id));
}

#[test]
fn discarding_an_op_uncovers_nothing_and_drops_empty_entities() {
    let mut store = test_store();
    let id = store.new_entity_id();
    let op = store.set(EntityKind::Task, &id, "title", json!("x"));
    store.discard(&[op.id]);
    assert!(!store.exists(EntityKind::Task, &id));
    assert!(store.unsynced_ops().is_empty());
}

#[test]
fn a_readable_value_replaces_an_envelope_at_the_same_stamp() {
    let mut store = test_store();
    let ts = Hlc {
        wall_ms: 5,
        counter: 0,
        node: Uuid::from_u128(9),
    };
    let entity = Uuid::from_u128(77);
    let envelope = json!({"__enc": 2, "kid": "dek", "iv": "a", "ct": "b"});
    let op = |id: u128, value: Value| Operation {
        id: Uuid::from_u128(id),
        entity: EntityKind::Task,
        entity_id: entity,
        change: Change::Set {
            field: "title".into(),
            value,
        },
        ts,
    };
    store.apply_remote(&op(1, envelope.clone()));
    store.apply_remote(&op(2, json!("open")));
    assert_eq!(
        store.get(EntityKind::Task, &entity.to_string()).unwrap()["title"],
        "open"
    );
    store.apply_remote(&op(3, envelope));
    assert_eq!(
        store.get(EntityKind::Task, &entity.to_string()).unwrap()["title"],
        "open"
    );
}

#[test]
fn restamping_moves_ops_from_a_fast_clock_below_the_limit() {
    let mut store = Store::with(
        Uuid::from_u128(1),
        Box::new(|| 10_000_000),
        Box::new(Uuid::new_v4),
    );
    let id = Uuid::from_u128(5).to_string();
    store.set(EntityKind::Task, &id, "title", json!("fast"));
    let server_time = 1_000_000;
    store.align_clock(server_time);
    assert_eq!(store.restamp_ahead(server_time), 1);
    let op = &store.unsynced_ops()[0];
    assert!(op.ts.wall_ms <= server_time + MAX_CLOCK_DRIFT_MS);
    assert_eq!(store.field_ts(EntityKind::Task, &id, "title"), Some(op.ts));
    assert_eq!(store.restamp_ahead(server_time), 0);
}
