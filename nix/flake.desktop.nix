{
  description = "Atlas Todo Desktop Application";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        rec {
          default = self.packages.${system}.atlas-desktop;

          atlas-desktop = pkgs.stdenv.mkDerivation rec {
            pname = "atlas-desktop";
            version = "@VERSION@";

            src = ./.;

            nativeBuildInputs = [
              pkgs.makeWrapper
              pkgs.copyDesktopItems
            ];

            desktopItems = [
              (pkgs.makeDesktopItem {
                name = "atlas-desktop";
                desktopName = "Atlas Todo";
                genericName = "Todo & Task Management";
                comment = "Local-first todo and task management";
                exec = "atlas-desktop %u";
                icon = "atlas-todo";
                terminal = false;
                startupWMClass = "atlas-desktop";
                categories = [ "Office" "ProjectManagement" ];
                mimeTypes = [ "x-scheme-handler/atlastodo" ];
              })
            ];

            installPhase = ''
              runHook preInstall

              mkdir -p $out/share/atlas-desktop
              cp -r dist web-dist assets package.json $out/share/atlas-desktop/

              mkdir -p $out/share/icons/hicolor/512x512/apps $out/share/pixmaps
              cp assets/icon.png $out/share/icons/hicolor/512x512/apps/atlas-todo.png
              cp assets/icon.png $out/share/pixmaps/atlas-todo.png

              mkdir -p $out/bin
              makeWrapper ${pkgs.electron}/bin/electron $out/bin/atlas-desktop \
                --add-flags "$out/share/atlas-desktop/dist/main.js" \
                --add-flags "--no-update" \
                --add-flags "--class=atlas-desktop" \
                --add-flags "''${NIXOS_OZONE_WL:+''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations}}"

              runHook postInstall
            '';

            meta = with pkgs.lib; {
              description = "Atlas Todo desktop application powered by Electron";
              license = licenses.agpl3Only;
              platforms = [ "x86_64-linux" "aarch64-linux" ];
              mainProgram = "atlas-desktop";
            };
          };

          # The exported web SPA on its own, without Electron around it. For
          # pointing a self-hosted atlas-server's STATIC_DIR at (the server
          # flake's services.atlas.staticDir option) — e.g. behind a
          # reverse proxy that fronts the API on the same origin. The release
          # web export bakes no API URL in: each browser types the API URL once
          # on the sign-in screen.
          web-dist = pkgs.stdenv.mkDerivation {
            pname = "atlas-web-dist";
            version = "@VERSION@";

            src = ./.;

            dontConfigure = true;
            dontBuild = true;

            installPhase = ''
              runHook preInstall

              cp -r web-dist "$out"

              runHook postInstall
            '';

            meta = with pkgs.lib; {
              description = "Atlas Todo web app (React Native Web export)";
              license = licenses.agpl3Only;
              platforms = [ "x86_64-linux" "aarch64-linux" ];
            };
          };
        }
      );

      homeManagerModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.programs.atlas-desktop;
        in {
          options.programs.atlas-desktop = {
            enable = lib.mkEnableOption "Atlas Todo desktop application";
            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
              description = "The Atlas Todo desktop package to install.";
            };
            checkUpdates = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = "Whether to allow Atlas Todo to check for updates online. Disabled by default on NixOS.";
            };
          };

          config = lib.mkIf cfg.enable {
            home.packages = [ cfg.package ];
          };
        };

      nixosModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.programs.atlas-desktop;
        in {
          options.programs.atlas-desktop = {
            enable = lib.mkEnableOption "Atlas Todo desktop application";
            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
              description = "The Atlas Todo desktop package to install.";
            };
            checkUpdates = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = "Whether to allow Atlas Todo to check for updates online. Disabled by default on NixOS.";
            };
          };

          config = lib.mkIf cfg.enable {
            environment.systemPackages = [ cfg.package ];
          };
        };
    };
}
