## v0.1.21

### Breaking
- `atlas-client` moves to jiff 1.0: its `TimeZone` (`zoned_parts`, `AtlasClient::time_zone`) is jiff 1.0's, so dependents need `jiff = "1.0"`

### Fixes
- Don't size push's op-id map from the request

### Documentation
- Rules for writing tests

### Maintenance
- 6 dependency updates, 3 maintenance commits (CI, build, tests) ([full list](https://github.com/atlastodo/atlas/compare/v0.1.20...v0.1.21))
