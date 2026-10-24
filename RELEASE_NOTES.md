## v0.1.14-rc.1

**Breaking:** sync protocol 7 hides item kinds, field names and links from the server, and a server
on it refuses older clients. Update the apps and the `atlas` CLI together with the server. Existing
data migrates itself on each client's first sync; see
[Upgrading to sync protocol 7](https://github.com/atlastodo/atlas/blob/dev/docs/self-hosting.md#upgrading-to-sync-protocol-7).

### Features
- Speak sync protocol 7
- Protocol 7 in the shared task rules and the SDK harness
- Migrate protocol 6 rows and seal invite previews
- List the legacy keys a partition still holds
- Route and authorize sync by scope, never by field names
- Protocol 7 wire kinds, sealed field envelope and field tags

### Documentation
- Sync protocol 7 in the protocol, architecture and security docs

### Maintenance
- 1 maintenance commit (CI, build, tests) ([full list](https://github.com/atlastodo/atlas/compare/v0.1.13...v0.1.14-rc.1))
