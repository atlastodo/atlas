# The web SPA from a pinned release asset of atlastodo/atlas-todo (the app is
# not built here): the "todo" pin of apps.lock.json ({ version, url, sha256 }),
# an atlas-todo-web-X.Y.Z.tar.gz holding one top-level directory of static
# files. It is the flake's web-dist; the server image reads the same pin.
{
  lib,
  stdenvNoCC,
  fetchurl,
  pin,
}:

stdenvNoCC.mkDerivation {
  pname = "atlas-web-dist";
  inherit (pin) version;

  src = fetchurl {
    inherit (pin) url;
    # A fixed-output fetch: the pin's hash, not the download host, decides the content.
    sha256 = pin.sha256;
  };

  dontUnpack = true;
  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out"
    tar -xzf "$src" -C "$out" --strip-components=1 --no-same-owner --no-same-permissions
    test -f "$out/index.html" || { echo "${pin.url} has no index.html in its top directory" >&2; exit 1; }

    runHook postInstall
  '';

  meta = {
    description = "Atlas Todo web app ${pin.version} (pinned release build)";
    homepage = "https://github.com/atlastodo/atlas-todo";
    license = lib.licenses.agpl3Only;
    platforms = lib.platforms.all;
  };
}
