# Multi-stage build for the Atlas server image: the Axum sync server alone.
#
# No app's web build is in it. An app that has one publishes its own image on top of this one
# (ghcr.io/atlastodo/atlas-todo: this image plus the Atlas Todo web app); any other web build is
# served by pointing STATIC_DIR at it (a mounted directory). Without one the server is API only.
#
# Toolchain pin -- bump it together with devenv (devenv.lock) and CI:
#   rust:1.99    must stay >= rust-version in Cargo.toml

# Stage 1: Compile the Rust backend binary
FROM rust:1.99-bookworm AS server-builder
WORKDIR /app

# The image's own Rust only provides rustup: the build uses the one rust-toolchain.toml pins, as CI,
# devenv and the flake do.
COPY rust-toolchain.toml ./
RUN rustup toolchain install --no-self-update

# Cache dependencies: copy manifests first.
COPY Cargo.toml Cargo.lock ./
COPY crates/atlas-core/Cargo.toml crates/atlas-core/Cargo.toml
COPY crates/atlas-server/Cargo.toml crates/atlas-server/Cargo.toml

# Dummy sources so the dependencies compile into a cached layer. `|| true`: the stubs themselves
# may not link; only the dependency artifacts matter here.
RUN mkdir -p crates/atlas-core/src crates/atlas-server/src \
    && echo "pub fn _stub() {}" > crates/atlas-core/src/lib.rs \
    && echo "fn main() {}" > crates/atlas-server/src/main.rs \
    && echo "" > crates/atlas-server/src/lib.rs \
    && cargo build --release --locked -p atlas-server || true

# Real sources, touched so cargo rebuilds over the stubs. migrations/ and manifests/ are embedded
# at compile time.
COPY crates crates
COPY migrations migrations
COPY manifests manifests
RUN touch crates/atlas-core/src/lib.rs crates/atlas-server/src/main.rs crates/atlas-server/src/lib.rs \
    && cargo build --release --locked -p atlas-server

# Stage 2: Slim runtime image
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libssl3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Unprivileged user. /app/data (attachment blobs) is created and owned by it before VOLUME, so a
# new named volume starts out writable by the server.
RUN groupadd --system --gid 10001 atlas \
    && useradd --system --uid 10001 --gid atlas --home-dir /app --no-create-home --shell /usr/sbin/nologin atlas \
    && mkdir -p /app/data \
    && chown atlas:atlas /app/data

COPY --from=server-builder /app/target/release/atlas-server /usr/local/bin/atlas-server
COPY migrations /app/migrations
# The licence and, in CI builds, the server's third-party notices (the glob lets a local build go
# without).
COPY LICENSE THIRD_PARTY_NOTICES.tx[t] /usr/share/doc/atlas/

ENV PORT=8080
ENV RUST_LOG=info
VOLUME /app/data
USER atlas
EXPOSE 8080
# Shell form, so the probe follows a PORT set at run time.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
    CMD curl -fsS "http://localhost:${PORT:-8080}/health" || exit 1
CMD ["atlas-server"]
