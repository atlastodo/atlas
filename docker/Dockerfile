# Multi-stage build for Atlas Todo (Axum backend + Expo React Native Web frontend).
#
# Toolchain pins -- bump them together with devenv (devenv.lock) and CI:
#   BUN_VERSION  Bun, the package manager: keep equal to BUN_VERSION in .github/workflows/*.yml
#                (the release workflow passes no BUN_VERSION build-arg, so this default ships)
#   rust:1.98    the toolchain CI uses (1.98.1); must stay >= rust-version in Cargo.toml
ARG BUN_VERSION=1.4.2

# Bun comes from its official image instead of a curl|bash installer.
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-debian AS bun

# Stage 1: Build the Expo web frontend. It is the same for every architecture, so a multi-arch
# build runs it once on the build host.
FROM --platform=$BUILDPLATFORM node:26-bookworm-slim AS web-builder
WORKDIR /app
# Bun installs packages; real Node runs Metro.
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx

# Workspace manifests first, so the dependency install is cached until they change.
COPY package.json bun.lock bunfig.toml ./
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/client-core/package.json packages/client-core/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile

COPY packages packages
COPY apps/mobile apps/mobile
# client-core bundles test-vectors/plaintext_fields.json, the field policy it shares with the server.
COPY test-vectors test-vectors
ARG PUBLIC_API_URL=/api
ENV EXPO_PUBLIC_API_URL=$PUBLIC_API_URL
# The About screen's source link: the AGPL offer of the source to every user of the web app. A
# build of modified code should point it at that code (the release workflow passes its own repo).
ARG REPO_URL=https://github.com/atlastodo/atlas-todo
ENV EXPO_PUBLIC_REPO_URL=$REPO_URL
ENV CI=1 EXPO_NO_TELEMETRY=1
RUN cd apps/mobile && bunx expo export --platform web && node scripts/postexport-favicon.mjs

# Stage 2: Compile the Rust backend binary
FROM rust:1.99-bookworm AS server-builder
WORKDIR /app

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

# Real sources, touched so cargo rebuilds over the stubs. migrations/ is embedded at compile time.
COPY crates crates
COPY migrations migrations
RUN touch crates/atlas-core/src/lib.rs crates/atlas-server/src/main.rs crates/atlas-server/src/lib.rs \
    && cargo build --release --locked -p atlas-server

# Stage 3: Slim runtime image
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Unprivileged user. /app/data (attachment blobs) is created and owned by it before VOLUME, so a
# new named volume starts out writable by the server.
RUN groupadd --system --gid 10001 atlas \
    && useradd --system --uid 10001 --gid atlas --home-dir /app --no-create-home --shell /usr/sbin/nologin atlas \
    && mkdir -p /app/data \
    && chown atlas:atlas /app/data

COPY --from=server-builder /app/target/release/atlas-server /usr/local/bin/atlas-server
COPY --from=web-builder /app/apps/mobile/dist /app/dist
COPY migrations /app/migrations

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
