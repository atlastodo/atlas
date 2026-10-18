## v0.1.11-rc.5

### Features
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

### Fixes
- Store app keys only for bundled apps the instance offers
- Android SDK platform and build-tools 37 for Expo SDK 58
- Allow insecure content only for an http server
- Linear-time regexes for synced rules, stack traces and Todoist imports
- Read dates against the client's clock
- Rustls 0.23.46 for RUSTSEC-2026-0346..0349
- Type pathImpl as typeof path for @types/node 26.6.5

### Documentation
- The repository split runbook, core package pinning and the web pin
- Atlas Journal CLI commands, entry schema and app-scoped tokens
- App-scoped sync, Atlas Journal and app-scoped API tokens
- Passkeys in the architecture notes, security policy and README
- The Rust client and CLI in the layout and test notes
- The account root key, its slots and the per-app keys
- API tokens, the atlas CLI and n8n recipes

### Maintenance
- 4 dependency updates and the maintenance commits (CI, build, tests) ([full list](https://github.com/atlastodo/atlas-todo/compare/v0.1.11-rc.1...v0.1.11-rc.5))
