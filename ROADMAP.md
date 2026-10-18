# Roadmap

Atlas Todo is a to-do app whose server cannot read your data, that you can run yourself, and that
works offline on every device you use. Everything below serves that; a feature that needs the
server to see plaintext is out, however useful.

This is a direction, not a schedule. It is maintained by one person in their spare time.

## Next

- **Google Play, public:** finish the closed test and open the listing
  ([help test it](./README.md#help-test-it-on-android)).
- **Encrypted export:** a password-protected backup file next to today's plaintext JSON export.
- **Accessibility:** the gaps in [ACCESSIBILITY.md](./ACCESSIBILITY.md#known-gaps).
- **Importers:** more sources next to TickTick and Todoist, as people ask for them.

## Before 1.0

- **A stable sync protocol** with a compatibility promise across minor versions
  ([sync-protocol.md](./docs/sync-protocol.md) is unstable until then).
- **An independent review of the cryptography.** Until then, [SECURITY.md](./SECURITY.md) lists
  what is and is not protected.

## Later, maybe

- Desktop builds for macOS and Windows (the Electron shell is Linux-only today).
- A published iOS build (it builds today, but needs an Apple developer account to ship).
- A CalDAV bridge that runs on a device, where the keys are ([decision 0002](./docs/decisions/0002-no-caldav.md)).

## Not planned

- **Server-side features that need plaintext**, such as server-side search, email digests of task
  content or a server-run CalDAV endpoint ([decision 0002](./docs/decisions/0002-no-caldav.md)).
- **Separate native UIs per platform**; there is one React Native UI
  ([decision 0005](./docs/decisions/0005-one-react-native-ui.md)).
- **Running several server instances behind a load balancer.** One instance serves a household or
  a small team.
- **Telemetry or analytics** of any kind.

Want something that isn't here? Start a thread in
[Discussions → Ideas](https://github.com/atlastodo/atlas/discussions/categories/ideas) first.
