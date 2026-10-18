## v0.1.11-rc.7

This repository is now **atlastodo/atlas**, the Atlas core: the sync server, the Docker image, the `atlas` CLI and the `@atlastodo/*` packages. The todo app moved to [atlastodo/atlas-todo](https://github.com/atlastodo/atlas-todo), and the image serves its pinned web build (v0.1.11-rc.6).

- The image is now `ghcr.io/atlastodo/atlas` and `atlastodo/atlas` on Docker Hub. The old `atlas-todo` names keep receiving the same tags for now; switch when convenient.
- NixOS: use `services.atlas` and `github:atlastodo/atlas` as the flake input. `services.atlas-todo` still works, with a warning.
- The core packages are on npm: `@atlastodo/client-core`, `@atlastodo/shared`, `@atlastodo/sdk`.

### Features
- Rename the NixOS option to services.atlas

### Documentation
- Describe core without the app, add docs/releasing.md

### Maintenance
- 7 maintenance commits (CI, build, tests) ([full list](https://github.com/atlastodo/atlas/compare/v0.1.11-rc.5...v0.1.11-rc.7))
