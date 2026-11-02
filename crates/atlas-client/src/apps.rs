//! App definitions (`fieldPolicy.ts`'s `registerApp`): what an app tells the engine about its kinds
//! beyond the bundled manifest, the server's half. An app registers its definition at start-up; a
//! new kind, field or link is then the app's business and needs no change in core. See
//! `docs/architecture.md` (App definitions) and `test-vectors/scope_rule_vectors.json`.
//!
//! - A kind the manifest does not name travels as `<app>.sealed`.
//! - `scope` says how an entity finds the share scope whose key encrypts it: `"self"` (a share
//!   container: only a kind travelling as `<app>.project`, and every such kind without saying so),
//!   or links, the first one set winning: `{field}` names the project, `{field, kind}` an entity
//!   of `kind` whose scope it takes. No rule: personal.
//! - `actor_field` names the account that wrote the entity: an op setting it to anyone but the
//!   pusher is dropped as forged, and only that account re-writes the entity.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, LazyLock, RwLock};

use atlas_core::{AppManifest, PlaintextFields, Registry, UNNAMESPACED_APPS};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopeLink {
    pub field: String,
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScopeRule {
    /// The entity is a share container: its scope is itself.
    Container,
    /// The first link that is set decides.
    Links(Vec<ScopeLink>),
}

impl<'de> Deserialize<'de> for ScopeRule {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = serde_json::Value::deserialize(d)?;
        if v.as_str() == Some("self") {
            return Ok(ScopeRule::Container);
        }
        serde_json::from_value(v)
            .map(ScopeRule::Links)
            .map_err(|_| D::Error::custom("scope must be \"self\" or a list of links"))
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KindDefinition {
    #[serde(default)]
    pub wire: Option<String>,
    #[serde(default)]
    pub scope: Option<ScopeRule>,
    #[serde(default)]
    pub actor_field: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AppDefinition {
    pub app: String,
    pub kinds: BTreeMap<String, KindDefinition>,
}

impl AppDefinition {
    /// Parse a definition from its JSON (the shape `registerApp` takes).
    pub fn from_json(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map_err(|e| format!("app definition: {e}"))
    }
}

/// A kind as the engine sees it: its manifest entry (if any) with its definition's rules.
#[derive(Debug, Clone)]
pub struct ResolvedKind {
    pub app: String,
    pub wire: String,
    pub public_fields: Vec<String>,
    pub plaintext_fields: PlaintextFields,
    pub legacy_plaintext_fields: Vec<String>,
    pub scope: Option<ScopeRule>,
    pub actor_field: Option<String>,
}

impl ResolvedKind {
    pub fn is_public(&self, field: &str) -> bool {
        matches!(self.plaintext_fields, PlaintextFields::All)
            || self.public_fields.iter().any(|f| f == field)
    }
}

type Table = BTreeMap<String, ResolvedKind>;

struct State {
    definitions: Vec<AppDefinition>,
    table: Arc<Table>,
}

static STATE: LazyLock<RwLock<State>> = LazyLock::new(|| {
    RwLock::new(State {
        definitions: Vec::new(),
        table: Arc::new(build_table(&[])),
    })
});

fn build_table(defs: &[AppDefinition]) -> Table {
    let mut table = Table::new();
    for m in Registry::bundled().apps() {
        for (kind, spec) in &m.kinds {
            let container = spec.wire == format!("{}.project", m.app);
            table.insert(
                kind.clone(),
                ResolvedKind {
                    app: m.app.clone(),
                    wire: spec.wire.clone(),
                    public_fields: spec.public_fields.clone(),
                    plaintext_fields: spec.plaintext_fields.clone(),
                    legacy_plaintext_fields: spec.legacy_plaintext_fields.clone(),
                    scope: container.then_some(ScopeRule::Container),
                    actor_field: None,
                },
            );
        }
    }
    for def in defs {
        for (kind, d) in &def.kinds {
            let entry = table.entry(kind.clone()).or_insert_with(|| ResolvedKind {
                app: def.app.clone(),
                wire: format!("{}.sealed", def.app),
                public_fields: Vec::new(),
                plaintext_fields: PlaintextFields::Only(Vec::new()),
                legacy_plaintext_fields: Vec::new(),
                scope: None,
                actor_field: None,
            });
            if let Some(wire) = &d.wire {
                entry.wire = wire.clone();
            }
            if d.scope.is_some() {
                entry.scope = d.scope.clone();
            }
            if d.actor_field.is_some() {
                entry.actor_field = d.actor_field.clone();
            }
        }
    }
    table
}

fn manifest_owner(kind: &str) -> Option<&'static AppManifest> {
    Registry::bundled().app_of(kind)
}

fn definition_error(def: &AppDefinition, all: &[AppDefinition]) -> Option<String> {
    let Some(server) = Registry::bundled().app(&def.app) else {
        return Some(format!(
            "no bundled manifest for app \"{}\": the server would refuse it",
            def.app
        ));
    };
    let sealed = format!("{}.sealed", def.app);
    let project = format!("{}.project", def.app);
    let has_wire = |w: &str| server.wire_kinds.contains_key(w);
    for (kind, d) in &def.kinds {
        let what = format!("app {}: kind \"{kind}\"", def.app);
        let owner = manifest_owner(kind);
        if let Some(o) = owner.filter(|o| o.app != def.app) {
            return Some(format!("{what} belongs to app {}", o.app));
        }
        if owner.is_none()
            && !UNNAMESPACED_APPS.contains(&def.app.as_str())
            && !kind.starts_with(&format!("{}.", def.app))
        {
            return Some(format!("{what} must be named \"{}.<kind>\"", def.app));
        }
        let base = owner.and_then(|o| o.kinds.get(kind));
        let wire = d
            .wire
            .clone()
            .or_else(|| base.map(|b| b.wire.clone()))
            .unwrap_or_else(|| sealed.clone());
        let wire_ok = match base {
            Some(b) => wire == b.wire,
            None => wire == sealed && has_wire(&sealed),
        };
        if !wire_ok {
            return Some(format!("{what} cannot travel as \"{wire}\""));
        }
        if d.actor_field.as_deref() == Some("") {
            return Some(format!("{what}: actor_field must be a field name"));
        }
        match &d.scope {
            None => {}
            Some(ScopeRule::Container) => {
                if wire != project {
                    return Some(format!(
                        "{what}: only a \"{project}\" kind is a share container"
                    ));
                }
            }
            Some(ScopeRule::Links(links)) => {
                if links.is_empty() {
                    return Some(format!("{what}: scope must be \"self\" or a list of links"));
                }
                if !has_wire(&project) {
                    return Some(format!("{what}: app {} has no share containers", def.app));
                }
                for link in links {
                    if link.field.is_empty() {
                        return Some(format!("{what}: a link needs a field"));
                    }
                    if let Some(k) = &link.kind {
                        let known = all.iter().any(|a| a.kinds.contains_key(k))
                            || manifest_owner(k).is_some();
                        if !known {
                            return Some(format!("{what}: links to unknown kind \"{k}\""));
                        }
                    }
                }
            }
        }
    }
    None
}

fn cycle_error(table: &Table) -> Option<String> {
    fn walk(table: &Table, kind: &str, path: &mut Vec<String>) -> bool {
        if path.iter().any(|k| k == kind) {
            return true;
        }
        let Some(ScopeRule::Links(links)) = table.get(kind).and_then(|k| k.scope.as_ref()) else {
            return false;
        };
        path.push(kind.to_owned());
        let cyclic = links
            .iter()
            .filter_map(|l| l.kind.as_deref())
            .any(|k| walk(table, k, path));
        path.pop();
        cyclic
    }
    table
        .keys()
        .find(|k| walk(table, k, &mut Vec::new()))
        .map(|k| format!("\"{k}\" links in a cycle"))
}

/// Register (or replace) an app's definition. An error when it conflicts with the bundled
/// manifests or with itself; nothing changes then.
pub fn register_app(def: AppDefinition) -> Result<(), String> {
    let mut state = STATE.write().expect("app registry");
    let mut next: Vec<AppDefinition> = state
        .definitions
        .iter()
        .filter(|d| d.app != def.app)
        .cloned()
        .collect();
    next.push(def.clone());
    if let Some(e) = definition_error(&def, &next) {
        return Err(format!("app definition: {e}"));
    }
    let table = build_table(&next);
    if let Some(e) = cycle_error(&table) {
        return Err(format!("app definition: {e}"));
    }
    state.definitions = next;
    state.table = Arc::new(table);
    Ok(())
}

/// Drop an app's registered definition (tests).
pub fn unregister_app(app: &str) {
    let mut state = STATE.write().expect("app registry");
    state.definitions.retain(|d| d.app != app);
    state.table = Arc::new(build_table(&state.definitions));
}

/// The registered app definitions.
pub fn app_definitions() -> Vec<AppDefinition> {
    STATE.read().expect("app registry").definitions.clone()
}

fn table() -> Arc<Table> {
    STATE.read().expect("app registry").table.clone()
}

/// A kind as the engine sees it now.
pub fn kind(kind: &str) -> Option<ResolvedKind> {
    table().get(kind).cloned()
}

/// Every kind this client knows: the bundled manifests' and the registered definitions'.
pub fn known_kinds() -> Vec<String> {
    table().keys().cloned().collect()
}

/// How `kind` finds its scope; `None` for a personal kind.
pub fn scope_rule_of(kind: &str) -> Option<ScopeRule> {
    table().get(kind).and_then(|k| k.scope.clone())
}

/// The field naming the writer of a `kind` entity, if it has one.
pub fn actor_field_of(kind: &str) -> Option<String> {
    table().get(kind).and_then(|k| k.actor_field.clone())
}

/// Every field a scope link reads, of any kind.
pub fn scope_link_fields() -> BTreeSet<String> {
    let mut fields = BTreeSet::new();
    for k in table().values() {
        if let Some(ScopeRule::Links(links)) = &k.scope {
            fields.extend(links.iter().map(|l| l.field.clone()));
        }
    }
    fields
}

/// The real kinds travelling as `wire`.
pub fn kinds_of_wire(wire: &str) -> Vec<String> {
    table()
        .iter()
        .filter(|(_, k)| k.wire == wire)
        .map(|(name, _)| name.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scope::{resolve_scope, Scope};
    use crate::store::Store;
    use serde_json::Value;

    fn vectors() -> Value {
        let path = format!(
            "{}/../../test-vectors/scope_rule_vectors.json",
            env!("CARGO_MANIFEST_DIR")
        );
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    use crate::testing::register_test_app;

    #[test]
    fn scope_rule_vectors() {
        register_test_app();
        let v = vectors();
        for c in v["wire"].as_array().unwrap() {
            let k = c["kind"].as_str().unwrap();
            assert_eq!(
                crate::field_policy::wire_kind_of(k).as_deref(),
                c["wire"].as_str(),
                "{k}"
            );
        }
        for c in v["actor_fields"].as_array().unwrap() {
            let k = c["kind"].as_str().unwrap();
            assert_eq!(actor_field_of(k).as_deref(), c["field"].as_str(), "{k}");
        }
        let fields: Vec<String> = scope_link_fields().into_iter().collect();
        let expected: Vec<String> = serde_json::from_value(v["link_fields"].clone()).unwrap();
        assert_eq!(fields, expected);

        // This store keys entities by UUID: every id of the fixture maps to one.
        let uuid =
            |id: &str| uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, id.as_bytes()).to_string();
        let mut store = Store::new(uuid::Uuid::from_u128(1));
        for e in v["store"].as_array().unwrap() {
            let (kind, id) = (e["kind"].as_str().unwrap(), e["id"].as_str().unwrap());
            for (field, value) in e["fields"].as_object().unwrap() {
                let value = match value.as_str() {
                    Some(s) if field.ends_with("_id") => Value::from(uuid(s)),
                    _ => value.clone(),
                };
                store.set(kind, &uuid(id), field, value);
            }
        }
        for c in v["cases"].as_array().unwrap() {
            let (kind, id) = (c["kind"].as_str().unwrap(), c["id"].as_str().unwrap());
            let shown = match resolve_scope(&store, kind, &uuid(id), None) {
                Scope::Personal => "personal".to_owned(),
                Scope::Unknown => "unknown".to_owned(),
                Scope::Project(p) => format!("project:{p}"),
            };
            let expected = c["expected"].as_str().unwrap();
            let expected = match expected.strip_prefix("project:") {
                Some(p) => format!("project:{}", uuid(p)),
                None => expected.to_owned(),
            };
            assert_eq!(shown, expected, "{kind} {id}");
        }

        for c in v["invalid"].as_array().unwrap() {
            let why = c["why"].as_str().unwrap();
            let refused = serde_json::from_value::<AppDefinition>(c["definition"].clone())
                .map_err(|e| e.to_string())
                .and_then(register_app);
            assert!(refused.is_err(), "{why}");
        }
        assert_eq!(
            crate::field_policy::wire_kind_of("vector_note").as_deref(),
            Some("todo.sealed")
        );
        assert_eq!(crate::field_policy::wire_kind_of("vector_a"), None);
        register_test_app();
    }
}
