//! Binary entrypoint for the Atlas Todo server.

use std::net::SocketAddr;

use atlas_server::{
    admin, app, attachments, auth, config, config::Config, db, restore, retention, state::AppState,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("restore-tasks") => {
            init_tracing(true);
            return restore_tasks(&args[1..]).await;
        }
        Some(command @ ("promote" | "demote")) => {
            init_tracing(true);
            return set_admin(command == "promote", &args[1..]).await;
        }
        _ => {}
    }
    init_tracing(false);

    let config = Config::from_env().map_err(|e| format!("configuration error: {e}"))?;
    let pool = db::connect_with(&config.database_url, config::db_max_connections()?).await?;
    db::migrate(&pool).await?;
    tracing::info!("migrations applied");

    // Promote the listed ADMIN_EMAILS accounts that exist; never demotes (see `admin::sync_admins`).
    let promoted = admin::sync_admins(&pool, &config.admin_emails).await?;
    tracing::info!(
        promoted,
        listed = config.admin_emails.len(),
        "admin list applied"
    );

    let port = config.port;
    if let Some(ref dir) = config.static_dir {
        tracing::info!(static_dir = %dir.display(), "serving static web assets");
    } else {
        tracing::info!("no static asset directory configured (running in API-only mode)");
    }
    let state = AppState::new(pool, config);

    // Operation-log retention (OP_RETENTION_DAYS; see `retention.rs`).
    retention::spawn_if_enabled(&state);

    // Accounts past their deletion grace are purged here, not on next login (most never return).
    auth::account_purge::spawn(&state);

    // API tokens past their expiry lose their copies of the account's keys.
    auth::api_tokens::spawn_expiry_sweep(&state);

    // Partitions of members who left a shared project before leaving revoked all of it.
    {
        let state = state.clone();
        tokio::spawn(async move {
            match atlas_server::sync::revoke_left_projects(&state).await {
                Ok(0) => {}
                Ok(n) => tracing::info!(projects = n, "revoked left projects from leavers"),
                Err(e) => tracing::warn!(error = %e, "revoking left projects failed"),
            }
        });
    }

    // Attachment blob GC (BLOB_GC_GRACE_DAYS), only when attachments are enabled.
    if attachments::spawn_gc_if_enabled(&state).is_some() {
        tracing::info!("blob GC task spawned");
    }

    let addr = SocketAddr::new(config::bind_addr()?, port);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("cannot listen on {addr}: {e}"))?;
    // The bound address, not the requested one: SocketAddr brackets IPv6 (`http://[::]:8080`).
    let addr = listener.local_addr()?;
    tracing::info!("atlas-server listening on http://{addr}");
    // Peer socket info lets the auth rate limiter key by connection IP. On SIGTERM or Ctrl-C,
    // stop accepting and let in-flight requests finish.
    axum::serve(
        listener,
        app(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    tracing::info!("atlas-server stopped");
    Ok(())
}

/// Resolves on the first SIGTERM or Ctrl-C.
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::error!(error = %e, "cannot listen for Ctrl-C");
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(e) => {
                tracing::error!(error = %e, "cannot listen for SIGTERM");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("shutdown signal received, finishing in-flight requests");
}

fn init_tracing(to_stderr: bool) {
    let registry = tracing_subscriber::registry().with(
        EnvFilter::try_from_default_env().unwrap_or_else(|_| "atlas_server=info,warn".into()),
    );
    if to_stderr {
        registry
            .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
            .init();
    } else {
        registry.with(tracing_subscriber::fmt::layer()).init();
    }
}

/// `atlas-server promote <email>` / `atlas-server demote <email>`: grant or revoke the admin role,
/// audited as the CLI. Needs only `DATABASE_URL` and runs no migrations, like `restore-tasks`.
async fn set_admin(promote: bool, args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let [email] = args else {
        eprintln!("usage: atlas-server promote <email>\n       atlas-server demote <email>");
        std::process::exit(2);
    };
    let url = std::env::var("DATABASE_URL").map_err(|_| "DATABASE_URL must be set")?;
    let pool = db::connect(&url).await?;
    let role = if promote { "an admin" } else { "not an admin" };
    match admin::set_admin_by_email(&pool, email, promote, "cli").await? {
        admin::AdminChange::Changed => eprintln!("{email} is now {role}"),
        admin::AdminChange::Unchanged => eprintln!("{email} was already {role}"),
        admin::AdminChange::NotFound => {
            eprintln!("no account with the email {email}; sign up first");
            std::process::exit(1);
        }
    }
    Ok(())
}

/// `atlas-server restore-tasks ...` (see `restore.rs`). Needs only `DATABASE_URL` and runs no
/// migrations. The report goes to stdout as JSON, everything else to stderr.
async fn restore_tasks(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let opts = match restore::RestoreOptions::from_args(args) {
        Ok(opts) => opts,
        Err(e) => {
            eprintln!("{e}\n{}", restore::USAGE);
            std::process::exit(2);
        }
    };
    let url = std::env::var("DATABASE_URL").map_err(|_| "DATABASE_URL must be set")?;
    let pool = db::connect(&url).await?;
    let report = restore::restore_tasks(&pool, &opts).await?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    let skipped = report.tasks.len() - report.restored();
    if report.applied {
        eprintln!("restored {} task(s), skipped {skipped}", report.restored());
    } else {
        eprintln!(
            "dry run: {} task(s) to restore, {skipped} skipped; re-run with --apply to write",
            report.restored()
        );
    }
    Ok(())
}
