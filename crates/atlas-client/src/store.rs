//! The in-memory store (`store.ts`, without persistence): entities are bags of fields resolved by
//! field-level last-writer-wins over HLC stamps, as on the server. Local writes stamp a new HLC and
//! queue an op in the outbox; remote ops merge idempotently.
//!
//! Entities keep the order they first appeared in, and fields the order they were first set, as
//! the TypeScript `Map`s do: lists built from the store come out in the same order on both.

use std::collections::{HashMap, HashSet};

use atlas_core::{Change, EntityKind, Hlc, HlcClock, Operation};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::crypto::is_encrypted_envelope;

/// The server's `MAX_FUTURE_SKEW_MS`: a later stamp would pin the clock.
pub const MAX_CLOCK_DRIFT_MS: u64 = 5 * 60_000;

#[derive(Debug, Clone)]
struct FieldState {
    value: Value,
    ts: Hlc,
    op: Uuid,
}

#[derive(Debug, Clone, Default)]
struct EntityState {
    fields: Vec<(String, FieldState)>,
    deleted: Option<Hlc>,
    deleted_op: Option<Uuid>,
}

impl EntityState {
    fn field(&self, name: &str) -> Option<&FieldState> {
        self.fields.iter().find(|(n, _)| n == name).map(|(_, f)| f)
    }

    fn field_mut(&mut self, name: &str) -> Option<&mut FieldState> {
        self.fields
            .iter_mut()
            .find(|(n, _)| n == name)
            .map(|(_, f)| f)
    }

    fn set_field(&mut self, name: &str, state: FieldState) {
        match self.field_mut(name) {
            Some(f) => *f = state,
            None => self.fields.push((name.to_owned(), state)),
        }
    }

    fn visible(&self, ts: &Hlc) -> bool {
        self.deleted.is_none_or(|d| *ts > d)
    }

    fn visible_fields(&self) -> Map<String, Value> {
        let mut out = Map::new();
        for (name, fs) in &self.fields {
            if self.visible(&fs.ts) {
                out.insert(name.clone(), fs.value.clone());
            }
        }
        out
    }
}

#[derive(Debug, Default)]
struct Kind {
    order: Vec<String>,
    by_id: HashMap<String, EntityState>,
}

/// An entity's id and its visible fields.
#[derive(Debug, Clone)]
pub struct ResolvedEntity {
    pub id: String,
    pub fields: Map<String, Value>,
}

/// A field whose envelope a key here opened (see [`Store::revive_locked`]).
#[derive(Debug, Clone)]
pub struct Opened {
    pub value: Value,
    pub key_id: String,
    pub scope: crate::crypto::KeyScope,
    pub version: u8,
}

#[derive(Debug, Clone)]
pub struct RevivedField {
    pub entity: EntityKind,
    pub entity_id: String,
    pub field: String,
    pub ts: Hlc,
    pub opened: Opened,
}

pub type Clock = Box<dyn Fn() -> u64 + Send>;
pub type IdGen = Box<dyn FnMut() -> Uuid + Send>;

pub struct Store {
    clock: HlcClock,
    wall_clock: Clock,
    clock_offset: i64,
    new_id: IdGen,
    entities: Vec<(EntityKind, Kind)>,
    outbox: Vec<Operation>,
    applied: HashSet<Uuid>,
    acknowledged: Option<Hlc>,
}

/// The entity id an op names, as a lowercase UUID string.
pub fn op_entity_id(op: &Operation) -> String {
    op.entity_id.to_string()
}

impl Store {
    /// A store whose ops are stamped by `node` (this client's device id).
    pub fn new(node: Uuid) -> Self {
        Self::with(node, Box::new(now_ms), Box::new(Uuid::new_v4))
    }

    pub fn with(node: Uuid, wall_clock: Clock, new_id: IdGen) -> Self {
        Self {
            clock: HlcClock::new(node),
            wall_clock,
            clock_offset: 0,
            new_id,
            entities: Vec::new(),
            outbox: Vec::new(),
            applied: HashSet::new(),
            acknowledged: None,
        }
    }

    /// The physical clock the store stamps by, corrected by [`Store::align_clock`].
    pub fn now(&self) -> u64 {
        ((self.wall_clock)() as i64 + self.clock_offset).max(0) as u64
    }

    pub fn new_entity_id(&mut self) -> String {
        (self.new_id)().to_string()
    }

    fn kind(&self, entity: EntityKind) -> Option<&Kind> {
        self.entities
            .iter()
            .find(|(k, _)| *k == entity)
            .map(|(_, v)| v)
    }

    fn kind_mut(&mut self, entity: EntityKind) -> &mut Kind {
        if let Some(i) = self.entities.iter().position(|(k, _)| *k == entity) {
            return &mut self.entities[i].1;
        }
        self.entities.push((entity, Kind::default()));
        &mut self.entities.last_mut().expect("just pushed").1
    }

    fn state(&self, entity: EntityKind, id: &str) -> Option<&EntityState> {
        self.kind(entity)?.by_id.get(id)
    }

    fn state_mut(&mut self, entity: EntityKind, id: &str) -> Option<&mut EntityState> {
        self.entities
            .iter_mut()
            .find(|(k, _)| *k == entity)?
            .1
            .by_id
            .get_mut(id)
    }

    fn observe(&mut self, ts: Hlc) {
        let now = self.now();
        if ts.wall_ms > now + MAX_CLOCK_DRIFT_MS {
            return;
        }
        self.clock.update(ts, now);
    }

    fn note_acknowledged(&mut self, ts: Hlc) {
        if self.acknowledged.is_none_or(|a| ts > a) {
            self.acknowledged = Some(ts);
        }
    }

    fn make_op(&mut self, entity: EntityKind, id: &str, change: Change, ts: Hlc) -> Operation {
        Operation {
            id: (self.new_id)(),
            entity,
            entity_id: Uuid::parse_str(id).expect("entity ids are UUIDs"),
            change,
            ts,
        }
    }

    pub fn set(&mut self, entity: EntityKind, id: &str, field: &str, value: Value) -> Operation {
        let ts = self.clock.now(self.now());
        let op = self.make_op(
            entity,
            id,
            Change::Set {
                field: field.to_owned(),
                value,
            },
            ts,
        );
        self.merge(&op);
        self.outbox.push(op.clone());
        op
    }

    /// Write `value` at a given stamp; `None` when it does not beat the current value.
    pub fn rewrite_field(
        &mut self,
        entity: EntityKind,
        id: &str,
        field: &str,
        value: Value,
        ts: Hlc,
    ) -> Option<Operation> {
        let op = self.make_op(
            entity,
            id,
            Change::Set {
                field: field.to_owned(),
                value,
            },
            ts,
        );
        self.observe(ts);
        if !self.merge(&op) {
            return None;
        }
        self.outbox.push(op.clone());
        Some(op)
    }

    /// A tombstone for the entity.
    pub fn remove(&mut self, entity: EntityKind, id: &str) -> Operation {
        let ts = self.clock.now(self.now());
        let op = self.make_op(entity, id, Change::Delete, ts);
        self.merge(&op);
        self.outbox.push(op.clone());
        op
    }

    /// Merge one remote op; idempotent, queues nothing.
    pub fn apply_remote(&mut self, op: &Operation) -> bool {
        self.apply_remote_batch(std::slice::from_ref(op))
    }

    pub fn apply_remote_batch(&mut self, ops: &[Operation]) -> bool {
        let mut changed = false;
        for op in ops {
            self.observe(op.ts);
            self.note_acknowledged(op.ts);
            changed |= self.merge(op);
        }
        changed
    }

    fn merge(&mut self, op: &Operation) -> bool {
        if !self.applied.insert(op.id) {
            return false;
        }
        let id = op_entity_id(op);
        let kind = self.kind_mut(op.entity);
        if !kind.by_id.contains_key(&id) {
            kind.order.push(id.clone());
            kind.by_id.insert(id.clone(), EntityState::default());
        }
        let state = kind.by_id.get_mut(&id).expect("just inserted");
        match &op.change {
            Change::Delete => {
                let changed = state.deleted.is_none_or(|d| op.ts > d);
                if changed {
                    state.deleted = Some(op.ts);
                    state.deleted_op = Some(op.id);
                }
                changed
            }
            Change::Set { field, value } => {
                let changed = match state.field(field) {
                    None => true,
                    Some(existing) => {
                        op.ts > existing.ts
                            || (op.ts == existing.ts
                                && is_encrypted_envelope(&existing.value)
                                && !is_encrypted_envelope(value))
                    }
                };
                if changed {
                    state.set_field(
                        field,
                        FieldState {
                            value: value.clone(),
                            ts: op.ts,
                            op: op.id,
                        },
                    );
                }
                changed
            }
        }
    }

    /// The entity's visible fields; `None` when it is unknown or a tombstone hides every field.
    pub fn get(&self, entity: EntityKind, id: &str) -> Option<Map<String, Value>> {
        let state = self.state(entity, id)?;
        let visible = state.visible_fields();
        if state.deleted.is_some() && visible.is_empty() {
            return None;
        }
        Some(visible)
    }

    pub fn list(&self, entity: EntityKind) -> Vec<ResolvedEntity> {
        let Some(kind) = self.kind(entity) else {
            return Vec::new();
        };
        kind.order
            .iter()
            .filter_map(|id| {
                let state = &kind.by_id[id];
                let fields = state.visible_fields();
                if state.deleted.is_some() && fields.is_empty() {
                    return None;
                }
                Some(ResolvedEntity {
                    id: id.clone(),
                    fields,
                })
            })
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.entities.iter().all(|(_, k)| k.by_id.is_empty())
    }

    /// Whether any op for the entity was merged, tombstoned or not.
    pub fn exists(&self, entity: EntityKind, id: &str) -> bool {
        self.state(entity, id).is_some()
    }

    /// The winning value of a field, hidden by a tombstone or not.
    pub fn raw_field(&self, entity: EntityKind, id: &str, field: &str) -> Option<&Value> {
        self.state(entity, id)?.field(field).map(|f| &f.value)
    }

    /// The stamp of a visible field.
    pub fn field_ts(&self, entity: EntityKind, id: &str, field: &str) -> Option<Hlc> {
        let state = self.state(entity, id)?;
        let fs = state.field(field)?;
        state.visible(&fs.ts).then_some(fs.ts)
    }

    pub fn visible_field_states(&self, entity: EntityKind, id: &str) -> Vec<(String, Value, Hlc)> {
        let Some(state) = self.state(entity, id) else {
            return Vec::new();
        };
        state
            .fields
            .iter()
            .filter(|(_, fs)| state.visible(&fs.ts))
            .map(|(n, fs)| (n.clone(), fs.value.clone(), fs.ts))
            .collect()
    }

    /// Open stored envelopes with `open`, keeping their stamps: nothing is pushed.
    pub fn revive_locked(
        &mut self,
        mut open: impl FnMut(&Store, EntityKind, &str, &str, &Value) -> Option<Opened>,
    ) -> Vec<RevivedField> {
        let mut found = Vec::new();
        for (entity, kind) in &self.entities {
            for id in &kind.order {
                for (field, fs) in &kind.by_id[id].fields {
                    if !is_encrypted_envelope(&fs.value) {
                        continue;
                    }
                    if let Some(opened) = open(self, *entity, id, field, &fs.value) {
                        found.push(RevivedField {
                            entity: *entity,
                            entity_id: id.clone(),
                            field: field.clone(),
                            ts: fs.ts,
                            opened,
                        });
                    }
                }
            }
        }
        for r in &found {
            let op_id = (self.new_id)();
            self.applied.insert(op_id);
            let state = self.state_mut(r.entity, &r.entity_id).expect("found above");
            let fs = state.field_mut(&r.field).expect("found above");
            fs.value = r.opened.value.clone();
            fs.op = op_id;
        }
        found
    }

    /// Drop the synced state, keeping the outbox, before a rebuild from the snapshot.
    pub fn reset_synced(&mut self) {
        self.entities.clear();
        self.applied.clear();
        for op in self.outbox.clone() {
            self.merge(&op);
        }
    }

    pub fn unsynced_ops(&self) -> Vec<Operation> {
        self.outbox.clone()
    }

    /// The server took these ops.
    pub fn mark_synced(&mut self, ids: &[Uuid]) {
        for id in ids {
            if let Some(i) = self.outbox.iter().position(|o| o.id == *id) {
                let op = self.outbox.remove(i);
                self.note_acknowledged(op.ts);
            }
        }
    }

    /// Take back ops the server refuses for good, so they stop masking the server's values.
    pub fn discard(&mut self, ids: &[Uuid]) {
        for id in ids {
            let Some(i) = self.outbox.iter().position(|o| o.id == *id) else {
                continue;
            };
            let op = self.outbox.remove(i);
            let eid = op_entity_id(&op);
            let Some(state) = self.state_mut(op.entity, &eid) else {
                continue;
            };
            match &op.change {
                Change::Delete if state.deleted_op == Some(op.id) => {
                    state.deleted = None;
                    state.deleted_op = None;
                }
                Change::Set { field, .. } if state.field(field).is_some_and(|f| f.op == op.id) => {
                    state.fields.retain(|(n, _)| n != field);
                }
                _ => {}
            }
            if state.fields.is_empty() && state.deleted.is_none() {
                let kind = self.kind_mut(op.entity);
                kind.by_id.remove(&eid);
                kind.order.retain(|x| *x != eid);
            }
        }
    }

    /// Stamp new ops by the server's clock after a fast-clock refusal.
    pub fn align_clock(&mut self, server_time_ms: u64) -> i64 {
        self.clock_offset = server_time_ms as i64 - (self.wall_clock)() as i64;
        self.clock_offset
    }

    /// After a `clock_skew` refusal (and [`Store::align_clock`]): re-stamp the unsynced ops stamped
    /// past `server_time_ms` + [`MAX_CLOCK_DRIFT_MS`], in their old order above every stamp the
    /// server holds that this store has seen, and wind the clock back. Returns how many.
    pub fn restamp_ahead(&mut self, server_time_ms: u64) -> usize {
        let limit = server_time_ms + MAX_CLOCK_DRIFT_MS;
        let mut ahead: Vec<Operation> = Vec::new();
        let mut floor = self.acknowledged;
        for op in &self.outbox {
            if op.ts.wall_ms > limit {
                ahead.push(op.clone());
            } else if floor.is_none_or(|f| op.ts > f) {
                floor = Some(op.ts);
            }
        }
        if ahead.is_empty() && self.clock.last().wall_ms <= limit {
            return 0;
        }
        if floor.is_some_and(|f| f.wall_ms > limit) {
            return 0;
        }
        self.clock.rewind(floor.unwrap_or(Hlc::zero(Uuid::nil())));
        if ahead.is_empty() {
            return 0;
        }
        ahead.sort_by_key(|o| o.ts);
        let now = self.now();
        for old in &ahead {
            let ts = self.clock.now(now);
            if let Some(o) = self.outbox.iter_mut().find(|o| o.id == old.id) {
                o.ts = ts;
            }
            let eid = op_entity_id(old);
            if let Some(state) = self.state_mut(old.entity, &eid) {
                match &old.change {
                    Change::Delete => {
                        if state.deleted_op == Some(old.id) {
                            state.deleted = Some(ts);
                        }
                    }
                    Change::Set { field, .. } => {
                        if let Some(fs) = state.field_mut(field) {
                            if fs.op == old.id {
                                fs.ts = ts;
                            }
                        }
                    }
                }
            }
        }
        ahead.len()
    }
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;
