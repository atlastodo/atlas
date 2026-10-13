# The Atlas Todo server, built from the Cargo workspace.
{
  lib,
  rustPlatform,
  version,
}:

let
  root = ../..;
in
rustPlatform.buildRustPackage {
  pname = "atlas-server";
  inherit version;

  # Only what cargo needs: the workspace manifests and lockfile, crates/,
  # migrations/ (embedded at compile time by `sqlx::migrate!`), manifests/ (the
  # bundled app manifests, compiled in by atlas-core) and the
  # test-vectors/ fixtures that the server tests read.
  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + "/Cargo.toml")
      (root + "/Cargo.lock")
      (root + "/crates")
      (root + "/migrations")
      (root + "/manifests")
      (root + "/test-vectors")
    ];
  };

  # Vendored from Cargo.lock (no git dependencies, so no outputHashes).
  cargoLock.lockFile = root + "/Cargo.lock";
  cargoBuildFlags = [
    "-p"
    "atlas-server"
  ];
  # atlas-core's tests are pure; atlas-server's integration tests need a live
  # Postgres and are covered by the VM test and CI instead.
  cargoTestFlags = [
    "-p"
    "atlas-core"
  ];

  meta = {
    description = "Atlas Todo backend: Axum HTTP + WebSocket API over PostgreSQL";
    homepage = "https://github.com/atlastodo/atlas-todo";
    license = lib.licenses.agpl3Only;
    platforms = lib.platforms.linux;
    mainProgram = "atlas-server";
  };
}
