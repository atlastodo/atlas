//! App manifests: which app owns each synced entity kind, and which of its fields travel in
//! plaintext.
//!
//! Atlas is a suite of apps (todo today) on one server and one account. Each app ships a
//! first-party manifest in the repository's `manifests/` directory, compiled in here
//! ([`BUNDLED_MANIFESTS`]) and bundled by the clients too, so server and clients read the same
//! table. Operators never load manifests from disk; they choose which bundled apps an instance
//! offers (`ATLAS_APPS`, in the server).
//!
//! The [`Registry`] is keyed by wire names, not by [`EntityKind`]. The enum stays closed: the
//! server's authorization and fan-out match on todo's kinds exhaustively, and an open kind would
//! let an op of an unknown kind past those matches. A later app adds its namespaced kinds
//! (`notes.note`) as variants with an explicit `#[serde(rename)]` and ships its manifest here;
//! [`tests::every_entity_kind_belongs_to_exactly_one_bundled_app`] fails until both agree.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde_json::Value;

use crate::op::EntityKind;

/// The manifests compiled into this build, as JSON.
pub const BUNDLED_MANIFESTS: &[&str] = &[include_str!("../../../manifests/todo.json")];

/// Apps whose kinds predate namespacing and keep their bare wire names (`task`, `project`).
/// Every other app's kinds must be `<app>.<kind>`.
pub const UNNAMESPACED_APPS: &[&str] = &["todo"];

/// Which fields of a kind a client sends without end-to-end encryption.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlaintextFields {
    /// Every field (server-authored kinds such as `project_member`).
    All,
    /// Only these; every other field value is encrypted.
    Only(Vec<String>),
}

impl PlaintextFields {
    pub fn contains(&self, field: &str) -> bool {
        match self {
            PlaintextFields::All => true,
            PlaintextFields::Only(fields) => fields.iter().any(|f| f == field),
        }
    }
}

/// One entity kind an app syncs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KindManifest {
    pub plaintext_fields: PlaintextFields,
}

/// One app's manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppManifest {
    /// The app id (`todo`): lowercase ASCII letters, digits and `_`, starting with a letter.
    pub app: String,
    /// Display name.
    pub name: String,
    /// The manifest's version, bumped whenever its kinds or their plaintext fields change.
    pub version: u32,
    /// Entity kinds by wire name.
    pub kinds: BTreeMap<String, KindManifest>,
}

fn is_ident(s: &str) -> bool {
    let mut bytes = s.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_lowercase())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

impl AppManifest {
    /// Parse and check one manifest's JSON.
    pub fn parse(json: &str) -> Result<Self, String> {
        let doc: Value = serde_json::from_str(json).map_err(|e| format!("manifest: {e}"))?;
        let str_field = |key: &str| {
            doc.get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| format!("manifest: `{key}` must be a string"))
        };
        let app = str_field("app")?;
        if !is_ident(&app) {
            return Err(format!("manifest: invalid app id {app:?}"));
        }
        let name = str_field("name")?;
        let version = doc
            .get("version")
            .and_then(Value::as_u64)
            .and_then(|v| u32::try_from(v).ok())
            .filter(|v| *v >= 1)
            .ok_or_else(|| format!("manifest {app}: `version` must be a positive integer"))?;
        let raw_kinds = doc
            .get("kinds")
            .and_then(Value::as_object)
            .filter(|k| !k.is_empty())
            .ok_or_else(|| format!("manifest {app}: `kinds` must be a non-empty object"))?;
        let namespaced = !UNNAMESPACED_APPS.contains(&app.as_str());
        let mut kinds = BTreeMap::new();
        for (kind, spec) in raw_kinds {
            let local = if namespaced {
                kind.strip_prefix(&format!("{app}.")).ok_or_else(|| {
                    format!("manifest {app}: kind {kind:?} must be namespaced as `{app}.<kind>`")
                })?
            } else {
                kind.as_str()
            };
            if !is_ident(local) {
                return Err(format!("manifest {app}: invalid kind name {kind:?}"));
            }
            let plaintext_fields = match spec.get("plaintext_fields") {
                Some(Value::String(s)) if s == "all" => PlaintextFields::All,
                Some(Value::Array(fields)) => PlaintextFields::Only(
                    fields
                        .iter()
                        .map(|f| f.as_str().filter(|f| is_ident(f)).map(str::to_owned))
                        .collect::<Option<Vec<_>>>()
                        .ok_or_else(|| {
                            format!("manifest {app}: {kind}.plaintext_fields has a bad entry")
                        })?,
                ),
                _ => {
                    return Err(format!(
                        "manifest {app}: {kind}.plaintext_fields must be \"all\" or a list"
                    ))
                }
            };
            kinds.insert(kind.clone(), KindManifest { plaintext_fields });
        }
        Ok(Self {
            app,
            name,
            version,
            kinds,
        })
    }
}

/// Every bundled manifest, and which app owns each kind.
#[derive(Debug, Clone)]
pub struct Registry {
    apps: Vec<AppManifest>,
    kind_app: BTreeMap<String, usize>,
}

impl Registry {
    /// Build a registry from manifest JSON: app ids unique, and each kind owned by one app.
    pub fn from_manifests(sources: &[&str]) -> Result<Self, String> {
        let mut apps: Vec<AppManifest> = Vec::with_capacity(sources.len());
        let mut kind_app = BTreeMap::new();
        for source in sources {
            let manifest = AppManifest::parse(source)?;
            if apps.iter().any(|a| a.app == manifest.app) {
                return Err(format!("manifest {}: app id used twice", manifest.app));
            }
            for kind in manifest.kinds.keys() {
                if let Some(&other) = kind_app.get(kind) {
                    let other: &AppManifest = &apps[other];
                    return Err(format!(
                        "kind {kind:?} is claimed by both {} and {}",
                        other.app, manifest.app
                    ));
                }
                kind_app.insert(kind.clone(), apps.len());
            }
            apps.push(manifest);
        }
        Ok(Self { apps, kind_app })
    }

    /// The manifests compiled into this build ([`BUNDLED_MANIFESTS`]).
    pub fn bundled() -> &'static Registry {
        static BUNDLED: LazyLock<Registry> = LazyLock::new(|| {
            Registry::from_manifests(BUNDLED_MANIFESTS).expect("bundled manifests are valid")
        });
        &BUNDLED
    }

    pub fn apps(&self) -> &[AppManifest] {
        &self.apps
    }

    pub fn app(&self, id: &str) -> Option<&AppManifest> {
        self.apps.iter().find(|a| a.app == id)
    }

    /// The app owning the kind with this wire name.
    pub fn app_of(&self, kind: &str) -> Option<&AppManifest> {
        self.kind_app.get(kind).map(|&i| &self.apps[i])
    }

    pub fn kind(&self, kind: &str) -> Option<&KindManifest> {
        self.app_of(kind)?.kinds.get(kind)
    }
}

impl EntityKind {
    /// The bundled app this kind belongs to.
    pub fn app(self) -> &'static str {
        Registry::bundled()
            .app_of(self.as_str())
            .map(|a| a.app.as_str())
            .expect("every entity kind is in a bundled manifest")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entity_kind_belongs_to_exactly_one_bundled_app() {
        let registry = Registry::bundled();
        for kind in EntityKind::ALL {
            assert!(
                registry.app_of(kind.as_str()).is_some(),
                "{kind:?} is in no bundled manifest"
            );
        }
        for app in registry.apps() {
            for name in app.kinds.keys() {
                let kind = EntityKind::from_wire(name)
                    .unwrap_or_else(|| panic!("{name} ({}) is no EntityKind", app.app));
                assert_eq!(kind.as_str(), name);
            }
        }
    }

    #[test]
    fn todo_owns_the_original_kinds() {
        let registry = Registry::bundled();
        let todo = registry.app("todo").expect("todo is bundled");
        assert_eq!(todo.name, "Atlas Todo");
        assert_eq!(EntityKind::Task.app(), "todo");
        assert_eq!(EntityKind::Attachment.app(), "todo");
        let task = registry.kind("task").unwrap();
        assert!(task.plaintext_fields.contains("project_id"));
        assert!(!task.plaintext_fields.contains("title"));
        assert!(registry
            .kind("project_member")
            .unwrap()
            .plaintext_fields
            .contains("anything"));
    }

    #[test]
    fn later_apps_must_namespace_their_kinds() {
        let notes = r#"{"app":"notes","name":"Notes","version":1,
            "kinds":{"note":{"plaintext_fields":[]}}}"#;
        let err = Registry::from_manifests(&[notes]).unwrap_err();
        assert!(err.contains("notes.<kind>"), "{err}");
        let notes = r#"{"app":"notes","name":"Notes","version":1,
            "kinds":{"notes.note":{"plaintext_fields":["folder_id"]}}}"#;
        let registry = Registry::from_manifests(&[BUNDLED_MANIFESTS[0], notes]).unwrap();
        assert_eq!(registry.app_of("notes.note").unwrap().app, "notes");
        assert_eq!(registry.app_of("task").unwrap().app, "todo");
        assert_eq!(registry.app_of("note"), None);
    }

    #[test]
    fn an_app_bundled_twice_is_refused() {
        let todo = BUNDLED_MANIFESTS[0];
        let err = Registry::from_manifests(&[todo, todo]).unwrap_err();
        assert!(err.contains("used twice"), "{err}");
    }

    #[test]
    fn malformed_manifests_are_refused() {
        for bad in [
            r#"{"app":"Todo","name":"x","version":1,"kinds":{"t":{"plaintext_fields":[]}}}"#,
            r#"{"app":"x","name":"x","version":0,"kinds":{"x.t":{"plaintext_fields":[]}}}"#,
            r#"{"app":"x","name":"x","version":1,"kinds":{}}"#,
            r#"{"app":"x","name":"x","version":1,"kinds":{"x.t":{"plaintext_fields":"some"}}}"#,
            r#"{"app":"x","name":"x","version":1,"kinds":{"x.t":{"plaintext_fields":[1]}}}"#,
            r#"{"app":"x","version":1,"kinds":{"x.t":{"plaintext_fields":[]}}}"#,
        ] {
            assert!(AppManifest::parse(bad).is_err(), "{bad}");
        }
    }
}
