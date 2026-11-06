## v0.1.16

### Breaking changes
- Atlas Journal's and Atlas Vault's rules moved to their own repositories, as todo's did. Core no longer releases the `atlas` CLI or `secretspec-provider-atlas`: use `atlas-journal` from https://github.com/atlastodo/atlas-journal/releases and `atlas-vault` and `secretspec-provider-atlas` from https://github.com/atlastodo/atlas-vault/releases (same environment, commands and output; `atlas journal entries list` is `atlas-journal entries list`, `atlas vault get X` is `atlas-vault get X`, and the old app-first forms still work).
- `@atlastodo/shared` is retired: the vault item rules are in `@atlastodo/vault-core`. The SDK's `VaultClient` is now `@atlastodo/vault-core/client`; `atlas_client::journal` and `atlas_client::vault` are `atlas-journal-rules` and `atlas-vault-rules`.

### Features
- Move Atlas Journal's and Atlas Vault's rules out of core

### Fixes
- Adapt passkeys to webauthn-rs 0.6

### Maintenance
- 4 dependency updates, 2 maintenance commits (CI, build, tests) ([full list](https://github.com/atlastodo/atlas/compare/v0.1.15...v0.1.16))
