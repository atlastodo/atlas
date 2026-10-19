use std::process::ExitCode;

use atlas_secretspec::endpoint::AtlasProvider;
use atlas_secretspec::{register, Settings, SCHEME};
use secretspec_ipc::server::ServerConfig;
use secretspec_ipc::Product;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn usage() -> String {
    format!(
        "secretspec-provider-atlas {VERSION}: resolve SecretSpec secrets from Atlas Vault.

Usage:
  secretspec-provider-atlas register [--system | --print]
      Register this binary with SecretSpec (0.21+) as the provider for atlas:// URIs: writes
      atlas.secretspec.json into SecretSpec's user providers.d directory (--system: the system
      one; --print: print the claim instead).
  secretspec-provider-atlas status [URI]
      Sign in as SecretSpec would and say whether the token works: the server, whether it may
      write, and when it expires. URI defaults to atlas:// (the server in ATLAS_URL).
  secretspec-provider-atlas provider
      Serve the Secret Provider Protocol on stdin/stdout. SecretSpec runs this; not for people.

Provider URIs: atlas:// (the server in ATLAS_URL) or atlas://HOST[:PORT][/PATH] (https; http
for localhost).

Environment:
  ATLAS_URL        the server for atlas:// without a host, e.g. https://app.atlastodo.dev
  ATLAS_TOKEN      an Atlas Vault API token (read-only unless made with writes); without it,
                   the provider asks SecretSpec for its credential \"token\"
  ATLAS_STATE_DIR  optional: cache the synced vault between runs, as the atlas CLI does

Mapping: the secret KEY of profile PROFILE in project PROJECT is the field KEY of the item
PROFILE in the vault folder PROJECT. See docs/integrations.md (SecretSpec)."
    )
}

fn settings() -> Settings {
    Settings::from_env(|k| std::env::var(k).ok())
}

fn serve() -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => return ExitCode::FAILURE,
    };
    let config = ServerConfig {
        product: Product {
            name: "secretspec-provider-atlas".to_owned(),
            version: VERSION.to_owned(),
        },
        ..ServerConfig::default()
    };
    let served = runtime.block_on(secretspec_ipc::provider::serve_provider(
        tokio::io::stdin(),
        tokio::io::stdout(),
        AtlasProvider::new(settings()),
        config,
    ));
    // The worker thread may still hold a blocking request; nothing is left to answer it.
    runtime.shutdown_background();
    if served.is_ok() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn register_command(args: &[String]) -> ExitCode {
    let (mut system, mut print) = (false, false);
    for arg in args {
        match arg.as_str() {
            "--system" => system = true,
            "--print" => print = true,
            other => {
                eprintln!("unknown option {other}\n\n{}", usage());
                return ExitCode::from(2);
            }
        }
    }
    let executable = match std::env::current_exe().and_then(std::fs::canonicalize) {
        Ok(path) => path,
        Err(e) => {
            eprintln!("could not find this executable: {e}");
            return ExitCode::FAILURE;
        }
    };
    if print {
        print!("{}", register::claim(&executable));
        return ExitCode::SUCCESS;
    }
    let Some(directory) = register::directory(system, |k| std::env::var(k).ok()) else {
        eprintln!("could not find SecretSpec's providers.d directory (is HOME set?)");
        return ExitCode::FAILURE;
    };
    match register::write(&directory, &executable) {
        Ok(path) => {
            println!(
                "registered {} as the SecretSpec provider for {SCHEME}:// in {}",
                executable.display(),
                path.display()
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("could not write {}: {e}", directory.display());
            ExitCode::FAILURE
        }
    }
}

fn status(args: &[String]) -> ExitCode {
    let settings = settings();
    let uri = args.first().map_or("atlas://", String::as_str);
    let fail = |fault: atlas_secretspec::Fault| {
        eprintln!("error: {fault}");
        ExitCode::FAILURE
    };
    let server = match atlas_secretspec::server_url(uri, SCHEME, settings.url.as_deref()) {
        Ok(server) => server,
        Err(fault) => return fail(fault),
    };
    let Some(token) = settings.token.as_deref() else {
        eprintln!("error: set ATLAS_TOKEN to an Atlas Vault API token (no_token)");
        return ExitCode::FAILURE;
    };
    let client = match atlas_secretspec::connect(&server, token, settings.state_dir.clone()) {
        Ok(client) => client,
        Err(fault) => return fail(fault),
    };
    let session = client.session();
    println!("server: {server}");
    println!(
        "access: {}",
        if session.can_write {
            "read and write"
        } else {
            "read-only (secretspec set is refused)"
        }
    );
    match session.token_expires_at {
        Some(at) => println!("expires: {}", format_ms(at)),
        None => println!("expires: never"),
    }
    match client.vault_folders() {
        Ok(folders) => println!("folders: {}", folders.len()),
        Err(e) => return fail(atlas_secretspec::fault(&e)),
    }
    ExitCode::SUCCESS
}

/// Unix ms as an RFC 3339 UTC time.
fn format_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("provider") if args.len() == 1 => serve(),
        Some("register") => register_command(&args[1..]),
        Some("status") if args.len() <= 2 => status(&args[1..]),
        Some("--version" | "-V") => {
            println!("{VERSION}");
            ExitCode::SUCCESS
        }
        Some("--help" | "-h" | "help") => {
            println!("{}", usage());
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("{}", usage());
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn formats_unix_ms_as_utc() {
        assert_eq!(super::format_ms(0), "1970-01-01T00:00:00Z");
        assert_eq!(super::format_ms(1_792_368_000_000), "2026-10-19T00:00:00Z");
        assert_eq!(super::format_ms(1_792_411_506_000), "2026-10-19T12:05:06Z");
        assert_eq!(super::format_ms(951_782_400_123), "2000-02-29T00:00:00Z");
    }
}
