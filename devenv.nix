{ pkgs, lib, config, inputs, ... }:

let
  # sqlx-cli pinned to the sqlx crate's version (Cargo.lock), so `db:migrate` and the server's
  # embedded migrator agree on the migrations table. nixpkgs has moved on to 0.9.
  sqlx-cli = pkgs.sqlx-cli.overrideAttrs (final: prev: {
    version = "0.8.6";
    src = pkgs.fetchCrate {
      pname = "sqlx-cli";
      version = final.version;
      hash = "sha256-quktEsLQC2w6C4bqxqP4DALsJMEBKNnrxMPKkeMQyOY=";
    };
    # buildRustPackage derives these from its arguments, so overriding cargoHash/buildFeatures
    # through overrideAttrs would not reach them. 0.8.6 has no `sqlx-toml` feature.
    cargoDeps = pkgs.rustPlatform.fetchCargoVendor {
      inherit (final) pname version src;
      hash = "sha256-YC79O881ESziFDU9ipe94CWxiQ51K+dbax3MOlbFaec=";
    };
    cargoBuildFeatures = [ "native-tls" "postgres" "completions" ];
    # Upstream's own tests import the sqlite driver, which this Postgres-only build leaves out.
    doCheck = false;
  });

in
{
  # ---------------------------------------------------------------------------
  # Atlas core development environment.
  #
  # Provides every tool needed to build and test core reproducibly:
  #   - Rust (atlas-core, atlas-server, atlas-client, atlas-cli)
  #   - Node + Bun (packages/{client-core,shared,sdk})
  #   - PostgreSQL (server database, run as a devenv service)
  #   - assorted quality/tooling
  #
  # The todo app (apps/mobile, apps/electron) lives in atlastodo/atlas-todo, with its own devenv.
  #
  # `devenv shell` drops you into this env; `devenv up` starts Postgres; the
  # scripts below wrap the common workflows. See README.md for usage.
  # ---------------------------------------------------------------------------

  # --- Languages -------------------------------------------------------------
  # Auto-load `.env` (gitignored) into the shell so the server picks up JWT_SECRET etc. without a
  # manual `source`. Keep DB config OUT of `.env` -- DATABASE_URL is derived below from the allocated
  # PGPORT; a hardcoded port in `.env` would shadow it and drift (see the postgres note below).
  dotenv.enable = true;

  languages.rust = {
    enable = true;
    channel = "stable";
    # rust-src lets rust-analyzer/RustRover resolve the stdlib.
    components = [ "rustc" "cargo" "clippy" "rustfmt" "rust-analyzer" "rust-src" ];
  };

  languages.javascript = {
    enable = true;
    # Node 26, matching `engines`, CI and the Docker image. Node is the runtime; Bun is the package
    # manager + task runner.
    package = pkgs.nodejs_26;
    bun.enable = true;
  };

  # --- Services --------------------------------------------------------------
  services.postgres = {
    enable = true;
    package = pkgs.postgresql_16;
    listen_addresses = "127.0.0.1";
    # `port` is only the *base* for devenv's automatic allocation: the module declares
    # `ports.main.allocate = port` and sets both PGPORT and postgresql.conf's port to the actually
    # allocated value (5432 if free, else the next free port). So the real port lives in
    # `config.env.PGPORT`, and the DATABASE_URLs below derive from it -- never from this base -- so the
    # URL always matches the running server. (Deriving from `config.services.postgres.port` would be
    # wrong: that's the static base, not the allocated port.)
    port = 5432;
    # Locale C.UTF-8 (not devenv's default `C`): UTF-8 encoding alone is not enough. Under `C`,
    # `lower()`/`ILIKE` case-fold ASCII only, so Danish characters (æøå, ÆØÅ) never match
    # case-insensitively and `ORDER BY` sorts bytewise. Only takes effect for a freshly
    # initialised data dir: wipe `.devenv/state/postgres` (dev data is re-migratable) to apply.
    initdbArgs = [ "--locale=C.UTF-8" "--encoding=UTF8" ];
    initialDatabases = [
      { name = "atlas_dev"; }
      { name = "atlas_test"; }
    ];
    initialScript = ''
      CREATE USER atlas WITH PASSWORD 'atlas' SUPERUSER;
    '';
  };

  # --- Packages / tooling ----------------------------------------------------
  packages = with pkgs; [
    git
    # Rust dev tooling
    sqlx-cli
    cargo-watch
    cargo-nextest
    cargo-deny
    # OpenSSL for webauthn-rs (passkey verification), found through pkg-config
    openssl
    pkg-config
    # Container tooling
    docker-compose
  ];

  # Env available in the shell and to scripts/services. The DATABASE_URLs derive their port from
  # `config.env.PGPORT` -- the port devenv actually allocated for Postgres (see the note on
  # `services.postgres.port` above) -- so the URL always matches the running server, even if the base
  # port was taken and allocation bumped to the next free one.
  env = {
    DATABASE_URL = "postgres://atlas:atlas@127.0.0.1:${toString config.env.PGPORT}/atlas_dev";
    TEST_DATABASE_URL = "postgres://atlas:atlas@127.0.0.1:${toString config.env.PGPORT}/atlas_test";
    RUST_LOG = "atlas_server=debug,info";
  };

  # --- Scripts (developer entry points) --------------------------------------
  # `dev` -- the sync server with reload (cargo watch) on :8080, serving the pinned todo web build
  # (the flake's web-dist, apps.lock.json) unless STATIC_DIR is set. Needs Postgres (`devenv up`).
  # Work on the app itself happens in atlastodo/atlas-todo, against this server.
  scripts.dev.exec = ''
    set -euo pipefail
    cd "$DEVENV_ROOT"
    if [ -z "''${STATIC_DIR:-}" ]; then
      STATIC_DIR="$(nix build --no-link --print-out-paths .#web-dist)"
      export STATIC_DIR
    fi
    echo ">> atlas-server on http://localhost:''${PORT:-8080}, web app from $STATIC_DIR"
    sqlx migrate run --source migrations
    exec ${pkgs.cargo-watch}/bin/cargo-watch -x 'run -p atlas-server'
  '';
  # Release helper: bump the version across ALL manifests in lockstep (the "version the manifests"
  # rule). `version:bump 0.13.4` sets an explicit version; `version:bump patch|minor|major` steps it.
  # Then commit `chore(release): vX.Y.Z` and tag `vX.Y.Z` to release.
  scripts."version:bump".exec = ''bash "$DEVENV_ROOT/scripts/bump-version.sh" "$@"'';
  scripts."db:migrate".exec = "sqlx migrate run --source migrations";
  scripts."db:reset".exec = "sqlx database reset -y --source migrations";
  # Named test:all -- a script called "test" collides with the shell builtin, so `devenv shell
  # test` silently exits 0 instead of running this.
  # `set -e` so any failing step fails the script, not just the last one.
  scripts."test:all".exec = ''
    set -euo pipefail
    cargo nextest run --workspace
    # `--bun` runs vitest itself under Bun's runtime (supported since Bun 1.4), matching CI.
    (cd packages/client-core && bunx --bun vitest run)
    (cd packages/shared && bunx --bun vitest run)
    (cd packages/sdk && bunx --bun vitest run)
  '';
  # Typecheck, ESLint (`eslint.config.mjs`) and `prettier --check` cover the TypeScript packages, as
  # in CI's `Lint (TypeScript)`.
  # One command per line: under `set -e` a failure on the left of `&&` would not stop the script.
  scripts.lint.exec = ''
    set -euo pipefail
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets --no-deps -- -D warnings
    bun run --filter '*' typecheck
    bunx eslint .
    bunx prettier --check .
    node scripts/third-party-licenses.mjs --check
    # nix/bun.nix must match bun.lock (Dependabot's bun PRs regenerate it).
    if command -v nix >/dev/null; then
      fresh="$(mktemp)"
      nix run --inputs-from . bun2nix -- -c ../ -o "$fresh"
      cmp -s "$fresh" nix/bun.nix || { rm -f "$fresh"; echo "nix/bun.nix is stale: run nix:bun-lock" >&2; exit 1; }
      rm -f "$fresh"
    fi
  '';
  scripts.fmt.exec = ''
    cargo fmt --all
    bunx prettier --write .
  '';
  # Regenerate nix/bun.nix (the npm dependency set bun2nix reads) from bun.lock, with the bun2nix
  # version the flake locks. Run after every change to bun.lock; `lint` checks it.
  scripts."nix:bun-lock".exec = ''
    set -euo pipefail
    cd "$DEVENV_ROOT"
    nix run --inputs-from . bun2nix -- -c ../ -o nix/bun.nix
  '';

  # The core packages' npm tarballs (atlastodo-<pkg>-X.Y.Z.tgz) in dist-packages/, as the release
  # attaches them; `packages:pack <dir>` writes them elsewhere.
  scripts."packages:pack".exec = ''
    set -euo pipefail
    cd "$DEVENV_ROOT"
    scripts/pack-core-packages.sh "$@"
  '';

  enterShell = ''
    if [ -n "''${DEVENV_PROFILE:-}" ]; then
      export PATH="$DEVENV_PROFILE/bin:$PATH"
    fi
    echo "Atlas dev shell -- rust $(rustc --version 2>/dev/null | cut -d' ' -f2), node $(node --version)"
    echo "Scripts: dev, db:migrate, db:reset, test:all, lint, fmt, version:bump (run 'devenv up' for Postgres)"
  '';

  # `devenv test` starts the processes (Postgres) first, which the atlas-server integration tests
  # in this suite need.
  enterTest = ''
    cargo nextest run --workspace
  '';

  # --- Local git hooks (mirror CI quality gates) -----------------------------
  git-hooks.hooks = {
    rustfmt.enable = true;
    clippy.enable = true;
  };

  # See full reference at https://devenv.sh/reference/options/
}
