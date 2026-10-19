//! `test-vectors/cli_golden.json`: runs recorded from the TypeScript CLI before its retirement,
//! reproduced byte for byte by this CLI against the same fake server, and the Atlas Journal and
//! Atlas Vault runs recorded from this CLI since.

use std::collections::HashMap;

use atlas_cli::{run, Io, ReadStdin};
use atlas_client::client::AtlasClient;
use atlas_client::session::{ConnectOptions, Session};
use atlas_client::store::Store;
use atlas_client::testing::{current_discovery, FakeServer};
use atlas_core::EntityKind;
use serde_json::Value;
use uuid::Uuid;

fn is_uuid_at(b: &[u8], i: usize) -> bool {
    if i + 36 > b.len() {
        return false;
    }
    b[i..i + 36].iter().enumerate().all(|(k, c)| match k {
        8 | 13 | 18 | 23 => *c == b'-',
        _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
    })
}

/// Every UUID as `<id:N>`, numbered by first appearance.
fn normalize(text: &str, ids: &mut HashMap<String, String>) -> String {
    let b = text.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        if is_uuid_at(b, i) {
            let id = &text[i..i + 36];
            let n = ids.len() + 1;
            let name = ids
                .entry(id.to_owned())
                .or_insert_with(|| format!("<id:{n}>"));
            out.push_str(name);
            i += 36;
        } else {
            let ch = text[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

fn kind(name: &str) -> EntityKind {
    EntityKind::from_wire(name).expect("an entity kind")
}

#[test]
fn reproduces_the_recorded_runs() {
    let path = format!(
        "{}/../../test-vectors/cli_golden.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let update = std::env::var("GOLDEN_UPDATE").as_deref() == Ok("1");
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let mut recorded = golden.clone();
    let now = golden["now"].as_i64().unwrap();
    let fixed_store =
        move |node: Uuid| Store::with(node, Box::new(move || now as u64), Box::new(Uuid::new_v4));
    for (si, scenario) in golden["scenarios"].as_array().unwrap().iter().enumerate() {
        let name = scenario["name"].as_str().unwrap();
        let tz = scenario["tz"].as_str().unwrap();
        // `token_apps`: the token's apps (todo when absent), on a current server offering
        // `server_apps` (todo and journal when absent). `token_write: false` makes the token
        // read-only, `token_expires_at` gives its expiry.
        let server = match scenario.get("token_apps").and_then(Value::as_array) {
            None => FakeServer::new(),
            Some(apps) => {
                let apps: Vec<&str> = apps.iter().map(|a| a.as_str().unwrap()).collect();
                let server = FakeServer::with_apps(&apps);
                let offered: Vec<&str> = match scenario.get("server_apps") {
                    Some(v) => v
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|a| a.as_str().unwrap())
                        .collect(),
                    None => vec!["todo", "journal"],
                };
                server.state.lock().unwrap().discovery = Some(current_discovery(&offered));
                server
            }
        };
        let token_write = scenario.get("token_write").and_then(Value::as_bool);
        let token_expires_at = scenario.get("token_expires_at").and_then(Value::as_i64);
        let mut refs: HashMap<String, String> = HashMap::new();
        let mut ids = HashMap::new();
        for (ti, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            // Seeds write as the app would; the CLI's steps run with the scenario's token.
            {
                let mut st = server.state.lock().unwrap();
                st.write = step.get("seed").is_some() || token_write.unwrap_or(true);
                st.expires_at = token_expires_at;
            }
            if step.get("expire").is_some() {
                server.state.lock().unwrap().token_expired = true;
                continue;
            }
            if let Some(seed) = step.get("seed") {
                let mut opts = ConnectOptions::new("http://atlas.test", &server.token_string());
                opts.transport = Some(server.transport());
                opts.store = Some(Box::new(fixed_store));
                // The seed is written by a session of its kind's app.
                opts.app = kind(seed["entity"].as_str().unwrap()).app().to_owned();
                let mut app = Session::connect(opts).unwrap();
                let id = app.store.new_entity_id();
                for (field, value) in seed["fields"].as_object().unwrap() {
                    app.store.set(
                        kind(seed["entity"].as_str().unwrap()),
                        &id,
                        field,
                        value.clone(),
                    );
                }
                app.push().unwrap();
                refs.insert(seed["ref"].as_str().unwrap().to_owned(), id);
                continue;
            }
            if step.get("revoke").is_some() {
                server.state.lock().unwrap().revoked = true;
                continue;
            }
            let argv: Vec<String> = step["argv"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| {
                    let mut a = a.as_str().unwrap().to_owned();
                    for (k, v) in &refs {
                        a = a.replace(&format!("{{{k}}}"), v);
                    }
                    a
                })
                .collect();
            let mut env: HashMap<String, String> = [
                ("ATLAS_URL", "http://atlas.test".to_owned()),
                ("ATLAS_TOKEN", server.token_string()),
                ("ATLAS_TZ", tz.to_owned()),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect();
            for (k, v) in step
                .get("env")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
            {
                env.insert(k.clone(), v.as_str().unwrap().to_owned());
            }
            // `stdin`: what the step's standard input holds (`--json -`).
            let stdin_text: Option<String> =
                step.get("stdin").and_then(Value::as_str).map(str::to_owned);
            let read_stdin = || Ok(stdin_text.clone().unwrap_or_default());
            let mut out: Vec<String> = Vec::new();
            let mut err: Vec<String> = Vec::new();
            let connect = |mut opts: ConnectOptions| {
                opts.transport = Some(server.transport());
                opts.store = Some(Box::new(fixed_store));
                let mut client = AtlasClient::connect(opts)?;
                client.set_now(Box::new(move || now));
                Ok(client)
            };
            let code = {
                let mut push_out = |t: &str| out.push(t.to_owned());
                let mut push_err = |t: &str| err.push(t.to_owned());
                let mut io = Io {
                    env,
                    stdout: &mut push_out,
                    stderr: &mut push_err,
                    connect: Some(&connect),
                    stdin: stdin_text.is_some().then_some(&read_stdin as ReadStdin<'_>),
                };
                run(&argv, &mut io)
            };
            let stdout = out.join("\n");
            for (k, field) in step
                .get("capture")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
            {
                let v: Value = serde_json::from_str(&stdout).unwrap();
                let captured = &v[field.as_str().unwrap()];
                refs.insert(
                    k.clone(),
                    captured
                        .as_str()
                        .map_or_else(|| captured.to_string(), str::to_owned),
                );
            }
            let stdout = if stdout.starts_with("atlas ") && stdout.contains("Commands") {
                "<usage>".to_owned()
            } else if stdout == env!("CARGO_PKG_VERSION") {
                // `--version`: the release bump changes it, the recording should not.
                "<version>".to_owned()
            } else {
                normalize(&stdout, &mut ids)
            };
            let stderr: Vec<String> = err.iter().map(|e| normalize(e, &mut ids)).collect();
            if update {
                let s = &mut recorded["scenarios"][si]["steps"][ti];
                s["exit"] = code.into();
                s["stdout"] = stdout.into();
                s["stderr"] = stderr.into();
                continue;
            }
            let what = format!("{name}: {argv:?}");
            assert_eq!(
                code as i64,
                step["exit"].as_i64().unwrap(),
                "exit of {what}\n{stderr:?}"
            );
            assert_eq!(stdout, step["stdout"].as_str().unwrap(), "stdout of {what}");
            assert_eq!(
                serde_json::json!(stderr),
                step["stderr"],
                "stderr of {what}"
            );
        }
    }
    if update {
        let text = serde_json::to_string_pretty(&recorded).unwrap();
        std::fs::write(&path, format!("{text}\n")).unwrap();
    }
}
