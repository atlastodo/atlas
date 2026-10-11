# 0005: One React Native UI, wrapped in Electron on desktop

## Decision

`apps/mobile` is the only UI. It runs natively on Android (and iOS) with Expo, in the browser
through react-native-web, and on the desktop as the web export inside Electron (`apps/electron`).

## Why

- **One codebase for every platform** keeps a single maintainer's feature work from multiplying
  by three. The local store, sync client and encryption (`packages/client-core`) are shared as is.
- **The web app is served by the self-hosted server**, so every instance has a client with no
  install, and the desktop app is that same build.
- **Electron over Tauri:** the desktop app needs the same JavaScript engine and web APIs the web
  build is tested against (IndexedDB, WebCrypto). A system webview differs per platform and per
  version, which would make the desktop a fourth target to test.

## Costs

- The web and desktop UI is only as good as react-native-web: keyboard handling and some web
  conventions take extra work.
- Electron is large, and its updates are the project's responsibility (`apps/electron`'s updater
  verifies a release checksum before installing).
- The app depends on Expo's toolchain and release cadence.
