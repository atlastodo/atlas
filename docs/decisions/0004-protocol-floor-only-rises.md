# 0004: The sync protocol floor only rises

## Decision

Clients send their sync protocol version on every request. The server refuses clients below a
minimum (`MIN_SYNC_PROTOCOL`) with `426 Upgrade Required`, and the app asks the user to update.
When a change would let an older client do harm, the minimum is raised; there is no compatibility
shim for the old behaviour.

## Why

The server cannot read values, so it cannot detect most mistakes an old client makes: writing
under a key a rotation retired, minting its own project key and forking a shared project's
encryption, writing an envelope newer clients refuse. Refusing the old client is the only reliable
guard. Each raise so far fixed one of these ([sync-protocol.md](../sync-protocol.md#versions)).

## Costs

- An old app stops syncing until it is updated. For a manually installed APK,
  that means a manual update before sync resumes.
- A third-party client must keep up with the protocol. Until 1.0 there is no promise of stability
  between minor versions.
