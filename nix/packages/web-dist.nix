# The exported web SPA (React Native Web via `expo export`), built from source.
# This is what services.atlas.staticDir points at, and what atlas-desktop
# wraps in Electron.
{
  lib,
  stdenv,
  callPackage,
  bun2nix,
  nodejs_26,
  version,
}:

stdenv.mkDerivation {
  pname = "atlas-web-dist";
  inherit version;

  src = callPackage ./js-source.nix { };

  nativeBuildInputs = [
    bun2nix.hook
    nodejs_26
  ];

  # Regenerate nix/bun.nix whenever bun.lock changes (the `nix:bun-lock`
  # devenv script).
  bunDeps = bun2nix.fetchBunDeps { bunNix = ../bun.nix; };

  # Same environment as scripts/package-desktop.sh: no API URL baked in (it is
  # typed on the sign-in screen), no telemetry, non-interactive.
  env = {
    EXPO_PUBLIC_API_URL = "";
    CI = "1";
    EXPO_NO_TELEMETRY = "1";
    ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
  };

  dontUseBunBuild = true;
  dontUseBunCheck = true;
  dontUseBunInstall = true;

  buildPhase = ''
    runHook preBuild

    export HOME="$TMPDIR"
    cd apps/mobile
    node node_modules/expo/bin/cli export --platform web --clear
    node scripts/postexport-favicon.mjs
    cd ../..

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    cp -r apps/mobile/dist "$out"

    runHook postInstall
  '';

  meta = {
    description = "Atlas Todo web app (React Native Web export)";
    homepage = "https://github.com/atlastodo/atlas-todo";
    license = lib.licenses.agpl3Only;
    platforms = lib.platforms.linux;
  };
}
