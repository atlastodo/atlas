## v0.1.11

This repository is now **atlastodo/atlas**, the Atlas core: the sync server, the Docker image, the `atlas` CLI and the `@atlastodo/*` packages. The todo app lives in [atlastodo/atlas-todo](https://github.com/atlastodo/atlas-todo), and this image serves its v0.1.11 web build.

**For self-hosters**
- **New image name:** `ghcr.io/atlastodo/atlas` (Docker Hub: `atlastodo/atlas`). The old `atlas-todo` names keep receiving the same tags for now; switch when convenient.
- **NixOS:** use the flake input `github:atlastodo/atlas` and `services.atlas`. `services.atlas-todo` still works, with a warning. The old input name now points to the app repository, so change it before updating your lock. The unit, user, data directory and database keep their `atlas-todo` names.
- **Migrations** run on start. Accounts move to a root key the next time they sign in or unlock; nothing to do by hand.
- **Apps:** `ATLAS_APPS` chooses what the instance offers, and the default stays `todo`. `GET /discovery` reports the server's apps and capabilities.

**New**
- **Passkeys** for sign-in and unlock.
- **Personal API tokens and the `atlas` CLI**, released as static binaries, for integrations such as n8n. Tokens can expire and be read-only. A token for an app with a strict policy (the vault) must expire within a year, is read-only unless made with write access, and is for that app alone.
- **`@atlastodo/client-core`, `@atlastodo/shared` and `@atlastodo/sdk` on npm,** published with provenance.
- **`secretspec-provider-atlas`,** an experimental SecretSpec provider, for the vault app.
- **The journal and vault app kinds**, which are opt-in through `ATLAS_APPS` and still experimental.

### Features
- `sealPersistence`, a local op log encrypted at rest
- `secretspec-provider-atlas`, a SecretSpec provider for Atlas Vault
- Vault tokens are for the vault alone, and expired tokens lose their keys
- VaultClient for Atlas Vault tokens
- Atlas Vault item rules at parity with the Rust client
- Bundle the Atlas Vault manifest, its kinds and token policies
- Atlas vault commands over a vault session
- Atlas Vault items and folders over a vault session
- API tokens that expire and read-only tokens, as app manifests ask
- Bundle the Atlas Vault manifest, its kinds and API token policies
- Type the journal's entity kinds
- Rename the NixOS option to services.atlas
- Core package and web app tarballs, pinnable web build
- Publishable @atlastodo/client-core, shared and sdk
- Atlas journal entries commands over a journal session
- App-scoped token sessions and Atlas Journal entries
- Enable an app with its own keys, app-scoped sync and token app keys
- App-scoped sync, owner-only journal and app-scoped API tokens
- Bundle the Atlas Journal manifest and its entity kinds
- Passkeys on the web and Android
- Passkey ceremonies, slot keys and passkey proofs
- Passkeys that sign in and unlock the root key
- Ship the atlas CLI as static binaries, retire the JavaScript CLI
- The atlas CLI in Rust, at parity with the TypeScript one
- The task rules in the Rust client, with shared fixtures
- API-token sessions, sync and key hydration in the Rust client
- Rust client crypto at parity with client-core
- Advertise the root key in discovery
- Check the server's discovery before signing in or up
- Typed getDiscovery and a server compatibility check
- Per-instance and per-account apps, and GET /discovery
- Bundled app manifests own the plaintext-field policy
- Sign up with a root key and migrate accounts at sign-in or unlock
- Open account keys through the root key and migrate accounts to it
- Account root key slots and per-app keys
- Atlas SDK and CLI for integrations such as n8n
- Settings > API tokens
- API token format, key wraps and client methods
- Personal API tokens for integrations
- Ship third-party licence notices and check JS licences in lint
- Thank contributors in the release notes

### Fixes
- Store app keys only for bundled apps the instance offers
- Android SDK platform and build-tools 37 for Expo SDK 58
- Allow insecure content only for an http server
- Linear-time regexes for synced rules, stack traces and Todoist imports
- Read dates against the client's clock
- Rustls 0.23.46 for RUSTSEC-2026-0346..0349
- Type pathImpl as typeof path for @types/node 26.6.5
- Raise grey text, placeholder and emerald/amber accent contrast to 4.5:1
- Show the licence as AGPL-3.0-only in About
- Keep the web page's language on the UI language for screen readers

### Documentation
- Sealed local stores
- Resolve SecretSpec secrets from Atlas Vault
- Atlas Vault, its item schema, CLI commands and token policies
- Describe core without the app, add docs/releasing.md
- The repository split runbook, core package pinning and the web pin
- Atlas Journal CLI commands, entry schema and app-scoped tokens
- App-scoped sync, Atlas Journal and app-scoped API tokens
- Passkeys in the architecture notes, security policy and README
- The Rust client and CLI in the layout and test notes
- The account root key, its slots and the per-app keys
- API tokens, the atlas CLI and n8n recipes
- How to try it and get help, no telemetry, update checks, copyright
- Accessibility statement, issue form and PR checklist item
- A roadmap, support expectations and the project's scope
- Restore the Contributor Covenant enforcement ladder
- Response times, fix and disclosure process

### Maintenance
- 4 dependency updates, 29 maintenance commits (CI, build, tests) ([full list](https://github.com/atlastodo/atlas/compare/v0.1.10...v0.1.11))
