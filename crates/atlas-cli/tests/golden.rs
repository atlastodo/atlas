//! `test-vectors/cli_golden.json`: the runs the TypeScript CLI recorded (`packages/cli/src/golden.test.ts`),
//! reproduced byte for byte by this CLI against the same fake server.

use std::collections::HashMap;

use atlas_cli::{run, Io};
use atlas_client::client::AtlasClient;
use atlas_client::session::{ConnectOptions, Session};
use atlas_client::store::Store;
use atlas_client::testing::FakeServer;
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
fn reproduces_the_typescript_cli() {
    let path = format!(
        "{}/../../test-vectors/cli_golden.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let now = golden["now"].as_i64().unwrap();
    let fixed_store =
        move |node: Uuid| Store::with(node, Box::new(move || now as u64), Box::new(Uuid::new_v4));
    for scenario in golden["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let tz = scenario["tz"].as_str().unwrap();
        let server = FakeServer::new();
        let mut refs: HashMap<String, String> = HashMap::new();
        let mut ids = HashMap::new();
        for step in scenario["steps"].as_array().unwrap() {
            if let Some(seed) = step.get("seed") {
                let mut opts = ConnectOptions::new("http://atlas.test", &server.token_string());
                opts.transport = Some(server.transport());
                opts.store = Some(Box::new(fixed_store));
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
            } else {
                normalize(&stdout, &mut ids)
            };
            let stderr: Vec<String> = err.iter().map(|e| normalize(e, &mut ids)).collect();
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
}
