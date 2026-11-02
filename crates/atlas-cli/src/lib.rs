//! The `atlas` command line: the same environment, JSON output and exit codes as the apps' own
//! CLIs (Atlas Todo's is `atlas-todo`, in the todo app's repository). Atlas Journal's commands always name their
//! app (`atlas journal entries list`) and open a journal session of the token; so do Atlas
//! Vault's (`atlas vault list`, `atlas vault get NAME --field password`).

use std::collections::HashMap;
use std::path::PathBuf;

use atlas_client::client::AtlasClient;
use atlas_client::journal::{check_mood, JournalFields, JournalQuery, JOURNAL_APP};
use atlas_client::session::ConnectOptions;
use atlas_client::vault::{summary_view, VaultQuery, VAULT_APP};
use atlas_client::Error;
use serde::Serialize;
use serde_json::{json, Map, Value};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn usage_text() -> String {
    format!(
        "atlas {VERSION} - Atlas Journal and Atlas Vault from the command line, for scripts and n8n.

Configuration (environment):
  ATLAS_URL        the server, e.g. https://app.atlastodo.dev (or --url)
  ATLAS_TOKEN      an API token from Settings > API tokens (environment only, never a flag)
  ATLAS_TZ         time zone for dates, e.g. Europe/Copenhagen (default: the system's)
  ATLAS_STATE_DIR  optional: a directory to cache the account in between runs (sealed with
                   the token), so a run downloads only what changed

Atlas Todo's commands (tasks, projects, labels, changes) are the atlas-todo CLI's:
https://github.com/atlastodo/atlas-todo/releases

All commands print JSON.

Atlas Journal (needs a token that includes Atlas Journal):
  journal entries list [--from DAY] [--to DAY] [--tag T] [--search TEXT]
  journal entries get ID
  journal entries add [--date DAY] [--title TEXT] [--body TEXT] [--mood 1-5] [--tag T]...
                      [--json OBJECT]
  journal entries update ID [same fields as add] [--json OBJECT]
  journal entries delete ID

Atlas Vault (needs a token that includes Atlas Vault; read-only unless made with write access):
  vault list [--folder F] [--type T] [--tag T] [--search TEXT]   items without their secrets
  vault get ITEM [--field NAME]   an item with its secrets, or one field's value as plain text
  vault add --name TEXT [--type T] [--username U] [--password P] [--totp SEED]
            [--text NAME=VALUE]... [--hidden NAME=VALUE]... [--uri URL]... [--notes TEXT]
            [--tag T]... [--folder F] [--favorite true|false] [--json OBJECT|-]
  vault update ITEM [same fields as add] [--remove-field NAME]... [--json OBJECT|-]
  vault delete ITEM
  vault folders list
  vault folders add NAME

DAY is YYYY-MM-DD, today, yesterday or tomorrow (in ATLAS_TZ); an entry's date defaults to
today. A journal --json takes date, title, body, mood (null clears it) and tags.
ITEM and F are names (case-insensitive) or ids. A vault --json takes type, name, fields
([{{name, kind, value}}]), urls, notes, tags, folder and favorite, and on update set_fields and
remove_fields; --json - reads it from stdin, which keeps secrets out of the process list.
Field flags add or replace one field (on update the others stay); --folder none clears it.

Errors go to stderr as {{\"error\": ..., \"code\": ...}} with exit code 1 (2 for usage errors)."
    )
}

/// Opens the client; tests pass their own.
pub type Connect<'a> = &'a dyn Fn(ConnectOptions) -> Result<AtlasClient, Error>;

/// Reads standard input to its end (`--json -`); tests pass their own.
pub type ReadStdin<'a> = &'a dyn Fn() -> std::io::Result<String>;

pub struct Io<'a> {
    pub env: HashMap<String, String>,
    pub stdout: &'a mut dyn FnMut(&str),
    pub stderr: &'a mut dyn FnMut(&str),
    pub connect: Option<Connect<'a>>,
    /// `None` reads nothing: `--json -` is then a usage error.
    pub stdin: Option<ReadStdin<'a>>,
}

#[derive(Debug)]
enum Fail {
    Usage(String),
    Run(Error),
}

impl From<Error> for Fail {
    fn from(e: Error) -> Self {
        Fail::Run(e)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Str,
    Multi,
    Bool(char),
}

const OPTIONS: &[(&str, Kind)] = &[
    ("url", Kind::Str),
    ("help", Kind::Bool('h')),
    ("version", Kind::Bool('v')),
    ("project", Kind::Str),
    ("status", Kind::Str),
    ("label", Kind::Multi),
    ("search", Kind::Str),
    ("filter", Kind::Str),
    ("due-before", Kind::Str),
    ("due-after", Kind::Str),
    ("title", Kind::Str),
    ("notes", Kind::Str),
    ("due", Kind::Str),
    ("priority", Kind::Str),
    ("recurrence", Kind::Str),
    ("json", Kind::Str),
    ("since", Kind::Str),
    ("date", Kind::Str),
    ("body", Kind::Str),
    ("mood", Kind::Str),
    ("tag", Kind::Multi),
    ("from", Kind::Str),
    ("to", Kind::Str),
    ("name", Kind::Str),
    ("type", Kind::Str),
    ("field", Kind::Str),
    ("folder", Kind::Str),
    ("username", Kind::Str),
    ("password", Kind::Str),
    ("totp", Kind::Str),
    ("text", Kind::Multi),
    ("hidden", Kind::Multi),
    ("uri", Kind::Multi),
    ("remove-field", Kind::Multi),
    ("favorite", Kind::Str),
];

#[derive(Debug, Default)]
struct Values {
    strings: HashMap<String, String>,
    /// The repeatable options (`--label`, `--tag`), each value in order.
    multi: HashMap<String, Vec<String>>,
    help: bool,
    version: bool,
}

impl Values {
    fn get(&self, name: &str) -> Option<&str> {
        self.strings.get(name).map(String::as_str)
    }

    fn all(&self, name: &str) -> Option<&Vec<String>> {
        self.multi.get(name)
    }
}

fn unknown(arg: &str) -> String {
    format!(
        "Unknown option '{arg}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"{arg}\""
    )
}

/// `node:util` `parseArgs` with `strict` and positionals, as the TypeScript CLI reads its argv.
fn parse_args(argv: &[String]) -> Result<(Values, Vec<String>), String> {
    let mut values = Values::default();
    let mut positionals = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let arg = &argv[i];
        i += 1;
        if arg == "--" {
            positionals.extend(argv[i..].iter().cloned());
            break;
        }
        if let Some(long) = arg.strip_prefix("--") {
            let (name, inline) = match long.split_once('=') {
                Some((n, v)) => (n, Some(v.to_owned())),
                None => (long, None),
            };
            let Some((_, kind)) = OPTIONS.iter().find(|(n, _)| *n == name) else {
                return Err(unknown(&format!("--{name}")));
            };
            match kind {
                Kind::Bool(short) => {
                    if inline.is_some() {
                        return Err(format!(
                            "Option '-{short}, --{name}' does not take an argument"
                        ));
                    }
                    if name == "help" {
                        values.help = true;
                    } else {
                        values.version = true;
                    }
                }
                Kind::Str | Kind::Multi => {
                    let value = match inline {
                        Some(v) => v,
                        None => match argv.get(i) {
                            None => return Err(format!("Option '--{name} <value>' argument missing")),
                            Some(v) if v.len() > 1 && v.starts_with('-') => {
                                return Err(format!(
                                    "Option '--{name}' argument is ambiguous.\nDid you forget to specify the option argument for '--{name}'?\nTo specify an option argument starting with a dash use '--{name}=-XYZ'."
                                ))
                            }
                            Some(v) => {
                                i += 1;
                                v.clone()
                            }
                        },
                    };
                    if *kind == Kind::Multi {
                        values.multi.entry(name.to_owned()).or_default().push(value);
                    } else {
                        values.strings.insert(name.to_owned(), value);
                    }
                }
            }
        } else if arg.len() > 1 && arg.starts_with('-') {
            for ch in arg[1..].chars() {
                match ch {
                    'h' => values.help = true,
                    'v' => values.version = true,
                    other => return Err(unknown(&format!("-{other}"))),
                }
            }
        } else {
            positionals.push(arg.clone());
        }
    }
    Ok((values, positionals))
}

/// The first words of todo's commands, which moved to the `atlas-todo` CLI.
const MOVED_TO_ATLAS_TODO: &[&str] = &["todo", "projects", "labels", "tasks", "changes"];

/// Atlas Journal's commands, always after `journal`.
const JOURNAL_NEEDS_ID: &[&str] = &[
    "journal entries get",
    "journal entries update",
    "journal entries delete",
];
const JOURNAL_COMMANDS: &[&str] = &["journal entries list", "journal entries add"];

/// Atlas Vault's commands, always after `vault`.
const VAULT_NEEDS_TARGET: &[&str] = &[
    "vault get",
    "vault update",
    "vault delete",
    "vault folders add",
];
const VAULT_COMMANDS: &[&str] = &["vault list", "vault add", "vault folders list"];

/// Run one command and return the exit code.
pub fn run(argv: &[String], io: &mut Io<'_>) -> i32 {
    let (values, positionals) = match parse_args(argv) {
        Ok(p) => p,
        Err(e) => return usage(io, &e),
    };
    if values.version {
        (io.stdout)(VERSION);
        return 0;
    }
    if values.help || positionals.is_empty() {
        (io.stdout)(&usage_text());
        return if values.help { 0 } else { 2 };
    }
    if positionals
        .first()
        .is_some_and(|w| MOVED_TO_ATLAS_TODO.contains(&w.as_str()))
    {
        return usage(
            io,
            "Atlas Todo's commands moved to the atlas-todo CLI: \
             https://github.com/atlastodo/atlas-todo/releases",
        );
    }
    let server_url = values
        .get("url")
        .map(str::to_owned)
        .or_else(|| io.env.get("ATLAS_URL").cloned())
        .filter(|u| !u.is_empty());
    let token = io.env.get("ATLAS_TOKEN").cloned().filter(|t| !t.is_empty());
    let Some(server_url) = server_url else {
        return usage(io, "set ATLAS_URL (or pass --url)");
    };
    let Some(token) = token else {
        return usage(io, "set ATLAS_TOKEN to an API token");
    };
    let time_zone = io.env.get("ATLAS_TZ").cloned().filter(|t| !t.is_empty());
    let state_dir = io
        .env
        .get("ATLAS_STATE_DIR")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from);

    let journal = positionals.first().map(String::as_str) == Some(JOURNAL_APP);
    let vault = positionals.first().map(String::as_str) == Some(VAULT_APP);
    let (command, target) = if vault {
        // `atlas vault get ITEM`, `atlas vault folders add NAME`.
        let words = if positionals.get(1).map(String::as_str) == Some("folders") {
            3
        } else {
            2
        };
        let command = positionals
            .iter()
            .take(words)
            .cloned()
            .collect::<Vec<_>>()
            .join(" ");
        let known = VAULT_COMMANDS.contains(&command.as_str())
            || VAULT_NEEDS_TARGET.contains(&command.as_str());
        if !known {
            return usage(
                io,
                &format!("unknown command \"{}\"", positionals.join(" ")),
            );
        }
        let target = positionals.get(words).cloned();
        if VAULT_NEEDS_TARGET.contains(&command.as_str()) && target.is_none() {
            let what = if command == "vault folders add" {
                "a folder name"
            } else {
                "an item name or id"
            };
            return usage(io, &format!("\"{command}\" needs {what}"));
        }
        (command, target)
    } else if journal {
        // `atlas journal entries get ID`.
        let command = positionals
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join(" ");
        let known = JOURNAL_COMMANDS.contains(&command.as_str())
            || JOURNAL_NEEDS_ID.contains(&command.as_str());
        if !known {
            return usage(
                io,
                &format!("unknown command \"{}\"", positionals.join(" ")),
            );
        }
        let target = positionals.get(3).cloned();
        if JOURNAL_NEEDS_ID.contains(&command.as_str()) && target.is_none() {
            return usage(io, &format!("\"{command}\" needs an entry id"));
        }
        (command, target)
    } else {
        return usage(
            io,
            &format!("unknown command \"{}\"", positionals.join(" ")),
        );
    };
    let mut opts = ConnectOptions::new(&server_url, &token);
    opts.time_zone = time_zone.clone();
    opts.state_dir = state_dir;
    if journal {
        opts.app = JOURNAL_APP.to_owned();
    }
    if vault {
        opts.app = VAULT_APP.to_owned();
    }
    // `--json -`: the object comes from stdin, read before signing in so a bad one costs nothing.
    let mut values = values;
    if values.get("json") == Some("-") {
        let Some(read) = io.stdin else {
            return usage(io, "--json - needs standard input");
        };
        match read() {
            Ok(text) => {
                values.strings.insert("json".into(), text);
            }
            Err(e) => return usage(io, &format!("could not read standard input: {e}")),
        }
    }
    if vault {
        if let Err(Fail::Usage(m)) = vault_input(&command, &values) {
            return usage(io, &m);
        }
    }
    let connected = match io.connect {
        Some(connect) => connect(opts),
        None => AtlasClient::connect(opts),
    };
    let mut client = match connected {
        Ok(c) => c,
        Err(e) => return fail(io, &e),
    };
    let result = dispatch(&mut client, &command, target.as_deref(), &values);
    // A failed cache write costs the next run a full sync, nothing more.
    let _ = client.session().save_state();
    match result {
        Ok(v) => {
            (io.stdout)(&v);
            0
        }
        Err(Fail::Usage(m)) => usage(io, &m),
        Err(Fail::Run(e)) => fail(io, &e),
    }
}

fn to_json<T: Serialize>(v: T) -> String {
    serde_json::to_string_pretty(&v).expect("JSON")
}

fn dispatch(
    atlas: &mut AtlasClient,
    command: &str,
    id: Option<&str>,
    values: &Values,
) -> Result<String, Fail> {
    let id = id.unwrap_or("");
    Ok(match command {
        "journal entries list" => {
            let tags = values.all("tag").cloned().unwrap_or_default();
            if tags.len() > 1 {
                return Err(Fail::Usage("journal entries list takes one --tag".into()));
            }
            to_json(atlas.journal_entries(&JournalQuery {
                from: values.get("from").map(str::to_owned),
                to: values.get("to").map(str::to_owned),
                tag: tags.into_iter().next(),
                search: values.get("search").map(str::to_owned),
            })?)
        }
        "journal entries get" => to_json(atlas.journal_entry(id)?),
        "journal entries add" => to_json(atlas.create_journal_entry(journal_fields(values)?)?),
        "journal entries update" => {
            to_json(atlas.update_journal_entry(id, journal_fields(values)?)?)
        }
        "journal entries delete" => {
            atlas.delete_journal_entry(id)?;
            to_json(json!({ "deleted": id }))
        }
        "vault list" => {
            let tags = values.all("tag").cloned().unwrap_or_default();
            if tags.len() > 1 {
                return Err(Fail::Usage("vault list takes one --tag".into()));
            }
            to_json(atlas.vault_items(&VaultQuery {
                folder: values.get("folder").map(str::to_owned),
                kind: values.get("type").map(str::to_owned),
                tag: tags.into_iter().next(),
                search: values.get("search").map(str::to_owned),
            })?)
        }
        "vault get" => match values.get("field") {
            // The bare value, for `$(atlas vault get … --field password)`.
            Some(field) => atlas.vault_secret(id, field)?,
            None => to_json(atlas.vault_item(id)?),
        },
        // A write answers the listing form: a CI log should not end up holding the secret.
        "vault add" => {
            let item = atlas.create_vault_item(&vault_input(command, values)?)?;
            to_json(summary_view(&item))
        }
        "vault update" => {
            let item = atlas.update_vault_item(id, &vault_input(command, values)?)?;
            to_json(summary_view(&item))
        }
        "vault delete" => to_json(json!({ "deleted": atlas.delete_vault_item(id)? })),
        "vault folders list" => to_json(atlas.vault_folders()?),
        "vault folders add" => to_json(atlas.create_vault_folder(id)?),
        other => return Err(Fail::Usage(format!("unknown command \"{other}\""))),
    })
}

/// The `--json` object, when given.
fn json_object(values: &Values) -> Result<Map<String, Value>, Fail> {
    let Some(text) = values.get("json") else {
        return Ok(Map::new());
    };
    let parsed: Value =
        serde_json::from_str(text).map_err(|_| Fail::Usage("--json is not valid JSON".into()))?;
    match parsed {
        Value::Object(o) => Ok(o),
        _ => Err(Fail::Usage("--json must be an object".into())),
    }
}

/// A journal entry's fields for `add` and `update`: flags over `--json`. Strings stay strings
/// (`title`, `body`, `date`); a mood is 1 to 5, or `none` / null to clear it; tags are a list.
fn journal_fields(values: &Values) -> Result<JournalFields, Fail> {
    let json = json_object(values)?;
    let text = |flag: &str| -> Result<Option<String>, Fail> {
        if let Some(v) = values.get(flag) {
            return Ok(Some(v.to_owned()));
        }
        match json.get(flag) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(Fail::Usage(format!("{flag} must be a string"))),
        }
    };
    let mood = match values.get("mood") {
        Some(m) if m.is_empty() || m.eq_ignore_ascii_case("none") => Some(None),
        Some(m) => Some(Some(check_mood(&js_number(&Value::from(m)))?)),
        None => match json.get("mood") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(m) => Some(Some(check_mood(m)?)),
        },
    };
    let tags = match values.all("tag") {
        Some(t) => Some(t.clone()),
        None => match json.get("tags") {
            None | Some(Value::Null) => None,
            Some(Value::Array(items)) => Some(
                items
                    .iter()
                    .map(|t| match t {
                        Value::String(s) => Ok(s.clone()),
                        _ => Err(Fail::Usage("tags must be a list of strings".into())),
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            ),
            Some(_) => return Err(Fail::Usage("tags must be a list of strings".into())),
        },
    };
    Ok(JournalFields {
        date: text("date")?,
        title: text("title")?,
        body: text("body")?,
        mood,
        tags,
    })
}

/// A `NAME=VALUE` field flag.
fn named_value(flag: &str, raw: &str) -> Result<(String, String), Fail> {
    match raw.split_once('=') {
        Some((n, v)) if !n.trim().is_empty() => Ok((n.trim().to_owned(), v.to_owned())),
        _ => Err(Fail::Usage(format!("--{flag} takes NAME=VALUE"))),
    }
}

/// Append `items` to the list `key` of `input`; a non-list there is left for the rules to refuse.
fn extend_list(input: &mut Map<String, Value>, key: &str, items: Vec<Value>, replace_named: bool) {
    let mut list = match input.remove(key) {
        None => Vec::new(),
        Some(Value::Array(a)) => a,
        Some(other) => {
            input.insert(key.into(), other);
            return;
        }
    };
    for item in items {
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .map(|n| n.trim().to_lowercase());
        let same = list.iter_mut().find(|e| {
            replace_named
                && name.is_some()
                && e.get("name")
                    .and_then(Value::as_str)
                    .map(|n| n.trim().to_lowercase())
                    == name
        });
        match same {
            Some(e) => *e = item,
            None => list.push(item),
        }
    }
    input.insert(key.into(), Value::Array(list));
}

/// What `vault add` and `vault update` send: the `--json` object (or stdin's), with the flags over
/// it. A field flag adds or replaces one field: on add in `fields`, on update in `set_fields`, so
/// the item's other fields stay. `Null` for the other vault commands.
fn vault_input(command: &str, values: &Values) -> Result<Value, Fail> {
    let update = command == "vault update";
    if !update && command != "vault add" {
        return Ok(Value::Null);
    }
    let mut input = json_object(values)?;
    for key in ["name", "type", "notes"] {
        if let Some(v) = values.get(key) {
            input.insert(key.into(), v.into());
        }
    }
    if let Some(f) = values.get("folder") {
        let folder = if f.is_empty() || f.eq_ignore_ascii_case("none") {
            Value::Null
        } else {
            f.into()
        };
        input.insert("folder".into(), folder);
    }
    if let Some(f) = values.get("favorite") {
        let favorite = match f.to_ascii_lowercase().as_str() {
            "true" | "yes" | "1" => true,
            "false" | "no" | "0" => false,
            _ => return Err(Fail::Usage("--favorite is true or false".into())),
        };
        input.insert("favorite".into(), favorite.into());
    }
    if let Some(urls) = values.all("uri") {
        input.insert("urls".into(), urls.clone().into());
    }
    if let Some(tags) = values.all("tag") {
        input.insert("tags".into(), tags.clone().into());
    }
    let mut fields: Vec<Value> = Vec::new();
    for (flag, kind) in [
        ("username", "text"),
        ("password", "hidden"),
        ("totp", "totp"),
    ] {
        if let Some(v) = values.get(flag) {
            fields.push(json!({ "name": flag, "kind": kind, "value": v }));
        }
    }
    for kind in ["text", "hidden"] {
        for raw in values.all(kind).into_iter().flatten() {
            let (name, value) = named_value(kind, raw)?;
            fields.push(json!({ "name": name, "kind": kind, "value": value }));
        }
    }
    if !fields.is_empty() {
        let key = if update { "set_fields" } else { "fields" };
        extend_list(&mut input, key, fields, true);
    }
    if let Some(removes) = values.all("remove-field") {
        if !update {
            return Err(Fail::Usage("--remove-field is for vault update".into()));
        }
        let removes = removes.iter().cloned().map(Value::from).collect();
        extend_list(&mut input, "remove_fields", removes, false);
    }
    if !update && !input.contains_key("name") {
        return Err(Fail::Usage(
            "vault add needs --name (or a name in --json)".into(),
        ));
    }
    Ok(Value::Object(input))
}

/// JavaScript's `String(value)`.
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_text(n.as_f64().unwrap_or(0.0)),
        Value::Array(a) => a
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    js_string(x)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn js_number_text(f: f64) -> String {
    if f.is_nan() {
        "NaN".into()
    } else if f.is_infinite() {
        if f > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else if f.fract() == 0.0 && f.abs() < 1e21 {
        format!("{f:.0}")
    } else {
        f.to_string()
    }
}

/// JavaScript's `Number(string)`.
fn js_number_of_str(s: &str) -> f64 {
    let t = s.trim_matches(js_space);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |p: &str, r: u32| {
        u64::from_str_radix(p, r)
            .map(|n| n as f64)
            .unwrap_or(f64::NAN)
    };
    if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return radix(h, 16);
    }
    if let Some(o) = t.strip_prefix("0o").or_else(|| t.strip_prefix("0O")) {
        return radix(o, 8);
    }
    if let Some(b) = t.strip_prefix("0b").or_else(|| t.strip_prefix("0B")) {
        return radix(b, 2);
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if t.bytes()
        .any(|b| !(b.is_ascii_digit() || b"+-.eE".contains(&b)))
    {
        return f64::NAN;
    }
    t.parse().unwrap_or(f64::NAN)
}

/// JavaScript's `Number(value)` as a JSON value; NaN and the infinities as a string, so that the
/// priority check refuses them as it refuses NaN.
fn js_number(v: &Value) -> Value {
    let f = match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => js_number_of_str(s),
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Null => 0.0,
        Value::Array(a) if a.is_empty() => 0.0,
        Value::Array(a) if a.len() == 1 => return js_number(&Value::String(js_string(&a[0]))),
        _ => f64::NAN,
    };
    if !f.is_finite() {
        return Value::String(js_number_text(f));
    }
    if f.fract() == 0.0 && f.abs() < 9e15 {
        Value::from(f as i64)
    } else {
        Value::from(f)
    }
}

fn usage(io: &mut Io<'_>, message: &str) -> i32 {
    let line = Described {
        error: message.to_owned(),
        code: "usage".into(),
        status: None,
    };
    (io.stderr)(&serde_json::to_string(&line).expect("JSON"));
    (io.stderr)("Run `atlas --help` for the commands.");
    2
}

#[derive(Serialize)]
struct Described {
    error: String,
    code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
}

/// `{ error, code, status? }` for a failure, as the TypeScript CLI describes one.
pub fn describe(err: &Error) -> String {
    let d = match err {
        Error::Atlas { code, message } => Described {
            error: message.clone(),
            code: code.clone(),
            status: None,
        },
        Error::InvalidApiToken(_) => Described {
            error: "ATLAS_TOKEN is not an Atlas API token".into(),
            code: "invalid_token".into(),
            status: None,
        },
        Error::Api { .. } | Error::UpgradeRequired { .. } => {
            let status = err.status().unwrap_or(0);
            let code = match err {
                Error::UpgradeRequired { .. } => "upgrade_required".to_owned(),
                _ => err
                    .api_code()
                    .map(str::to_owned)
                    .unwrap_or_else(|| match status {
                        401 => "unauthorized".into(),
                        429 => "rate_limited".into(),
                        _ => "server_error".into(),
                    }),
            };
            // An expired token says so itself.
            let hint = if status == 401 && code == "unauthorized" {
                " (revoked or wrong token?)"
            } else {
                ""
            };
            Described {
                error: format!("{err}{hint}"),
                code,
                status: Some(status),
            }
        }
        other => Described {
            error: other.to_string(),
            code: "error".into(),
            status: None,
        },
    };
    serde_json::to_string(&d).expect("JSON")
}

fn fail(io: &mut Io<'_>, err: &Error) -> i32 {
    (io.stderr)(&describe(err));
    1
}

/// JavaScript's white space and line terminators (`String.prototype.trim`).
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\x0b' | '\x0c' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reads_argv_like_node_parse_args() {
        let (v, p) = parse_args(&args(&[
            "-hv",
            "a",
            "--label",
            "x",
            "--label=y",
            "--",
            "--z",
        ]))
        .unwrap();
        assert!(v.help && v.version);
        assert_eq!(p, ["a", "--z"]);
        assert_eq!(*v.all("label").unwrap(), ["x", "y"]);
        assert!(parse_args(&args(&["--foo"]))
            .unwrap_err()
            .starts_with("Unknown option '--foo'"));
        assert_eq!(
            parse_args(&args(&["--title"])).unwrap_err(),
            "Option '--title <value>' argument missing"
        );
        assert!(parse_args(&args(&["--title", "-x"]))
            .unwrap_err()
            .contains("is ambiguous"));
        assert_eq!(
            parse_args(&args(&["--help=1"])).unwrap_err(),
            "Option '-h, --help' does not take an argument"
        );
        let (v, _) = parse_args(&args(&["--title=-x", "--title", "b"])).unwrap();
        assert_eq!(v.get("title"), Some("b"));
    }

    #[test]
    fn numbers_read_as_javascript_reads_them() {
        for (s, n) in [
            ("", 0.0),
            (" 5 ", 5.0),
            ("0x10", 16.0),
            ("1e3", 1000.0),
            ("2.5", 2.5),
        ] {
            assert_eq!(js_number_of_str(s), n, "{s:?}");
        }
        assert!(js_number_of_str("abc").is_nan());
        assert!(js_number_of_str("inf").is_nan());
        assert_eq!(js_number(&json!("2")), json!(2));
        assert_eq!(js_number(&json!("x")), json!("NaN"));
        assert_eq!(js_string(&json!([1, "a"])), "1,a");
    }
}
