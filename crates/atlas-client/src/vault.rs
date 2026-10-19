//! Atlas Vault items (`vault.item`) and folders (`vault.folder`, `manifests/vault.json`) for a
//! session of the vault app, at parity with `packages/shared/src/vault.ts` through
//! `test-vectors/vault_item_vectors.json`. Every field is encrypted (the manifest lists no
//! plaintext field), under the vault app key the token carries.
//!
//! An item's fields, as stored (see `docs/integrations.md`):
//! - `type`: one of [`ITEM_TYPES`]; `name`: non-empty text.
//! - `fields`: a list of `{name, kind, value}`, names unique case-insensitively, `kind` one of
//!   [`FIELD_KINDS`]; `hidden` and `totp` values are secrets (a TOTP value is an `otpauth://` URI
//!   or a base32 seed, stored upper-case without spaces or padding).
//! - `urls`, `tags`: lists of strings; `notes`: text; `folder`: a folder's id or null;
//!   `favorite`: a boolean.
//! - `history`: the earlier values of secret fields, `{field, value, changed_at}`, newest first, at
//!   most [`HISTORY_PER_FIELD`] per field name.
//! - `created_at`, `updated_at`: unix ms; `deleted_at`: unix ms once in the trash, else null.

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::client::AtlasClient;
use crate::error::{Error, Result};
use crate::journal::clean_tags;
use crate::session::app_name;
use atlas_core::EntityKind;

pub const VAULT_APP: &str = "vault";

/// The item types.
pub const ITEM_TYPES: &[&str] = &["login", "note", "card", "identity", "ssh_key", "api_key"];
/// The field kinds; [`SECRET_KINDS`] are the secret ones.
pub const FIELD_KINDS: &[&str] = &["text", "hidden", "totp", "email", "url", "phone"];
/// Field kinds whose values are secrets: kept in the history when they change, and left out of
/// listings. A kind this client does not know counts as secret too.
pub const SECRET_KINDS: &[&str] = &["hidden", "totp"];
/// How many earlier values of one secret field the history keeps.
pub const HISTORY_PER_FIELD: usize = 5;

const CREATE_KEYS: &[&str] = &[
    "type", "name", "fields", "urls", "notes", "tags", "folder", "favorite",
];
const PATCH_KEYS: &[&str] = &[
    "type",
    "name",
    "fields",
    "set_fields",
    "remove_fields",
    "urls",
    "notes",
    "tags",
    "folder",
    "favorite",
];

/// One typed field of an item.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VaultField {
    pub name: String,
    pub kind: String,
    pub value: String,
}

/// An earlier value of a secret field.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VaultHistoryEntry {
    pub field: String,
    pub value: String,
    pub changed_at: i64,
}

/// A vault item as integrations see it, secrets included.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VaultItem {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub fields: Vec<VaultField>,
    pub urls: Vec<String>,
    pub notes: String,
    pub tags: Vec<String>,
    pub folder: Option<String>,
    pub favorite: bool,
    pub history: Vec<VaultHistoryEntry>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

/// A field's name and kind, without its value.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VaultFieldSummary {
    pub name: String,
    pub kind: String,
}

/// An item in a listing: everything but the field values, notes and history.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VaultItemSummary {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub fields: Vec<VaultFieldSummary>,
    pub urls: Vec<String>,
    pub tags: Vec<String>,
    pub folder: Option<String>,
    pub favorite: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

/// A vault folder.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VaultFolder {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

/// An item with its folder's name, as the CLI prints it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VaultItemView {
    #[serde(flatten)]
    pub item: VaultItem,
    pub folder_name: Option<String>,
}

/// A listed item with its folder's name.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VaultItemSummaryView {
    #[serde(flatten)]
    pub item: VaultItemSummary,
    pub folder_name: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct VaultQuery {
    /// A folder id or name (case-insensitive).
    pub folder: Option<String>,
    /// An item type.
    pub kind: Option<String>,
    /// A tag, case-insensitive.
    pub tag: Option<String>,
    /// Case-insensitive substring of the name, a URL or a tag.
    pub search: Option<String>,
}

fn bad(message: impl Into<String>) -> Error {
    Error::atlas("bad_input", message)
}

fn int(v: Option<&Value>) -> Option<i64> {
    let v = v?;
    v.as_i64()
        .or_else(|| v.as_f64().filter(|f| f.is_finite()).map(|f| f as i64))
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn is_secret(kind: &str) -> bool {
    SECRET_KINDS.contains(&kind) || !FIELD_KINDS.contains(&kind)
}

fn read_fields(v: Option<&Value>) -> Vec<VaultField> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|f| {
                    let name = f.get("name")?.as_str()?;
                    let value = f.get("value")?.as_str()?;
                    let kind = f.get("kind").and_then(Value::as_str).unwrap_or("text");
                    Some(VaultField {
                        name: name.to_owned(),
                        kind: kind.to_owned(),
                        value: value.to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn read_history(v: Option<&Value>) -> Vec<VaultHistoryEntry> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|h| {
                    Some(VaultHistoryEntry {
                        field: h.get("field")?.as_str()?.to_owned(),
                        value: h.get("value")?.as_str()?.to_owned(),
                        changed_at: int(h.get("changed_at")).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Read an item's stored fields, tolerating values of the wrong shape (another client's): an
/// unknown type or field kind is kept, anything malformed is dropped or defaulted.
pub fn to_item(id: &str, f: &Map<String, Value>) -> VaultItem {
    let text = |k: &str| f.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    VaultItem {
        id: id.to_owned(),
        kind: f
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("login")
            .to_owned(),
        name: text("name"),
        fields: read_fields(f.get("fields")),
        urls: strings(f.get("urls")),
        notes: text("notes"),
        tags: strings(f.get("tags")),
        folder: f.get("folder").and_then(Value::as_str).map(str::to_owned),
        favorite: f.get("favorite").and_then(Value::as_bool).unwrap_or(false),
        history: read_history(f.get("history")),
        created_at: int(f.get("created_at")).unwrap_or(0),
        updated_at: int(f.get("updated_at")).unwrap_or(0),
        deleted_at: int(f.get("deleted_at")),
    }
}

/// The listing form of an item: no field values, notes or history.
pub fn summarize(item: &VaultItem) -> VaultItemSummary {
    VaultItemSummary {
        id: item.id.clone(),
        kind: item.kind.clone(),
        name: item.name.clone(),
        fields: item
            .fields
            .iter()
            .map(|f| VaultFieldSummary {
                name: f.name.clone(),
                kind: f.kind.clone(),
            })
            .collect(),
        urls: item.urls.clone(),
        tags: item.tags.clone(),
        folder: item.folder.clone(),
        favorite: item.favorite,
        created_at: item.created_at,
        updated_at: item.updated_at,
        deleted_at: item.deleted_at,
    }
}

/// The listing form of an item as the CLI prints it.
pub fn summary_view(view: &VaultItemView) -> VaultItemSummaryView {
    VaultItemSummaryView {
        item: summarize(&view.item),
        folder_name: view.folder_name.clone(),
    }
}

fn field_json(f: &VaultField) -> Value {
    json!({ "name": f.name, "kind": f.kind, "value": f.value })
}

fn history_json(h: &VaultHistoryEntry) -> Value {
    json!({ "field": h.field, "value": h.value, "changed_at": h.changed_at })
}

/// The first key of `input` (in sorted order) that `allowed` does not list.
fn check_keys(input: &Map<String, Value>, allowed: &[&str]) -> Result<()> {
    let mut keys: Vec<&String> = input.keys().collect();
    keys.sort();
    match keys.into_iter().find(|k| !allowed.contains(&k.as_str())) {
        Some(k) => Err(bad(format!("{k} is not a vault item field"))),
        None => Ok(()),
    }
}

fn check_type(v: &Value) -> Result<String> {
    match v.as_str() {
        Some(t) if ITEM_TYPES.contains(&t) => Ok(t.to_owned()),
        _ => Err(bad(format!(
            "type must be one of {}",
            ITEM_TYPES.join(", ")
        ))),
    }
}

fn check_name(v: &Value) -> Result<String> {
    let name = v
        .as_str()
        .ok_or_else(|| bad("name must be a string"))?
        .trim();
    if name.is_empty() {
        return Err(bad("a vault item needs a name"));
    }
    Ok(name.to_owned())
}

fn check_strings(key: &str, v: &Value) -> Result<Vec<String>> {
    let not = || bad(format!("{key} must be a list of strings"));
    v.as_array()
        .ok_or_else(not)?
        .iter()
        .map(|s| s.as_str().map(str::to_owned).ok_or_else(not))
        .collect()
}

/// URLs trimmed, without empty ones or exact repeats, in order.
pub fn clean_urls(urls: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for u in urls {
        let u = u.trim();
        if !u.is_empty() && !out.iter().any(|o| o == u) {
            out.push(u.to_owned());
        }
    }
    out
}

fn check_folder(v: &Value) -> Result<Option<String>> {
    match v {
        Value::Null => Ok(None),
        Value::String(s) if !s.trim().is_empty() => Ok(Some(s.trim().to_owned())),
        _ => Err(bad("folder must be a folder id or null")),
    }
}

fn check_favorite(v: &Value) -> Result<bool> {
    v.as_bool()
        .ok_or_else(|| bad("favorite must be true or false"))
}

/// A field as given: `(name, kind if given, value)`, its name trimmed and non-empty and its kind
/// one of [`FIELD_KINDS`].
fn given_field(key: &str, v: &Value) -> Result<(String, Option<String>, String)> {
    let shape = || {
        bad(format!(
            "{key} must be a list of {{name, kind, value}} objects with string values"
        ))
    };
    let obj = v.as_object().ok_or_else(shape)?;
    let name = obj.get("name").and_then(Value::as_str).ok_or_else(shape)?;
    let value = obj.get("value").and_then(Value::as_str).ok_or_else(shape)?;
    let kind = match obj.get("kind") {
        None | Some(Value::Null) => None,
        Some(Value::String(k)) => Some(k.clone()),
        Some(_) => return Err(shape()),
    };
    let name = name.trim();
    if name.is_empty() {
        return Err(bad("a field needs a name"));
    }
    if let Some(k) = &kind {
        if !FIELD_KINDS.contains(&k.as_str()) {
            return Err(bad(format!(
                "field kind must be one of {}",
                FIELD_KINDS.join(", ")
            )));
        }
    }
    Ok((name.to_owned(), kind, value.to_owned()))
}

/// A field value as its kind stores it: a TOTP seed upper-cased without whitespace or padding
/// (an `otpauth://` URI only trimmed); everything else exactly as given.
fn field_value(name: &str, kind: &str, value: &str) -> Result<String> {
    if kind != "totp" {
        return Ok(value.to_owned());
    }
    let t = value.trim();
    if t.get(..10)
        .is_some_and(|p| p.eq_ignore_ascii_case("otpauth://"))
    {
        return Ok(t.to_owned());
    }
    let seed: String = t
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_ascii_uppercase();
    let seed = seed.trim_end_matches('=');
    if seed.is_empty()
        || !seed
            .bytes()
            .all(|b| b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b))
    {
        return Err(bad(format!(
            "the totp field \"{name}\" needs an otpauth:// URI or a base32 secret"
        )));
    }
    Ok(seed.to_owned())
}

fn same_name(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

/// A whole field list as given (`fields`): each field checked, kind `text` when not given.
fn given_fields(v: &Value) -> Result<Vec<VaultField>> {
    let items = v.as_array().ok_or_else(|| {
        bad("fields must be a list of {name, kind, value} objects with string values")
    })?;
    let mut out: Vec<VaultField> = Vec::new();
    for item in items {
        let (name, kind, value) = given_field("fields", item)?;
        let kind = kind.unwrap_or_else(|| "text".into());
        let value = field_value(&name, &kind, &value)?;
        if out.iter().any(|f| same_name(&f.name, &name)) {
            return Err(bad(format!(
                "two fields are named \"{}\"",
                name.to_lowercase()
            )));
        }
        out.push(VaultField { name, kind, value });
    }
    Ok(out)
}

/// The stored fields of a new item from `input` (the keys of [`CREATE_KEYS`]) at `now`.
pub fn new_item_fields(input: &Value, now: i64) -> Result<Map<String, Value>> {
    let input = input
        .as_object()
        .ok_or_else(|| bad("a vault item is a JSON object"))?;
    check_keys(input, CREATE_KEYS)?;
    let kind = match input.get("type") {
        None => "login".to_owned(),
        Some(v) => check_type(v)?,
    };
    let name = check_name(input.get("name").unwrap_or(&Value::Null)).map_err(|e| {
        match input.get("name") {
            None => bad("a vault item needs a name"),
            Some(_) => e,
        }
    })?;
    let fields = match input.get("fields") {
        None => Vec::new(),
        Some(v) => given_fields(v)?,
    };
    let urls = match input.get("urls") {
        None => Vec::new(),
        Some(v) => clean_urls(&check_strings("urls", v)?),
    };
    let notes = match input.get("notes") {
        None => String::new(),
        Some(v) => v
            .as_str()
            .ok_or_else(|| bad("notes must be a string"))?
            .to_owned(),
    };
    let tags = match input.get("tags") {
        None => Vec::new(),
        Some(v) => clean_tags(&check_strings("tags", v)?),
    };
    let folder = match input.get("folder") {
        None => None,
        Some(v) => check_folder(v)?,
    };
    let favorite = match input.get("favorite") {
        None => false,
        Some(v) => check_favorite(v)?,
    };
    let mut out = Map::new();
    out.insert("type".into(), kind.into());
    out.insert("name".into(), name.into());
    out.insert(
        "fields".into(),
        Value::Array(fields.iter().map(field_json).collect()),
    );
    out.insert("urls".into(), urls.into());
    out.insert("notes".into(), notes.into());
    out.insert("tags".into(), tags.into());
    out.insert("folder".into(), folder.map_or(Value::Null, Value::from));
    out.insert("favorite".into(), favorite.into());
    out.insert("history".into(), Value::Array(Vec::new()));
    out.insert("created_at".into(), now.into());
    out.insert("updated_at".into(), now.into());
    Ok(out)
}

/// The field list after a patch's `set_fields` and `remove_fields` on `current`: removals first
/// (each must name a field), then each set replaces the value (and kind, when given) of the field
/// of that name, keeping its place and name, or appends a new field (`text` unless given).
fn patched_fields(
    current: &[VaultField],
    set: Option<&Value>,
    remove: Option<&Value>,
) -> Result<Vec<VaultField>> {
    let mut fields = current.to_vec();
    if let Some(remove) = remove {
        for name in check_strings("remove_fields", remove)? {
            let before = fields.len();
            fields.retain(|f| !same_name(&f.name, &name));
            if fields.len() == before {
                return Err(bad(format!("no field \"{}\" to remove", name.trim())));
            }
        }
    }
    if let Some(set) = set {
        let items = set.as_array().ok_or_else(|| {
            bad("set_fields must be a list of {name, kind, value} objects with string values")
        })?;
        for item in items {
            let (name, kind, value) = given_field("set_fields", item)?;
            match fields.iter_mut().find(|f| same_name(&f.name, &name)) {
                Some(f) => {
                    if let Some(k) = kind {
                        f.kind = k;
                    }
                    f.value = field_value(&f.name, &f.kind, &value)?;
                }
                None => {
                    let kind = kind.unwrap_or_else(|| "text".into());
                    let value = field_value(&name, &kind, &value)?;
                    fields.push(VaultField { name, kind, value });
                }
            }
        }
    }
    Ok(fields)
}

/// The history after `before` became `after`: every secret field of `before` whose value changed
/// or that went leaves its value, newest first, then the earlier entries, at most
/// [`HISTORY_PER_FIELD`] per field name.
fn next_history(
    history: &[VaultHistoryEntry],
    before: &[VaultField],
    after: &[VaultField],
    now: i64,
) -> Vec<VaultHistoryEntry> {
    let mut entries: Vec<VaultHistoryEntry> = before
        .iter()
        .filter(|old| is_secret(&old.kind))
        .filter(|old| {
            after
                .iter()
                .find(|f| same_name(&f.name, &old.name))
                .is_none_or(|f| f.value != old.value)
        })
        .map(|old| VaultHistoryEntry {
            field: old.name.clone(),
            value: old.value.clone(),
            changed_at: now,
        })
        .collect();
    entries.extend(history.iter().cloned());
    let mut counts: Vec<(String, usize)> = Vec::new();
    entries.retain(|e| {
        let key = e.field.trim().to_lowercase();
        match counts.iter_mut().find(|(k, _)| *k == key) {
            Some((_, n)) => {
                *n += 1;
                *n <= HISTORY_PER_FIELD
            }
            None => {
                counts.push((key, 1));
                true
            }
        }
    });
    entries
}

/// The fields a patch writes to the item stored as `current` at `now` (none when nothing
/// changes; `updated_at` with any change). `patch` takes the keys of [`PATCH_KEYS`]: `fields`
/// replaces the whole list, `set_fields` and `remove_fields` change it; `folder: null` clears.
pub fn item_changes(
    current: &Map<String, Value>,
    patch: &Value,
    now: i64,
) -> Result<Map<String, Value>> {
    let patch = patch
        .as_object()
        .ok_or_else(|| bad("a vault item change is a JSON object"))?;
    check_keys(patch, PATCH_KEYS)?;
    if patch.contains_key("fields")
        && (patch.contains_key("set_fields") || patch.contains_key("remove_fields"))
    {
        return Err(bad(
            "give fields (the whole list) or set_fields and remove_fields, not both",
        ));
    }
    let item = to_item("", current);
    let mut changes = Map::new();
    if let Some(v) = patch.get("type") {
        let t = check_type(v)?;
        if t != item.kind {
            changes.insert("type".into(), t.into());
        }
    }
    if let Some(v) = patch.get("name") {
        let n = check_name(v)?;
        if n != item.name {
            changes.insert("name".into(), n.into());
        }
    }
    let fields = match patch.get("fields") {
        Some(v) => Some(given_fields(v)?),
        None if patch.contains_key("set_fields") || patch.contains_key("remove_fields") => {
            Some(patched_fields(
                &item.fields,
                patch.get("set_fields"),
                patch.get("remove_fields"),
            )?)
        }
        None => None,
    };
    if let Some(fields) = fields {
        if let Some(dup) = fields.iter().enumerate().find_map(|(i, f)| {
            fields[..i]
                .iter()
                .any(|g| same_name(&g.name, &f.name))
                .then(|| f.name.trim().to_lowercase())
        }) {
            return Err(bad(format!("two fields are named \"{dup}\"")));
        }
        if fields != item.fields {
            let history = next_history(&item.history, &item.fields, &fields, now);
            changes.insert(
                "fields".into(),
                Value::Array(fields.iter().map(field_json).collect()),
            );
            if history != item.history {
                changes.insert(
                    "history".into(),
                    Value::Array(history.iter().map(history_json).collect()),
                );
            }
        }
    }
    if let Some(v) = patch.get("urls") {
        let urls = clean_urls(&check_strings("urls", v)?);
        if urls != item.urls {
            changes.insert("urls".into(), urls.into());
        }
    }
    if let Some(v) = patch.get("notes") {
        let notes = v.as_str().ok_or_else(|| bad("notes must be a string"))?;
        if notes != item.notes {
            changes.insert("notes".into(), notes.into());
        }
    }
    if let Some(v) = patch.get("tags") {
        let tags = clean_tags(&check_strings("tags", v)?);
        if tags != item.tags {
            changes.insert("tags".into(), tags.into());
        }
    }
    if let Some(v) = patch.get("folder") {
        let folder = check_folder(v)?;
        if folder != item.folder {
            changes.insert("folder".into(), folder.map_or(Value::Null, Value::from));
        }
    }
    if let Some(v) = patch.get("favorite") {
        let favorite = check_favorite(v)?;
        if favorite != item.favorite {
            changes.insert("favorite".into(), favorite.into());
        }
    }
    if !changes.is_empty() {
        changes.insert("updated_at".into(), now.into());
    }
    Ok(changes)
}

/// The id `reference` names among `items` (`(id, name, in the trash)`): an id, trashed or not, or
/// a name (case-insensitive, trimmed) of exactly one item outside the trash.
pub fn resolve_item(items: &[(String, String, bool)], reference: &str) -> Result<String> {
    let r = reference.trim();
    if let Some((id, _, _)) = items.iter().find(|(id, _, _)| id == r) {
        return Ok(id.clone());
    }
    let mut named: Vec<&String> = items
        .iter()
        .filter(|(_, name, trashed)| !trashed && same_name(name, r))
        .map(|(id, _, _)| id)
        .collect();
    named.sort();
    match named.as_slice() {
        [] => Err(Error::atlas(
            "unknown_vault_item",
            format!("no vault item \"{r}\""),
        )),
        [one] => Ok((*one).clone()),
        many => Err(Error::atlas(
            "ambiguous_vault_item",
            format!(
                "\"{r}\" names {} vault items ({}); use an id",
                many.len(),
                many.iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )),
    }
}

/// The value of the item's field named `name` (case-insensitive), exactly as stored.
pub fn item_field<'a>(item: &'a VaultItem, name: &str) -> Result<&'a str> {
    if let Some(f) = item.fields.iter().find(|f| same_name(&f.name, name)) {
        return Ok(&f.value);
    }
    let has = if item.fields.is_empty() {
        "it has none".to_owned()
    } else {
        format!(
            "it has: {}",
            item.fields
                .iter()
                .map(|f| f.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    Err(Error::atlas(
        "unknown_vault_field",
        format!(
            "vault item \"{}\" has no field \"{}\" ({has})",
            item.name,
            name.trim()
        ),
    ))
}

fn to_folder(id: &str, f: &Map<String, Value>) -> VaultFolder {
    VaultFolder {
        id: id.to_owned(),
        name: f
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        created_at: int(f.get("created_at")).unwrap_or(0),
        updated_at: int(f.get("updated_at")).unwrap_or(0),
        deleted_at: int(f.get("deleted_at")),
    }
}

impl AtlasClient {
    fn require_vault(&self) -> Result<()> {
        let app = &self.session().app;
        if app == VAULT_APP {
            return Ok(());
        }
        Err(Error::atlas(
            "wrong_app",
            format!(
                "vault items need a session of {}, this one is {}",
                app_name(VAULT_APP),
                app_name(app)
            ),
        ))
    }

    fn all_vault_items(&self) -> Vec<VaultItem> {
        self.session()
            .store
            .list(EntityKind::VaultItem)
            .iter()
            .map(|e| to_item(&e.id, &e.fields))
            .collect()
    }

    /// Folders outside the trash, by name.
    pub fn vault_folders(&self) -> Result<Vec<VaultFolder>> {
        self.require_vault()?;
        let mut out: Vec<VaultFolder> = self
            .session()
            .store
            .list(EntityKind::VaultFolder)
            .iter()
            .map(|e| to_folder(&e.id, &e.fields))
            .filter(|f| f.deleted_at.is_none())
            .collect();
        out.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then(a.id.cmp(&b.id))
        });
        Ok(out)
    }

    /// The folder `reference` names: an id, or a name (case-insensitive) of one folder.
    fn vault_folder_id(&self, reference: &str) -> Result<String> {
        let r = reference.trim();
        let folders = self.vault_folders()?;
        if let Some(f) = folders.iter().find(|f| f.id == r) {
            return Ok(f.id.clone());
        }
        let named: Vec<&VaultFolder> = folders.iter().filter(|f| same_name(&f.name, r)).collect();
        match named.as_slice() {
            [one] => Ok(one.id.clone()),
            [] => Err(Error::atlas(
                "unknown_vault_folder",
                format!("no vault folder \"{r}\""),
            )),
            many => Err(Error::atlas(
                "ambiguous_vault_folder",
                format!("\"{r}\" names {} vault folders; use an id", many.len()),
            )),
        }
    }

    fn folder_name(&self, id: Option<&str>) -> Option<String> {
        let f = self.session().store.get(EntityKind::VaultFolder, id?)?;
        f.get("name").and_then(Value::as_str).map(str::to_owned)
    }

    /// The id of the item `reference` names (an id, or a unique name outside the trash).
    pub fn vault_item_id(&self, reference: &str) -> Result<String> {
        self.require_vault()?;
        let items: Vec<(String, String, bool)> = self
            .all_vault_items()
            .into_iter()
            .map(|i| (i.id, i.name, i.deleted_at.is_some()))
            .collect();
        resolve_item(&items, reference)
    }

    fn raw_vault_item(&self, id: &str) -> Result<VaultItem> {
        self.require_vault()?;
        self.session()
            .store
            .get(EntityKind::VaultItem, id)
            .map(|f| to_item(id, &f))
            .ok_or_else(|| Error::atlas("unknown_vault_item", format!("no vault item \"{id}\"")))
    }

    fn vault_view(&self, item: VaultItem) -> VaultItemView {
        let folder_name = self.folder_name(item.folder.as_deref());
        VaultItemView { item, folder_name }
    }

    /// One item by id or name, secrets included.
    pub fn vault_item(&self, reference: &str) -> Result<VaultItemView> {
        let id = self.vault_item_id(reference)?;
        Ok(self.vault_view(self.raw_vault_item(&id)?))
    }

    /// One field's value of the item `reference` names, for scripts.
    pub fn vault_secret(&self, reference: &str, field: &str) -> Result<String> {
        let item = self.vault_item(reference)?.item;
        item_field(&item, field).map(str::to_owned)
    }

    /// Items outside the trash, filtered by `query`, without their secrets: by name.
    pub fn vault_items(&self, query: &VaultQuery) -> Result<Vec<VaultItemSummaryView>> {
        self.require_vault()?;
        let folder = query
            .folder
            .as_deref()
            .filter(|f| !f.is_empty())
            .map(|f| self.vault_folder_id(f))
            .transpose()?;
        if let Some(k) = query.kind.as_deref().filter(|k| !k.is_empty()) {
            check_type(&Value::from(k))?;
        }
        let kind = query.kind.as_deref().filter(|k| !k.is_empty());
        let tag = query
            .tag
            .as_deref()
            .filter(|t| !t.is_empty())
            .map(str::to_lowercase);
        let search = query
            .search
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(str::to_lowercase);
        let mut items: Vec<VaultItem> = self
            .all_vault_items()
            .into_iter()
            .filter(|i| i.deleted_at.is_none())
            .filter(|i| folder.is_none() || i.folder == folder)
            .filter(|i| kind.is_none_or(|k| i.kind == k))
            .filter(|i| {
                tag.as_ref()
                    .is_none_or(|t| i.tags.iter().any(|x| x.to_lowercase() == *t))
            })
            .filter(|i| {
                search.as_ref().is_none_or(|s| {
                    i.name.to_lowercase().contains(s)
                        || i.urls.iter().any(|u| u.to_lowercase().contains(s))
                        || i.tags.iter().any(|t| t.to_lowercase().contains(s))
                })
            })
            .collect();
        items.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then(a.id.cmp(&b.id))
        });
        Ok(items
            .iter()
            .map(|i| VaultItemSummaryView {
                item: summarize(i),
                folder_name: self.folder_name(i.folder.as_deref()),
            })
            .collect())
    }

    /// `input` with its `folder` (an id or name) resolved to the folder's id.
    fn with_folder_id(&self, input: &Value) -> Result<Value> {
        let mut input = input.clone();
        if let Some(Value::String(f)) = input.get("folder") {
            let id = self.vault_folder_id(f)?;
            input["folder"] = Value::String(id);
        }
        Ok(input)
    }

    fn write_vault_fields(
        &mut self,
        kind: EntityKind,
        id: &str,
        fields: Map<String, Value>,
    ) -> Result<()> {
        let store = &mut self.session_mut().store;
        for (field, value) in fields {
            store.set(kind, id, &field, value);
        }
        self.session_mut().push()
    }

    /// Create an item from `input` (see [`new_item_fields`]; `folder` may be a name) and push it.
    pub fn create_vault_item(&mut self, input: &Value) -> Result<VaultItemView> {
        self.require_vault()?;
        self.session().require_write()?;
        let fields = new_item_fields(&self.with_folder_id(input)?, self.now())?;
        let id = self.session_mut().store.new_entity_id();
        self.write_vault_fields(EntityKind::VaultItem, &id, fields)?;
        Ok(self.vault_view(self.raw_vault_item(&id)?))
    }

    /// Change the item `reference` names by `patch` (see [`item_changes`]) and push.
    pub fn update_vault_item(&mut self, reference: &str, patch: &Value) -> Result<VaultItemView> {
        let id = self.vault_item_id(reference)?;
        self.session().require_write()?;
        let current = self
            .session()
            .store
            .get(EntityKind::VaultItem, &id)
            .unwrap_or_default();
        let changes = item_changes(&current, &self.with_folder_id(patch)?, self.now())?;
        if !changes.is_empty() {
            self.write_vault_fields(EntityKind::VaultItem, &id, changes)?;
        }
        Ok(self.vault_view(self.raw_vault_item(&id)?))
    }

    /// Move the item `reference` names to the trash (`deleted_at`); a no-op when it already is.
    /// Returns its id.
    pub fn delete_vault_item(&mut self, reference: &str) -> Result<String> {
        let id = self.vault_item_id(reference)?;
        let item = self.raw_vault_item(&id)?;
        if item.deleted_at.is_some() {
            return Ok(id);
        }
        self.session().require_write()?;
        let now = self.now();
        let mut fields = Map::new();
        fields.insert("deleted_at".into(), now.into());
        fields.insert("updated_at".into(), now.into());
        self.write_vault_fields(EntityKind::VaultItem, &id, fields)?;
        Ok(id)
    }

    /// Create a folder and push it.
    pub fn create_vault_folder(&mut self, name: &str) -> Result<VaultFolder> {
        self.require_vault()?;
        self.session().require_write()?;
        let name = name.trim();
        if name.is_empty() {
            return Err(bad("a vault folder needs a name"));
        }
        if self
            .vault_folders()?
            .iter()
            .any(|f| same_name(&f.name, name))
        {
            return Err(Error::atlas(
                "vault_folder_exists",
                format!("there is already a vault folder \"{name}\""),
            ));
        }
        let now = self.now();
        let id = self.session_mut().store.new_entity_id();
        let mut fields = Map::new();
        fields.insert("name".into(), name.into());
        fields.insert("created_at".into(), now.into());
        fields.insert("updated_at".into(), now.into());
        self.write_vault_fields(EntityKind::VaultFolder, &id, fields)?;
        let stored = self
            .session()
            .store
            .get(EntityKind::VaultFolder, &id)
            .unwrap_or_default();
        Ok(to_folder(&id, &stored))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        let path = format!(
            "{}/../../test-vectors/vault_item_vectors.json",
            env!("CARGO_MANIFEST_DIR")
        );
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn error_json(e: &Error) -> Value {
        match e {
            Error::Atlas { code, message } => json!({ "code": code, "message": message }),
            other => panic!("not a rule error: {other:?}"),
        }
    }

    fn object(v: &Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn create_vectors() {
        let f = fixture();
        let now = f["now"].as_i64().unwrap();
        for c in f["create"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            match new_item_fields(&c["input"], now) {
                Ok(fields) => assert_eq!(Value::Object(fields), c["fields"], "{name}"),
                Err(e) => assert_eq!(error_json(&e), c["error"], "{name}"),
            }
        }
    }

    #[test]
    fn update_vectors() {
        let f = fixture();
        let now = f["now"].as_i64().unwrap();
        for c in f["update"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            match item_changes(&object(&c["item"]), &c["patch"], now) {
                Ok(changes) => assert_eq!(Value::Object(changes), c["changes"], "{name}"),
                Err(e) => assert_eq!(error_json(&e), c["error"], "{name}"),
            }
        }
    }

    #[test]
    fn read_vectors() {
        for c in fixture()["read"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let item = to_item("x", &object(&c["fields"]));
            let mut got = serde_json::to_value(&item).unwrap();
            got.as_object_mut().unwrap().remove("id");
            assert_eq!(got, c["item"], "{name}");
            let mut summary = serde_json::to_value(summarize(&item)).unwrap();
            summary.as_object_mut().unwrap().remove("id");
            assert_eq!(summary, c["summary"], "{name}");
        }
    }

    #[test]
    fn resolve_and_field_vectors() {
        let f = fixture();
        for c in f["resolve"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let items: Vec<(String, String, bool)> = c["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|i| {
                    (
                        i["id"].as_str().unwrap().to_owned(),
                        i["name"].as_str().unwrap().to_owned(),
                        !i["deleted_at"].is_null(),
                    )
                })
                .collect();
            match resolve_item(&items, c["ref"].as_str().unwrap()) {
                Ok(id) => assert_eq!(json!(id), c["id"], "{name}"),
                Err(e) => assert_eq!(error_json(&e), c["error"], "{name}"),
            }
        }
        for c in f["field"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let item = to_item("x", &object(&c["item"]));
            match item_field(&item, c["field"].as_str().unwrap()) {
                Ok(v) => assert_eq!(json!(v), c["value"], "{name}"),
                Err(e) => assert_eq!(error_json(&e), c["error"], "{name}"),
            }
        }
    }
}
