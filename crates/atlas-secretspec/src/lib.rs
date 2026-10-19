//! `secretspec-provider-atlas`: an external [SecretSpec](https://secretspec.dev) provider (the
//! Secret Provider Protocol, version 1, SecretSpec 0.21+) that resolves secrets from Atlas Vault.
//!
//! SecretSpec launches the binary as `secretspec-provider-atlas provider` with private stdio pipes
//! for every provider URI with the `atlas` scheme, once it is registered
//! (`secretspec-provider-atlas register`). The endpoint signs in with an Atlas Vault API token
//! (`ATLAS_TOKEN`, or the credential `token` SecretSpec brokers), syncs the vault into memory and
//! answers reads and writes:
//!
//! - A convention address `{project, profile, key}` is the field `key` of the item named `profile`
//!   in the folder named `project`: folder `payments`, item `production`, field `DATABASE_URL`.
//! - A native address (`ref = { item = "Deploy key", field = "token" }`) names an item by name or
//!   id anywhere in the vault, or in the folder `vault` when given; `field` is required.
//! - `secretspec set` stores the value as a `hidden` field, creating the folder and the item (an
//!   `api_key` item tagged `secretspec`) when they are missing. It needs a token made with writes;
//!   a read-only token, the vault's default, is refused with `permission_denied`.
//!
//! See `docs/integrations.md` (SecretSpec).

pub mod endpoint;
pub mod register;

use atlas_client::client::AtlasClient;
use atlas_client::error::Error;
use atlas_client::session::ConnectOptions;
use atlas_client::vault::{VaultItem, VaultQuery, VAULT_APP};
use secretspec_ipc::protocol::provider::{Address, Coordinates};
use secretspec_ipc::ErrorKind;
use serde_json::json;
use std::path::PathBuf;

/// The provider URI scheme.
pub const SCHEME: &str = "atlas";
/// The type of the items `secretspec set` creates.
pub const ITEM_TYPE: &str = "api_key";
/// The tag on the items `secretspec set` creates.
pub const ITEM_TAG: &str = "secretspec";
/// The kind of the fields `secretspec set` creates.
pub const FIELD_KIND: &str = "hidden";
/// The environment the endpoint reads, which its registration passes through.
pub const ENVIRONMENT: &[&str] = &["ATLAS_URL", "ATLAS_TOKEN", "ATLAS_STATE_DIR"];

/// Why an operation failed: the protocol's error kind (all SecretSpec shows) and, for the
/// `status` command and tests, a stable code and a message. Only the kind crosses the pipe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fault {
    pub kind: ErrorKind,
    pub code: String,
    pub message: String,
}

impl Fault {
    pub fn new(kind: ErrorKind, code: &str, message: impl Into<String>) -> Self {
        Self {
            kind,
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for Fault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

fn invalid(message: impl Into<String>) -> Fault {
    Fault::new(ErrorKind::InvalidParams, "bad_address", message)
}

/// The server a provider URI names: `atlas://host[:port][/path]` is `https://host…` (`http://`
/// for a loopback host), and `atlas://` (or `atlas:`) is `ATLAS_URL`. The URI may carry no
/// credential, query or fragment.
pub fn server_url(uri: &str, scheme: &str, env_url: Option<&str>) -> Result<String, Fault> {
    let bad = |m: &str| Fault::new(ErrorKind::InvalidParams, "bad_uri", m);
    let rest = uri
        .strip_prefix(scheme)
        .and_then(|r| r.strip_prefix(':'))
        .ok_or_else(|| bad("the provider URI does not have the provider's scheme"))?;
    if rest.contains(['?', '#']) {
        return Err(bad("the provider URI takes no query or fragment"));
    }
    let rest = rest.strip_prefix("//").unwrap_or(rest);
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if authority.contains('@') {
        return Err(bad(
            "the provider URI may not carry a credential: set ATLAS_TOKEN",
        ));
    }
    if authority.is_empty() {
        if !path.trim_matches('/').is_empty() {
            return Err(bad("the provider URI has a path but no server"));
        }
        let url = env_url
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .ok_or_else(|| bad("the provider URI names no server and ATLAS_URL is not set"))?;
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err(bad("ATLAS_URL must start with https:// or http://"));
        }
        return Ok(url.trim_end_matches('/').to_owned());
    }
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => authority.split(':').next().unwrap_or(""),
    };
    let loopback =
        matches!(host, "localhost" | "127.0.0.1" | "::1") || host.ends_with(".localhost");
    let protocol = if loopback { "http" } else { "https" };
    Ok(format!(
        "{protocol}://{authority}{}",
        path.trim_end_matches('/')
    ))
}

/// The credential-free identity of a server for SecretSpec: `atlas://host[:port][/path]`.
pub fn display_uri(server_url: &str) -> String {
    let rest = server_url
        .split_once("://")
        .map_or(server_url, |(_, rest)| rest);
    format!("{SCHEME}://{rest}")
}

/// Where a secret lives in the vault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// The folder's name; `None` looks the item up across the vault.
    pub folder: Option<String>,
    /// The item's name (or, without a folder, its id).
    pub item: String,
    /// The field's name.
    pub field: String,
}

impl Target {
    pub fn coordinates(&self) -> Coordinates {
        Coordinates {
            item: self.item.clone(),
            field: Some(self.field.clone()),
            vault: self.folder.clone(),
            section: None,
            version: None,
        }
    }

    pub fn describe(&self) -> String {
        match &self.folder {
            Some(folder) => format!(
                "Atlas Vault folder \"{folder}\", item \"{}\", field \"{}\"",
                self.item, self.field
            ),
            None => format!(
                "Atlas Vault item \"{}\", field \"{}\"",
                self.item, self.field
            ),
        }
    }
}

fn component(value: &str, what: &str) -> Result<String, Fault> {
    let value = value.trim();
    if value.is_empty() {
        return Err(invalid(format!("the {what} is empty")));
    }
    Ok(value.to_owned())
}

/// The vault location of a SecretSpec address: a convention address `{project, profile, key}`
/// is folder `project`, item `profile`, field `key`; a native one `{vault?, item, field}` is
/// folder `vault` (or the whole vault), item `item`, field `field`.
pub fn target(address: &Address) -> Result<Target, Fault> {
    match address {
        Address::Convention {
            project,
            profile,
            key,
        } => Ok(Target {
            folder: Some(component(project, "project")?),
            item: component(profile, "profile")?,
            field: component(key, "secret name")?,
        }),
        Address::Native { coordinates } => {
            if coordinates.section.is_some() || coordinates.version.is_some() {
                return Err(invalid("Atlas Vault has no sections or versions"));
            }
            let field = coordinates
                .field
                .as_deref()
                .ok_or_else(|| invalid("an Atlas Vault ref needs a field"))?;
            Ok(Target {
                folder: coordinates
                    .vault
                    .as_deref()
                    .map(|v| component(v, "folder"))
                    .transpose()?,
                item: component(&coordinates.item, "item")?,
                field: component(field, "field")?,
            })
        }
    }
}

/// A client error as a [`Fault`].
pub fn fault(err: &Error) -> Fault {
    let message = err.to_string();
    match err {
        Error::Atlas { code, .. } => {
            let kind = match code.as_str() {
                "api_token_read_only" | "app_not_in_token" | "wrong_app" => {
                    ErrorKind::PermissionDenied
                }
                c if c.starts_with("ambiguous_") || c == "vault_folder_exists" => {
                    ErrorKind::Conflict
                }
                "bad_input" => ErrorKind::InvalidParams,
                _ => ErrorKind::OperationFailed,
            };
            Fault::new(kind, code, message)
        }
        Error::InvalidApiToken(_) => Fault::new(
            ErrorKind::InteractionRequired,
            "invalid_token",
            "ATLAS_TOKEN is not an Atlas API token",
        ),
        Error::Api { status, .. } => {
            let status = *status;
            let code = err.api_code().map(str::to_owned).unwrap_or_else(|| {
                match status {
                    401 => "unauthorized",
                    429 => "rate_limited",
                    _ => "server_error",
                }
                .to_owned()
            });
            let (kind, message) = match status {
                401 if code == "api_token_expired" => (
                    ErrorKind::InteractionRequired,
                    "the API token has expired: make a new one".to_owned(),
                ),
                401 => (
                    ErrorKind::InteractionRequired,
                    format!("{message} (revoked or wrong token?)"),
                ),
                403 if code == "api_token_read_only" => (
                    ErrorKind::PermissionDenied,
                    "the API token is read-only: storing a secret needs a token made with write access"
                        .to_owned(),
                ),
                403 => (ErrorKind::PermissionDenied, message),
                429 | 500..=599 => (ErrorKind::Unavailable, message),
                _ => (ErrorKind::OperationFailed, message),
            };
            Fault::new(kind, &code, message)
        }
        Error::Network(_) => Fault::new(ErrorKind::Unavailable, "network", message),
        Error::UpgradeRequired { .. } => {
            Fault::new(ErrorKind::OperationFailed, "upgrade_required", message)
        }
        _ => Fault::new(ErrorKind::OperationFailed, "error", message),
    }
}

/// What the endpoint reads from its environment.
#[derive(Clone, Default)]
pub struct Settings {
    /// `ATLAS_URL`: the server for an `atlas://` URI without a host.
    pub url: Option<String>,
    /// `ATLAS_TOKEN`: the vault API token.
    pub token: Option<String>,
    /// `ATLAS_STATE_DIR`: where the synced vault is cached between runs, as the CLI does.
    pub state_dir: Option<PathBuf>,
}

impl std::fmt::Debug for Settings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Settings")
            .field("url", &self.url)
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .field("state_dir", &self.state_dir)
            .finish()
    }
}

impl Settings {
    /// From `ATLAS_URL`, `ATLAS_TOKEN` and `ATLAS_STATE_DIR`, ignoring empty values.
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Self {
        let get = |k: &str| get(k).filter(|v| !v.trim().is_empty());
        Self {
            url: get("ATLAS_URL"),
            token: get("ATLAS_TOKEN").map(|t| t.trim().to_owned()),
            state_dir: get("ATLAS_STATE_DIR").map(PathBuf::from),
        }
    }
}

/// Sign in to Atlas Vault on `server_url` with `token`.
pub fn connect(
    server_url: &str,
    token: &str,
    state_dir: Option<PathBuf>,
) -> Result<AtlasClient, Fault> {
    let mut opts = ConnectOptions::new(server_url, token);
    opts.app = VAULT_APP.to_owned();
    opts.state_dir = state_dir;
    let client = AtlasClient::connect(opts).map_err(|e| fault(&e))?;
    let _ = client.session().save_state();
    Ok(client)
}

fn same_name(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

fn folder_id(client: &AtlasClient, name: &str) -> Result<Option<String>, Fault> {
    let folders = client.vault_folders().map_err(|e| fault(&e))?;
    let named: Vec<_> = folders
        .iter()
        .filter(|f| same_name(&f.name, name))
        .collect();
    match named.as_slice() {
        [] => Ok(None),
        [one] => Ok(Some(one.id.clone())),
        _ => Err(Fault::new(
            ErrorKind::Conflict,
            "ambiguous_vault_folder",
            format!("\"{name}\" names {} vault folders", named.len()),
        )),
    }
}

/// The item a target names, outside the trash.
fn find_item(client: &AtlasClient, target: &Target) -> Result<Option<VaultItem>, Fault> {
    let id = match &target.folder {
        Some(folder) => {
            let Some(folder) = folder_id(client, folder)? else {
                return Ok(None);
            };
            let query = VaultQuery {
                folder: Some(folder),
                ..VaultQuery::default()
            };
            let items = client.vault_items(&query).map_err(|e| fault(&e))?;
            let named: Vec<_> = items
                .iter()
                .filter(|i| same_name(&i.item.name, &target.item))
                .collect();
            match named.as_slice() {
                [] => return Ok(None),
                [one] => one.item.id.clone(),
                _ => {
                    return Err(Fault::new(
                        ErrorKind::Conflict,
                        "ambiguous_vault_item",
                        format!(
                            "\"{}\" names {} vault items in the folder",
                            target.item,
                            named.len()
                        ),
                    ))
                }
            }
        }
        None => match client.vault_item_id(&target.item) {
            Ok(id) => id,
            Err(Error::Atlas { code, .. }) if code == "unknown_vault_item" => return Ok(None),
            Err(e) => return Err(fault(&e)),
        },
    };
    let item = client.vault_item(&id).map_err(|e| fault(&e))?.item;
    Ok(item.deleted_at.is_none().then_some(item))
}

/// The secret at `target`, `None` when the folder, item or field is not there.
pub fn read(client: &AtlasClient, target: &Target) -> Result<Option<String>, Fault> {
    Ok(find_item(client, target)?.and_then(|item| {
        item.fields
            .into_iter()
            .find(|f| same_name(&f.name, &target.field))
            .map(|f| f.value)
    }))
}

/// Fail with `permission_denied` unless the token may write.
pub fn require_write(client: &AtlasClient) -> Result<(), Fault> {
    client.session().require_write().map_err(|e| fault(&e))
}

/// Store `value` at `target`: replace the field's value (keeping its kind), or add it as a
/// `hidden` field, creating the folder and the item when they are missing.
pub fn write(client: &mut AtlasClient, target: &Target, value: &str) -> Result<(), Fault> {
    require_write(client)?;
    match find_item(client, target)? {
        Some(item) => {
            let mut field = json!({ "name": target.field, "value": value });
            if !item
                .fields
                .iter()
                .any(|f| same_name(&f.name, &target.field))
            {
                field["kind"] = FIELD_KIND.into();
            }
            client
                .update_vault_item(&item.id, &json!({ "set_fields": [field] }))
                .map_err(|e| fault(&e))?;
        }
        None => {
            let folder = match &target.folder {
                Some(name) => Some(match folder_id(client, name)? {
                    Some(id) => id,
                    None => client.create_vault_folder(name).map_err(|e| fault(&e))?.id,
                }),
                None => None,
            };
            client
                .create_vault_item(&json!({
                    "type": ITEM_TYPE,
                    "name": target.item,
                    "folder": folder,
                    "tags": [ITEM_TAG],
                    "fields": [{ "name": target.field, "kind": FIELD_KIND, "value": value }],
                }))
                .map_err(|e| fault(&e))?;
        }
    }
    let _ = client.session().save_state();
    Ok(())
}

/// Remove the field at `target` (its value goes to the item's history; the item stays).
/// Returns whether there was one.
pub fn remove(client: &mut AtlasClient, target: &Target) -> Result<bool, Fault> {
    require_write(client)?;
    let Some(item) = find_item(client, target)? else {
        return Ok(false);
    };
    if !item
        .fields
        .iter()
        .any(|f| same_name(&f.name, &target.field))
    {
        return Ok(false);
    }
    client
        .update_vault_item(&item.id, &json!({ "remove_fields": [target.field] }))
        .map_err(|e| fault(&e))?;
    let _ = client.session().save_state();
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_uri_names_its_server() {
        let url = |uri: &str, env: Option<&str>| server_url(uri, "atlas", env);
        assert_eq!(
            url("atlas://app.atlastodo.dev", None).unwrap(),
            "https://app.atlastodo.dev"
        );
        assert_eq!(
            url("atlas://example.com:8443/atlas/", None).unwrap(),
            "https://example.com:8443/atlas"
        );
        assert_eq!(
            url("atlas://localhost:8080", None).unwrap(),
            "http://localhost:8080"
        );
        assert_eq!(
            url("atlas://127.0.0.1:8080", None).unwrap(),
            "http://127.0.0.1:8080"
        );
        assert_eq!(url("atlas://[::1]:80", None).unwrap(), "http://[::1]:80");
        for bare in ["atlas://", "atlas:", "atlas:///"] {
            assert_eq!(
                url(bare, Some("https://todo.example.com/")).unwrap(),
                "https://todo.example.com"
            );
        }
        for (uri, env) in [
            ("atlas://", None),
            ("atlas://", Some("todo.example.com")),
            ("atlas://user:pw@example.com", None),
            ("atlas://example.com?token=x", None),
            ("other://example.com", None),
            ("atlas:///path", Some("https://x")),
        ] {
            let err = url(uri, env).unwrap_err();
            assert_eq!(err.kind, ErrorKind::InvalidParams, "{uri}");
        }
        assert_eq!(display_uri("https://x.dev:1/a"), "atlas://x.dev:1/a");
    }

    #[test]
    fn addresses_map_to_folders_items_and_fields() {
        let convention = Address::Convention {
            project: "payments".into(),
            profile: "production".into(),
            key: "DATABASE_URL".into(),
        };
        let t = target(&convention).unwrap();
        assert_eq!(
            t,
            Target {
                folder: Some("payments".into()),
                item: "production".into(),
                field: "DATABASE_URL".into(),
            }
        );
        let c = t.coordinates();
        assert_eq!(
            (c.item.as_str(), c.field.as_deref(), c.vault.as_deref()),
            ("production", Some("DATABASE_URL"), Some("payments"))
        );
        // The native form of the same place maps to the same target.
        let native = |item: &str, field: Option<&str>, vault: Option<&str>| Address::Native {
            coordinates: Coordinates {
                item: item.into(),
                field: field.map(Into::into),
                vault: vault.map(Into::into),
                section: None,
                version: None,
            },
        };
        assert_eq!(
            target(&native(
                "production",
                Some("DATABASE_URL"),
                Some("payments")
            ))
            .unwrap(),
            t
        );
        let anywhere = target(&native("Deploy key", Some("token"), None)).unwrap();
        assert_eq!(anywhere.folder, None);
        assert_eq!(
            anywhere.describe(),
            "Atlas Vault item \"Deploy key\", field \"token\""
        );
        for bad in [
            native("Deploy key", None, None),
            native(" ", Some("token"), None),
            native("x", Some("token"), Some("")),
            Address::Convention {
                project: "".into(),
                profile: "default".into(),
                key: "K".into(),
            },
        ] {
            assert_eq!(target(&bad).unwrap_err().kind, ErrorKind::InvalidParams);
        }
    }

    #[test]
    fn client_errors_map_to_protocol_kinds() {
        let api = |status: u16, code: Option<&str>| Error::Api {
            status,
            message: "x".into(),
            data: code.map(|c| json!({ "code": c })),
            retry_after_ms: None,
        };
        let kind = |e: Error| fault(&e).kind;
        assert_eq!(
            kind(api(401, Some("api_token_expired"))),
            ErrorKind::InteractionRequired
        );
        assert_eq!(
            fault(&api(401, Some("api_token_expired"))).code,
            "api_token_expired"
        );
        assert_eq!(kind(api(401, None)), ErrorKind::InteractionRequired);
        assert_eq!(
            kind(api(403, Some("api_token_read_only"))),
            ErrorKind::PermissionDenied
        );
        assert_eq!(kind(api(429, None)), ErrorKind::Unavailable);
        assert_eq!(kind(api(503, None)), ErrorKind::Unavailable);
        assert_eq!(kind(api(400, None)), ErrorKind::OperationFailed);
        assert_eq!(
            kind(Error::atlas("api_token_read_only", "x")),
            ErrorKind::PermissionDenied
        );
        assert_eq!(
            kind(Error::atlas("ambiguous_vault_item", "x")),
            ErrorKind::Conflict
        );
        assert_eq!(
            kind(Error::atlas("server_incompatible", "x")),
            ErrorKind::OperationFailed
        );
        assert_eq!(kind(Error::Network("down".into())), ErrorKind::Unavailable);
    }

    #[test]
    fn settings_ignore_empty_values_and_hide_the_token() {
        let s = Settings::from_env(|k| match k {
            "ATLAS_URL" => Some("".into()),
            "ATLAS_TOKEN" => Some(" atlas_pat_x \n".into()),
            _ => None,
        });
        assert_eq!(s.url, None);
        assert_eq!(s.token.as_deref(), Some("atlas_pat_x"));
        assert!(!format!("{s:?}").contains("atlas_pat_x"));
    }
}
