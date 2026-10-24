# Design decisions

Short records of choices that shape the project, each with what was decided, why, and what it
costs. A new record gets the next number; a reversed decision gets a new record that says which
one it replaces, rather than an edit.

| No.                                         | Decision                                                |
| ------------------------------------------- | ------------------------------------------------------- |
| [0001](./0001-per-field-lww-op-log.md)      | A per-field last-writer-wins op log, not a CRDT library |
| [0002](./0002-no-caldav.md)                 | No CalDAV                                               |
| [0003](./0003-plaintext-routing-fields.md)  | A few routing fields stay plaintext (replaced by 0006)  |
| [0004](./0004-protocol-floor-only-rises.md) | The sync protocol floor only rises                      |
| [0005](./0005-one-react-native-ui.md)       | One React Native UI, wrapped in Electron on desktop     |
| [0006](./0006-opaque-sync-metadata.md)      | Ops carry a scope and opaque field tags                 |
