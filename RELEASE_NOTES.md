## v0.1.15

### Breaking changes
- Core is now an app-agnostic sync engine: an app registers its app definition (`registerApp`) and keeps its rules in its own repository. Todo's rules, models, UI catalogs and SDK client moved to atlastodo/atlas-todo (`@atlastodo/todo-core`).
- The `atlas` CLI no longer has Atlas Todo's commands (`tasks`, `projects`, `labels`, `changes`): use the `atlas-todo` CLI from https://github.com/atlastodo/atlas-todo/releases (same environment, commands and output).
- `@atlastodo/shared` keeps only Atlas Vault's rules; `@atlastodo/client-core` no longer exports the todo models (`Task`, `Project`, …) and `EntityKind` is an open string; the SDK's `AtlasClient` is gone (`TokenSession` is its generic base).

### Features
- App definitions, so core needs no change for an app's kinds and rules
- Instance activity retention, enforced by the clients
- Record every task change as activity, plus project, section and member events, with undo
- Pin the newest app web build automatically

### Fixes
- Stricter app definitions, and no sync without a sharing app's definition
- Review fixes for the activity feed
- Native-speaker review of the Italian catalog
- Fall back to nix run when devenv is not on PATH

### Documentation
- Never mention AI in commits, PRs or releases

### Maintenance
- 3 dependency updates, 4 maintenance commits (CI, build, tests) ([full list](https://github.com/atlastodo/atlas/compare/v0.1.14...v0.1.15))

### Thanks
- @mrCabez
