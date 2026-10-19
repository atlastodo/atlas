## v0.1.11-rc.9

- **Vault tokens are for the vault alone:** a token naming the vault and another app is refused (`api_token_app_exclusive`). Expired tokens lose their stored keys within the hour.
- **SecretSpec:** `secretspec-provider-atlas` binaries are attached to this release. They resolve `secretspec.toml` secrets from Atlas Vault; see `docs/integrations.md`.
- **client-core:** `sealPersistence` encrypts a client's local store at rest, for apps that lock.

### Features
- `sealPersistence`, a local op log encrypted at rest
- `secretspec-provider-atlas`, a SecretSpec provider for Atlas Vault
- Vault tokens are for the vault alone, and expired tokens lose their keys

### Documentation
- Sealed local stores
- Resolve SecretSpec secrets from Atlas Vault

### Maintenance
- 1 maintenance commit (CI, build, tests) ([full list](https://github.com/atlastodo/atlas/compare/v0.1.11-rc.8...v0.1.11-rc.9))
