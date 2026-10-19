## v0.1.11-rc.8

Atlas Vault arrives in core: enable it with `ATLAS_APPS=todo,vault` and use it with `atlas vault` (see `docs/integrations.md`). Vault API tokens must expire within a year and are read-only unless made with write access; the server enforces both. Existing API tokens are unchanged.

### Features
- VaultClient for Atlas Vault tokens
- Atlas Vault item rules at parity with the Rust client
- Bundle the Atlas Vault manifest, its kinds and token policies
- Atlas vault commands over a vault session
- Atlas Vault items and folders over a vault session
- API tokens that expire and read-only tokens, as app manifests ask
- Bundle the Atlas Vault manifest, its kinds and API token policies
- Type the journal's entity kinds

### Documentation
- Atlas Vault, its item schema, CLI commands and token policies
