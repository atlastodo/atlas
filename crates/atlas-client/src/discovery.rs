//! `GET /discovery` and the compatibility check (`discovery.ts`). A server that predates the
//! endpoint counts as [`LEGACY_DISCOVERY`]: sync protocol 1, no capabilities, todo only.

use std::sync::LazyLock;

use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryApp {
    pub id: String,
    pub name: String,
    pub version: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerDiscovery {
    pub legacy: bool,
    pub version: Option<String>,
    pub protocol_version: i64,
    pub min_protocol_version: Option<i64>,
    pub capabilities: Vec<String>,
    pub apps: Vec<DiscoveryApp>,
}

pub static LEGACY_DISCOVERY: LazyLock<ServerDiscovery> = LazyLock::new(|| ServerDiscovery {
    legacy: true,
    version: None,
    protocol_version: 1,
    min_protocol_version: None,
    capabilities: Vec::new(),
    apps: vec![DiscoveryApp {
        id: "todo".into(),
        name: "Atlas Todo".into(),
        version: 1,
    }],
});

fn int(v: Option<&Value>) -> Option<i64> {
    let v = v?;
    v.as_i64()
        .or_else(|| v.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
}

/// Read a `/discovery` body; anything that is not one is a legacy server.
pub fn parse_discovery(body: &Value) -> ServerDiscovery {
    let Some(d) = body.as_object() else {
        return LEGACY_DISCOVERY.clone();
    };
    let Some(protocol_version) = int(d.get("protocol_version")).filter(|p| *p >= 1) else {
        return LEGACY_DISCOVERY.clone();
    };
    let capabilities = d
        .get("capabilities")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let apps = d
        .get("apps")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|app| {
                    let id = app.get("id")?.as_str()?.to_owned();
                    let version = int(app.get("version"))?;
                    let name = app
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or(&id)
                        .to_owned();
                    Some(DiscoveryApp { id, name, version })
                })
                .collect()
        })
        .unwrap_or_default();
    ServerDiscovery {
        legacy: false,
        version: d.get("version").and_then(Value::as_str).map(str::to_owned),
        protocol_version,
        min_protocol_version: int(d.get("min_protocol_version")),
        capabilities,
        apps,
    }
}

/// What a client needs from a server.
#[derive(Debug, Clone, Default)]
pub struct ServerRequirements<'a> {
    pub min_protocol: Option<i64>,
    pub capabilities: &'a [&'a str],
    pub apps: &'a [&'a str],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerIncompatibility {
    Protocol { required: i64, actual: i64 },
    Capabilities { missing: Vec<String> },
    Apps { missing: Vec<String> },
}

/// Why `discovery` does not meet `required`, or `None`.
pub fn server_incompatibility(
    d: &ServerDiscovery,
    required: &ServerRequirements<'_>,
) -> Option<ServerIncompatibility> {
    let min = required.min_protocol.unwrap_or(1);
    if d.protocol_version < min {
        return Some(ServerIncompatibility::Protocol {
            required: min,
            actual: d.protocol_version,
        });
    }
    let missing: Vec<String> = required
        .capabilities
        .iter()
        .filter(|c| !d.capabilities.iter().any(|x| x == *c))
        .map(|c| c.to_string())
        .collect();
    if !missing.is_empty() {
        return Some(ServerIncompatibility::Capabilities { missing });
    }
    let missing: Vec<String> = required
        .apps
        .iter()
        .filter(|a| !d.apps.iter().any(|x| x.id == **a))
        .map(|a| a.to_string())
        .collect();
    if !missing.is_empty() {
        return Some(ServerIncompatibility::Apps { missing });
    }
    None
}

/// The message `ServerIncompatibleError` carries.
pub fn describe_incompatibility(i: &ServerIncompatibility, d: &ServerDiscovery) -> String {
    let server = match &d.version {
        Some(v) => format!("Atlas server {v}"),
        None => "This Atlas server".into(),
    };
    match i {
        ServerIncompatibility::Protocol { required, actual } => format!(
            "{server} speaks sync protocol {actual}, but this app needs {required} or newer. Update your server."
        ),
        ServerIncompatibility::Capabilities { missing } => {
            format!("{server} lacks {}, which this app needs. Update your server.", missing.join(", "))
        }
        ServerIncompatibility::Apps { missing } => {
            format!("{server} does not offer {}. Ask its operator to enable it.", missing.join(", "))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_a_discovery_body_and_checks_it() {
        let d = parse_discovery(&json!({
            "service": "atlas-server", "version": "0.1.11", "protocol_version": 6,
            "min_protocol_version": 6, "capabilities": ["api_tokens", 3],
            "apps": [{"id": "todo", "name": "Atlas Todo", "version": 1}, {"id": "x"}]
        }));
        assert!(!d.legacy);
        assert_eq!(d.capabilities, vec!["api_tokens"]);
        assert_eq!(d.apps.len(), 1);
        let ok = ServerRequirements {
            min_protocol: Some(6),
            capabilities: &["api_tokens"],
            apps: &["todo"],
        };
        assert_eq!(server_incompatibility(&d, &ok), None);
        let notes = ServerRequirements {
            apps: &["notes"],
            ..ok.clone()
        };
        let problem = server_incompatibility(&d, &notes).unwrap();
        assert_eq!(
            describe_incompatibility(&problem, &d),
            "Atlas server 0.1.11 does not offer notes. Ask its operator to enable it."
        );
        let legacy = parse_discovery(&json!("<html>"));
        assert!(legacy.legacy);
        assert!(matches!(
            server_incompatibility(&legacy, &ok),
            Some(ServerIncompatibility::Protocol {
                required: 6,
                actual: 1
            })
        ));
    }
}
