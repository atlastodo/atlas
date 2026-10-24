# Multi-stage build for the Atlas server image: the Axum sync server plus the Atlas Todo web app.
#
# The web app is not built here (it lives in atlastodo/atlas-todo): the image serves a released
# web build, an atlas-todo-web-X.Y.Z.tar.gz asset (one top-level directory holding the static
# files), checked against its SHA-256 before it is unpacked. By default that is the "todo" pin in
# apps.lock.json (set with scripts/pin-app-web.mjs), with the app release's THIRD_PARTY_NOTICES.txt
# next to it. To serve another build, pass it explicitly (the notices are optional then):
#   docker build -f docker/Dockerfile \
#     --build-arg TODO_WEB_URL=https://.../atlas-todo-web-X.Y.Z.tar.gz \
#     --build-arg TODO_WEB_SHA256=<sha256 of that file> \
#     [--build-arg TODO_WEB_NOTICES_URL=https://.../THIRD_PARTY_NOTICES.txt \
#      --build-arg TODO_WEB_NOTICES_SHA256=<sha256 of that file>] .
#
# Toolchain pin -- bump it together with devenv (devenv.lock) and CI:
#   rust:1.99    must stay >= rust-version in Cargo.toml

# Stage 1: the pinned web build, verified, into /web and its notices into /web-notices. It is the
# same for every architecture, so a multi-arch build runs it once on the build host.
FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS web
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl jq \
    && rm -rf /var/lib/apt/lists/*
COPY apps.lock.json /tmp/apps.lock.json
ARG TODO_WEB_URL
ARG TODO_WEB_SHA256
ARG TODO_WEB_NOTICES_URL
ARG TODO_WEB_NOTICES_SHA256
# Each checksum is required and checked before a byte is used, so the pin (not whoever serves the
# URL) decides what ships. GNU tar refuses absolute and ".." member names.
RUN set -eu; \
    lock=/tmp/apps.lock.json; \
    if [ -z "${TODO_WEB_URL:-}" ]; then \
      TODO_WEB_URL="$(jq -er '.todo.url' "$lock")" \
        || { echo "apps.lock.json has no todo pin; run scripts/pin-app-web.mjs or pass TODO_WEB_URL" >&2; exit 1; }; \
      TODO_WEB_SHA256="$(jq -er '.todo.sha256' "$lock")"; \
      TODO_WEB_NOTICES_URL="$(jq -r '.todo.notices.url // empty' "$lock")"; \
      TODO_WEB_NOTICES_SHA256="$(jq -r '.todo.notices.sha256 // empty' "$lock")"; \
    fi; \
    fetch() { \
      if ! printf '%s' "$2" | grep -Eqx '[0-9a-f]{64}'; then \
        echo "$1: the SHA-256 must be 64 lowercase hex digits, got '$2'" >&2; exit 1; \
      fi; \
      curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$3" "$1"; \
      echo "$2  $3" | sha256sum -c -; \
    }; \
    fetch "$TODO_WEB_URL" "${TODO_WEB_SHA256:-}" /tmp/web.tar.gz; \
    mkdir /web /web-notices; \
    tar -xzf /tmp/web.tar.gz -C /web --strip-components=1 --no-same-owner --no-same-permissions; \
    rm /tmp/web.tar.gz; \
    test -f /web/index.html || { echo "$TODO_WEB_URL has no index.html in its top directory" >&2; exit 1; }; \
    if [ -n "${TODO_WEB_NOTICES_URL:-}" ]; then \
      fetch "$TODO_WEB_NOTICES_URL" "${TODO_WEB_NOTICES_SHA256:-}" /web-notices/THIRD_PARTY_NOTICES.txt; \
    else \
      echo "warning: no TODO_WEB_NOTICES_URL; the image carries no notices for the web app" >&2; \
    fi

# Stage 2: Compile the Rust backend binary
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

# Stage 3: Slim runtime image
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
COPY --from=web /web /app/dist
COPY migrations /app/migrations
# The licence and, in CI builds, the server's third-party notices (the glob lets a local build go
# without); the web app's own notices, from its release, under web/.
COPY LICENSE THIRD_PARTY_NOTICES.tx[t] /usr/share/doc/atlas-todo/
COPY --from=web /web-notices/ /usr/share/doc/atlas-todo/web/

ENV PORT=8080
ENV STATIC_DIR=/app/dist
ENV RUST_LOG=info
VOLUME /app/data
USER atlas
EXPOSE 8080
# Shell form, so the probe follows a PORT set at run time.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
    CMD curl -fsS "http://localhost:${PORT:-8080}/health" || exit 1
CMD ["atlas-server"]
