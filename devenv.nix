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

  # First lines of every script that needs the Android SDK, which is opt-in (see `android` below).
  requireAndroid = ''
    if [ -z "''${ANDROID_HOME:-}" ]; then
      echo "!! This needs the Android SDK, which is off by default. To enable it, create" >&2
      echo "   devenv.local.nix (gitignored) in the repo root containing:" >&2
      echo "     { android.enable = true; }" >&2
      echo "   then re-enter the shell. The first entry downloads the SDK (several GB)." >&2
      exit 1
    fi
  '';
in
{
  # ---------------------------------------------------------------------------
  # Atlas Todo development environment.
  #
  # Provides every tool needed to build and test the whole stack reproducibly:
  #   - Rust (backend: atlas-core, atlas-server)
  #   - Node + Bun (frontend: apps/mobile RN app + web export, packages/{client-core,shared})
  #   - PostgreSQL (server database, run as a devenv service)
  #   - assorted quality/tooling
  #
  # `devenv shell` drops you into this env; `devenv up` starts Postgres; the
  # scripts below wrap the common workflows. See README.md for usage.
  # ---------------------------------------------------------------------------

  # --- Languages -------------------------------------------------------------
  # Auto-load `.env` (gitignored) into the shell so the server picks up JWT_SECRET etc. without a
  # manual `source`. Keep DB config OUT of `.env` -- DATABASE_URL is derived below from the allocated
  # PGPORT; a hardcoded port in `.env` would shadow it and drift (see the postgres note below).
  dotenv.enable = true;

  # --- Android SDK & Emulator ------------------------------------------------
  # Opt-in: several GB that only native Android work needs (Expo Go and EAS cloud builds don't).
  # Enable it per machine with a devenv.local.nix containing `{ android.enable = true; }`.
  android = {
    enable = lib.mkDefault false;
    platforms.version = [ "34" "35" "36" ];
    systemImageTypes = [ "google_apis_playstore" ];
    abis = [ "x86_64" ];
    buildTools.version = [ "34.0.0" "35.0.0" "36.0.0" ];
    ndk.version = [ "27.0.12077973" "27.1.12297006" ];
    cmake.version = [ "3.22.1" ];
    emulator.enable = true;
    systemImages.enable = true;
    reactNative.enable = true;
  };

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
    # Container tooling
    docker-compose
    # Desktop tooling
    electron
  ];

  # Env available in the shell and to scripts/services. The DATABASE_URLs derive their port from
  # `config.env.PGPORT` -- the port devenv actually allocated for Postgres (see the note on
  # `services.postgres.port` above) -- so the URL always matches the running server, even if the base
  # port was taken and allocation bumped to the next free one.
  env = {
    DATABASE_URL = "postgres://atlas:atlas@127.0.0.1:${toString config.env.PGPORT}/atlas_dev";
    TEST_DATABASE_URL = "postgres://atlas:atlas@127.0.0.1:${toString config.env.PGPORT}/atlas_test";
    RUST_LOG = "atlas_server=debug,info";
    ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron}/bin";
  } // lib.optionalAttrs config.android.enable {
    # Gradle/JVM heap for native Android builds; mkForce replaces the android module's GRADLE_OPTS.
    GRADLE_OPTS = lib.mkForce "-Dorg.gradle.jvmargs=\"-Xmx4096m -XX:MaxMetaspaceSize=1024m -XX:+HeapDumpOnOutOfMemoryError\" -XX:MaxMetaspaceSize=1024m -Xmx4096m";
    JAVA_TOOL_OPTIONS = "-XX:MaxMetaspaceSize=1024m -Xmx4096m";
    _JAVA_OPTIONS = "-XX:MaxMetaspaceSize=1024m -Xmx4096m";
  };

  # --- Scripts (developer entry points) --------------------------------------
  scripts.dev.exec = ''
    # Run backend + the RN web app (apps/mobile via react-native-web) together with reload.
    echo "Starting atlas-server (cargo watch) and the Expo web dev server..."
    ${pkgs.cargo-watch}/bin/cargo-watch -x 'run -p atlas-server' &
    (cd apps/mobile && bun install && EXPO_PUBLIC_API_URL="''${EXPO_PUBLIC_API_URL:-http://localhost:8080}" bun run web)
  '';
  # Release helper: bump the version across ALL manifests in lockstep (the "version the manifests"
  # rule). `version:bump 0.13.4` sets an explicit version; `version:bump patch|minor|major` steps it.
  # Then commit `chore(release): vX.Y.Z` and tag `vX.Y.Z` to release.
  scripts."version:bump".exec = ''bash "$DEVENV_ROOT/scripts/bump-version.sh" "$@"'';
  # Mobile (React Native + Expo). `mobile:dev` starts the Metro dev server -- scan the QR with
  # Expo Go on the phone. `--tunnel` when the phone isn't on the same LAN as this machine. No
  # Android SDK / Xcode needed for this path; real store builds go through EAS.
  #
  # `REACT_NATIVE_PACKAGER_HOSTNAME` publishes this machine's Tailscale IP in the QR, for a phone
  # that reaches it over a tailnet -- e.g. one routing its traffic through a Tailscale exit node.
  # Without it Expo publishes the LAN IP (192.168.x.x), which such a phone sends through the exit
  # node; it can't hairpin back to the LAN, so Expo Go shows "request timed out". A tailnet peer
  # address is reachable directly (exit nodes route internet only, not tailnet peers). Sits behind
  # `command -v tailscale` so a box without Tailscale just gets plain `bun run start`.
  #
  # Note the terminal still prints `Waiting on http://localhost:<port>` -- that is the local
  # convenience link, not what the phone is told. The QR / manifest `bundleUrl` carries the hostname
  # exported here.
  scripts."mobile:dev".exec = ''
    ts_ip="$(command -v tailscale >/dev/null 2>&1 && tailscale ip -4 2>/dev/null || true)"
    export REACT_NATIVE_PACKAGER_HOSTNAME="''${REACT_NATIVE_PACKAGER_HOSTNAME:-$ts_ip}"
    export EXPO_PUBLIC_API_URL="''${EXPO_PUBLIC_API_URL:-http://localhost:8080}"
    cd apps/mobile && bun run start "$@"
  '';
  # `web:dev` -- run the RN-web app (apps/mobile via react-native-web) locally, end to end, in one
  # command: Postgres (started if not already up) -> migrations -> the Axum API server -> the Expo
  # web dev server pointed at that local API. Ctrl-C stops what this script started (a Postgres from a
  # separate `devenv up` is left alone). Open the URL Expo prints (usually http://localhost:8081),
  # sign up, add a task or two, and widen to >=768px for the desktop sidebar. This is the way to see
  # the web-only parity work (right-click menus, drag, hover) that a phone can't show.
  scripts."web:dev".exec = ''
    set -euo pipefail
    api_port="''${PORT:-8080}"
    api_url="http://localhost:$api_port"
    log_dir="''${TMPDIR:-/tmp}"
    pg_pid=""
    server_pid=""
    cleanup() {
      echo; echo ">> Shutting down..."
      [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
      [ -n "$pg_pid" ] && kill "$pg_pid" 2>/dev/null || true
      wait 2>/dev/null || true
    }
    trap cleanup EXIT INT TERM

    # Wait until a TCP port accepts a connection (dependency-free via bash /dev/tcp).
    wait_tcp() {
      host="$1"; port="$2"; name="$3"; tries="''${4:-120}"; i=0
      while [ "$i" -lt "$tries" ]; do
        if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then exec 3>&- 2>/dev/null || true; return 0; fi
        sleep 1; i=$((i + 1))
      done
      echo "!! $name did not become reachable on $host:$port"; return 1
    }

    # 1. Postgres -- reuse a running one, else bring it up (needs `devenv` on PATH).
    if pg_isready -d "$DATABASE_URL" -q 2>/dev/null; then
      echo ">> Postgres already running -- leaving it as is."
    elif command -v devenv >/dev/null 2>&1; then
      echo ">> Starting Postgres (devenv up)... log: $log_dir/atlas-devenv-up.log"
      devenv up >"$log_dir/atlas-devenv-up.log" 2>&1 &
      pg_pid="$!"
      i=0; while [ "$i" -lt 90 ]; do pg_isready -d "$DATABASE_URL" -q 2>/dev/null && break; sleep 1; i=$((i + 1)); done
      pg_isready -d "$DATABASE_URL" -q 2>/dev/null || { echo "!! Postgres did not come up; see $log_dir/atlas-devenv-up.log"; exit 1; }
    else
      echo "!! Postgres is not running and 'devenv' is not on PATH. Run 'devenv up' in another terminal first."; exit 1
    fi
    echo ">> Postgres is up."

    # 2. Migrations.
    echo ">> Applying migrations..."
    sqlx migrate run --source migrations

    # 3. API server -- reuse one already on the port, else start it (CORS unset => any origin allowed,
    # so the Expo origin :8081 can call it with no extra config).
    if (exec 3<>"/dev/tcp/localhost/$api_port") 2>/dev/null; then
      exec 3>&- 2>/dev/null || true
      echo ">> Something is already listening on :$api_port -- reusing it as the API."
    else
      echo ">> Starting atlas-server on $api_url (first compile is slow)... log: $log_dir/atlas-server.log"
      cargo run -p atlas-server >"$log_dir/atlas-server.log" 2>&1 &
      server_pid="$!"
      wait_tcp localhost "$api_port" atlas-server 300 || { echo "!! Server never bound the port; see $log_dir/atlas-server.log"; exit 1; }
    fi
    echo ">> API ready at $api_url"

    # 4. RN-web dev server (foreground; Ctrl-C returns here and the trap cleans up).
    echo ">> Starting the Expo web dev server against $api_url -- open the printed URL (usually http://localhost:8081)."
    echo
    cd apps/mobile
    # EXPO_UNSTABLE_HEADLESS disables the standalone React Native DevTools ("fusebox") shell, whose
    # prebuilt binary can't load on NixOS ("libglib-2.0.so.0: cannot open shared object file" -- the
    # same unpatched-ELF class as the rustup gotcha). It's harmless but noisy, and the web app is
    # debugged in the browser's own devtools, so the shell is useless here anyway. Deliberately NOT
    # set for mobile:dev -- headless there would suppress the QR code the phone needs.
    EXPO_PUBLIC_API_URL="$api_url" EXPO_UNSTABLE_HEADLESS=1 bun run web "$@"
  '';
  scripts."db:migrate".exec = "sqlx migrate run --source migrations";
  scripts."db:reset".exec = "sqlx database reset -y --source migrations";
  # `screenshots` -- regenerate docs/screenshots: a release server on a throwaway database serves a
  # fresh web export on :8090, and scripts/screenshots.mjs seeds a demo account and captures it in
  # headless Chromium (from the flake's nixpkgs). Needs Postgres (`devenv up -d`).
  scripts."screenshots".exec = ''
    set -euo pipefail
    pg_isready -d "$DATABASE_URL" -q || { echo "!! Postgres is not running; run 'devenv up -d' first."; exit 1; }
    work="$(mktemp -d)"
    server_pid=""
    db="''${DATABASE_URL%/*}/atlas_screenshots"
    cleanup() {
      [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
      psql "$DATABASE_URL" -qc 'DROP DATABASE IF EXISTS atlas_screenshots' || true
      rm -rf "$work"
    }
    trap cleanup EXIT
    psql "$DATABASE_URL" -qc 'DROP DATABASE IF EXISTS atlas_screenshots' -c 'CREATE DATABASE atlas_screenshots'
    cargo build --release -p atlas-server
    (cd apps/mobile && EXPO_PUBLIC_API_URL=/api bunx expo export --platform web --output-dir "$work/web")
    DATABASE_URL="$db" JWT_SECRET="$(head -c 48 /dev/urandom | base64)" PORT=8090 STATIC_DIR="$work/web" \
      ./target/release/atlas-server >"$work/server.log" 2>&1 &
    server_pid="$!"
    until curl -sf http://localhost:8090/api/health >/dev/null; do sleep 1; done
    chromium="$(nix build --inputs-from . --no-link --print-out-paths nixpkgs#chromium)/bin/chromium"
    # devenv's LD_LIBRARY_PATH points Chromium at libraries from another glibc.
    env -u LD_LIBRARY_PATH CHROMIUM="$chromium" BASE_URL=http://localhost:8090 node scripts/screenshots.mjs
    nix run --inputs-from . nixpkgs#pngquant -- --force --ext .png --quality 80-95 --skip-if-larger docs/screenshots/*.png
  '';
  # Named test:all -- a script called "test" collides with the shell builtin, so `devenv shell
  # test` silently exits 0 instead of running this.
  # `set -e` so any failing step fails the script, not just the last one.
  scripts."test:all".exec = ''
    set -euo pipefail
    cargo nextest run --workspace
    # `--bun` runs vitest itself under Bun's runtime (supported since Bun 1.4), matching CI.
    (cd packages/client-core && bunx --bun vitest run)
    (cd packages/shared && bunx --bun vitest run)
    (cd apps/electron && bunx --bun vitest run)
    (cd apps/mobile && bun run test)
  '';
  # ESLint (`eslint.config.mjs`) and `prettier --check` cover the TypeScript packages and apps, as
  # in CI's `Lint (TypeScript)`.
  # One command per line: under `set -e` a failure on the left of `&&` would not stop the script.
  scripts.lint.exec = ''
    set -euo pipefail
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets --no-deps -- -D warnings
    (cd packages/shared && bun run typecheck)
    (cd apps/mobile && bun run typecheck)
    bunx eslint .
    bunx prettier --check .
    # nix/bun.nix must match bun.lock, or the flake's web-dist/atlas-desktop builds fail offline.
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
  scripts."build:ios".exec = "cd 'apps/mobile' && bunx eas-cli build --profile preview --platform ios \"$@\"";
  scripts."build:ios:local".exec = "cd 'apps/mobile' && bunx eas-cli build --profile preview --platform ios --local \"$@\"";
  scripts."update:ios".exec = "cd 'apps/mobile' && bunx eas-cli update --channel preview \"$@\"";
  scripts."build:android".exec = "cd 'apps/mobile' && bunx eas-cli build --profile preview --platform android \"$@\"";
  # The --local builds and Gradle run on this machine, so they need the (opt-in) Android SDK.
  scripts."build:android:local".exec = requireAndroid + ''
    cd apps/mobile && bunx eas-cli build --profile preview --platform android --local "$@"
  '';
  scripts."build:android:aab".exec = requireAndroid + ''
    cd apps/mobile && EAS_BUILD_NO_EXPO_GO_WARNING=true bunx eas-cli build --profile production --platform android --local "$@"
  '';
  scripts."bundle:android:release".exec = requireAndroid + ''
    cd apps/mobile/android && ./gradlew bundleRelease "$@"
  '';
  # The last release build's permissions against docs/android-permissions.md (release.yml runs it too).
  scripts."android:permissions".exec = ''node "$DEVENV_ROOT/apps/mobile/scripts/check-android-permissions.mjs" "$@"'';
  scripts."update:android".exec = "cd 'apps/mobile' && bunx eas-cli update --channel preview --platform android \"$@\"";
  scripts."clean:mobile".exec = "cd 'apps/mobile' && bun run clean";
  scripts."clean:all".exec = "cargo clean && (cd apps/mobile && bun run clean) && rm -rf apps/mobile/node_modules/.cache";

  # Desktop (Electron)
  scripts."desktop:dev".exec = ''
    set -euo pipefail
    api_port="''${PORT:-8080}"
    api_url="http://localhost:$api_port"
    log_dir="''${TMPDIR:-/tmp}"
    pg_pid=""
    server_pid=""
    expo_pid=""
    cleanup() {
      echo; echo ">> Shutting down desktop dev environment..."
      [ -n "$expo_pid" ] && kill "$expo_pid" 2>/dev/null || true
      [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
      [ -n "$pg_pid" ] && kill "$pg_pid" 2>/dev/null || true
      wait 2>/dev/null || true
    }
    trap cleanup EXIT INT TERM

    # 1. Postgres -- reuse a running one, else bring it up
    if pg_isready -d "$DATABASE_URL" -q 2>/dev/null; then
      echo ">> Postgres already running -- leaving it as is."
    elif command -v devenv >/dev/null 2>&1; then
      echo ">> Starting Postgres (devenv up)... log: $log_dir/atlas-devenv-up.log"
      devenv up >"$log_dir/atlas-devenv-up.log" 2>&1 &
      pg_pid="$!"
      i=0; while [ "$i" -lt 90 ]; do pg_isready -d "$DATABASE_URL" -q 2>/dev/null && break; sleep 1; i=$((i + 1)); done
      pg_isready -d "$DATABASE_URL" -q 2>/dev/null || { echo "!! Postgres did not come up; see $log_dir/atlas-devenv-up.log"; exit 1; }
    else
      echo "!! Postgres is not running and 'devenv' is not on PATH. Run 'devenv up' in another terminal first."; exit 1
    fi
    echo ">> Postgres is up."

    # 2. Migrations
    echo ">> Applying migrations..."
    sqlx migrate run --source migrations

    # 3. API server
    if (exec 3<>"/dev/tcp/localhost/$api_port") 2>/dev/null; then
      exec 3>&- 2>/dev/null || true
      echo ">> API server already running on :$api_port"
    else
      echo ">> Starting atlas-server on $api_url... log: $log_dir/atlas-server.log"
      cargo run -p atlas-server >"$log_dir/atlas-server.log" 2>&1 &
      server_pid="$!"
      i=0; while [ "$i" -lt 120 ]; do (exec 3<>"/dev/tcp/localhost/$api_port") 2>/dev/null && { exec 3>&- 2>/dev/null || true; break; }; sleep 1; i=$((i + 1)); done
    fi

    # 4. Build @atlas/electron
    echo ">> Building @atlas/electron..."
    (cd apps/electron && bun run build)

    # 5. Start Metro web dev server in background if not already running on :8081
    if (exec 3<>"/dev/tcp/localhost/8081") 2>/dev/null; then
      exec 3>&- 2>/dev/null || true
      echo ">> Metro dev server already running on :8081"
    else
      echo ">> Starting Expo web dev server... log: $log_dir/atlas-expo-web.log"
      (cd apps/mobile && EXPO_PUBLIC_API_URL="$api_url" EXPO_UNSTABLE_HEADLESS=1 bun run web) >"$log_dir/atlas-expo-web.log" 2>&1 &
      expo_pid="$!"
      i=0; while [ "$i" -lt 120 ]; do (exec 3<>"/dev/tcp/localhost/8081") 2>/dev/null && { exec 3>&- 2>/dev/null || true; break; }; sleep 1; i=$((i + 1)); done
    fi

    echo ">> Launching Atlas Todo desktop app..."
    # devenv's LD_LIBRARY_PATH points Electron at libraries built against another glibc.
    (cd apps/electron && env -u LD_LIBRARY_PATH "${pkgs.electron}/bin/electron" dist/main.js --dev "$@")
  '';

  scripts."desktop:start".exec = ''
    set -euo pipefail
    echo ">> Exporting web bundle..."
    (cd apps/mobile && bun run export:web)
    echo ">> Building @atlas/electron..."
    (cd apps/electron && bun run build)
    echo ">> Starting Atlas Todo desktop..."
    # devenv's LD_LIBRARY_PATH points Electron at libraries built against another glibc.
    (cd apps/electron && env -u LD_LIBRARY_PATH "${pkgs.electron}/bin/electron" dist/main.js "$@")
  '';
  scripts."desktop:package".exec = ''bash "$DEVENV_ROOT/scripts/package-desktop.sh" "$@"'';
  # Refresh nix/flake.desktop.lock, the nixpkgs pin shipped inside the desktop tarball's flake.
  # The template is not named flake.nix, so it is locked from a temporary copy.
  scripts."desktop:flake-update".exec = ''
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    cp "$DEVENV_ROOT/nix/flake.desktop.nix" "$tmp/flake.nix"
    cp "$DEVENV_ROOT/nix/flake.desktop.lock" "$tmp/flake.lock"
    nix flake update --flake "path:$tmp"
    cp "$tmp/flake.lock" "$DEVENV_ROOT/nix/flake.desktop.lock"
  '';
  # Regenerate nix/bun.nix (the flake's npm dependency set, read by bun2nix) from bun.lock, with
  # the bun2nix version the flake locks. Run after every change to bun.lock; `lint` checks it.
  scripts."nix:bun-lock".exec = ''
    set -euo pipefail
    cd "$DEVENV_ROOT"
    nix run --inputs-from . bun2nix -- -c ../ -o nix/bun.nix
  '';

  # Android Emulator workflow scripts
  scripts."emulator:create".exec = requireAndroid + ''
    echo ">> Checking/creating Android Virtual Device (pixel-11-pro)..."
    if avdmanager list avd | grep -q "Name: pixel-11-pro"; then
      echo ">> AVD 'pixel-11-pro' already exists."
    else
      echo "no" | avdmanager create avd \
        --force \
        --name pixel-11-pro \
        --package 'system-images;android-34;google_apis_playstore;x86_64' \
        --device 'pixel_7_pro'
      ini_file="$HOME/.android/avd/pixel-11-pro.ini"
      if [ -f "$ini_file" ]; then
        echo "avd.ini.displayname=Pixel 11 Pro" >> "$ini_file"
      fi
      echo ">> AVD 'pixel-11-pro' (Pixel 11 Pro) created successfully."
    fi
  '';
  scripts."emulator:start".exec = requireAndroid + ''
    if ! avdmanager list avd | grep -q "Name: pixel-11-pro"; then
      echo ">> AVD not found. Creating..."
      emulator:create
    fi
    export LD_LIBRARY_PATH="$ANDROID_HOME/emulator/lib64:$ANDROID_HOME/emulator/lib64/qt/lib:''${LD_LIBRARY_PATH:-}"
    echo ">> Starting Android emulator (Pixel 11 Pro)..."
    emulator -avd pixel-11-pro -gpu host "$@"
  '';
  scripts."emulator:headless".exec = requireAndroid + ''
    if ! avdmanager list avd | grep -q "Name: pixel-11-pro"; then
      echo ">> AVD not found. Creating..."
      emulator:create
    fi
    export LD_LIBRARY_PATH="$ANDROID_HOME/emulator/lib64:$ANDROID_HOME/emulator/lib64/qt/lib:''${LD_LIBRARY_PATH:-}"
    echo ">> Starting headless Android emulator (Pixel 11 Pro)..."
    emulator -avd pixel-11-pro -no-window -no-audio -gpu off "$@"
  '';
  scripts."mobile:android".exec = requireAndroid + ''
    set -euo pipefail
    api_port="''${PORT:-8080}"
    api_url="http://localhost:$api_port"
    log_dir="''${TMPDIR:-/tmp}"
    pg_pid=""
    server_pid=""
    cleanup() {
      echo; echo ">> Shutting down..."
      [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
      [ -n "$pg_pid" ] && kill "$pg_pid" 2>/dev/null || true
      wait 2>/dev/null || true
    }
    trap cleanup EXIT INT TERM

    # Wait until a TCP port accepts a connection (dependency-free via bash /dev/tcp).
    wait_tcp() {
      host="$1"; port="$2"; name="$3"; tries="''${4:-120}"; i=0
      while [ "$i" -lt "$tries" ]; do
        if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then exec 3>&- 2>/dev/null || true; return 0; fi
        sleep 1; i=$((i + 1))
      done
      echo "!! $name did not become reachable on $host:$port"; return 1
    }

    # 1. Postgres -- reuse a running one, else bring it up.
    if pg_isready -d "$DATABASE_URL" -q 2>/dev/null; then
      echo ">> Postgres already running -- leaving it as is."
    elif command -v devenv >/dev/null 2>&1; then
      echo ">> Starting Postgres (devenv up)... log: $log_dir/atlas-devenv-up.log"
      devenv up >"$log_dir/atlas-devenv-up.log" 2>&1 &
      pg_pid="$!"
      i=0; while [ "$i" -lt 90 ]; do pg_isready -d "$DATABASE_URL" -q 2>/dev/null && break; sleep 1; i=$((i + 1)); done
      pg_isready -d "$DATABASE_URL" -q 2>/dev/null || { echo "!! Postgres did not come up; see $log_dir/atlas-devenv-up.log"; exit 1; }
    else
      echo "!! Postgres is not running and 'devenv' is not on PATH. Run 'devenv up' in another terminal first."; exit 1
    fi
    echo ">> Postgres is up."

    # 2. Migrations.
    echo ">> Applying migrations..."
    sqlx migrate run --source migrations

    # 3. API server -- reuse one already on the port, else start it.
    if (exec 3<>"/dev/tcp/localhost/$api_port") 2>/dev/null; then
      exec 3>&- 2>/dev/null || true
      echo ">> Something is already listening on :$api_port -- reusing it as the API."
    else
      echo ">> Starting atlas-server on $api_url (first compile is slow)... log: $log_dir/atlas-server.log"
      cargo run -p atlas-server >"$log_dir/atlas-server.log" 2>&1 &
      server_pid="$!"
      wait_tcp localhost "$api_port" atlas-server 300 || { echo "!! Server never bound the port; see $log_dir/atlas-server.log"; exit 1; }
    fi
    echo ">> API ready at $api_url"

    # 4. Reverse ports to Android device/emulator
    adb reverse tcp:8081 tcp:8081 2>/dev/null || true
    adb reverse tcp:8080 tcp:8080 2>/dev/null || true

    # 5. Start Android app
    echo ">> Starting Android app against $api_url..."
    cd apps/mobile
    EXPO_PUBLIC_API_URL="$api_url" EXPO_UNSTABLE_HEADLESS=1 bun run android "$@"
  '';

  enterShell = ''
    if [ -n "''${DEVENV_PROFILE:-}" ]; then
      export PATH="$DEVENV_PROFILE/bin:$PATH"
    fi
    echo "Atlas Todo dev shell -- rust $(rustc --version 2>/dev/null | cut -d' ' -f2), node $(node --version)"
    echo "Scripts: dev, web:dev, db:migrate, db:reset, test:all, lint, fmt (run 'devenv up' for Postgres)"
    if [ -n "''${ANDROID_HOME:-}" ]; then
      echo "Android: emulator:start, mobile:android, build:android:local, bundle:android:release"
    else
      echo "Android SDK off -- enable it with a devenv.local.nix containing { android.enable = true; }"
    fi
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
