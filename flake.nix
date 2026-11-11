{
  description = "Atlas: the local-first sync server (package and NixOS module) and the pinned Atlas Todo web build";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # The Rust in rust-toolchain.toml, which atlas-server builds with (as CI and the image do).
    # devenv.yaml follows this input and nixpkgs, so the dev shell uses the same pins.
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # No build here uses it since the todo app moved to atlastodo/atlas-todo. Kept so existing
    # `inputs.atlas.inputs.bun2nix.follows` overrides and the `nix:bun-lock` devenv script keep
    # working.
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      rust-overlay,
      ...
    }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = lib.genAttrs systems;

      # The workspace version is the single source of truth: version:bump keeps
      # Cargo.toml in lockstep with package.json, so no bump step is needed here.
      version = (builtins.fromTOML (builtins.readFile ./Cargo.toml)).workspace.package.version;

      # Adds atlas-server to a package set.
      overlay = final: _prev: {
        atlas-server = final.callPackage ./nix/packages/atlas-server.nix {
          inherit version;
          rustPlatform =
            let
              # The toolchain runs on the build platform and carries the host platform's standard
              # library, so a cross build (x86_64 building for aarch64) needs no aarch64-hosted GCC.
              rustBin = rust-overlay.lib.mkRustBin { } final.buildPackages;
              toolchain = (rustBin.fromRustupToolchainFile ./rust-toolchain.toml).override {
                targets = [ final.stdenv.hostPlatform.rust.rustcTarget ];
              };
            in
            final.makeRustPlatform {
              cargo = toolchain;
              rustc = toolchain;
            };
        };
      };

      pkgsFor = system: nixpkgs.legacyPackages.${system}.extend overlay;

      # Wraps a module file so its `package` defaults to this flake's build. The key lets the
      # module system import it once when it is reached twice (e.g. `default` plus `server`).
      withPackage =
        file: optionPath: name:
        { lib, pkgs, ... }:
        {
          key = "atlas-flake:${lib.concatStringsSep "." optionPath}";
          imports = [ file ];
          config = lib.setAttrByPath (optionPath ++ [ "package" ]) (
            lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.${name}
          );
        };
    in
    {
      overlays.default = overlay;

      packages = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          # The server alone: an app's web build (services.atlas.staticDir) comes from that app's
          # flake, e.g. github:atlastodo/atlas-todo's web-dist.
          inherit (pkgs) atlas-server;
          default = pkgs.atlas-server;
        }
      );

      nixosModules = rec {
        # services.atlas (formerly services.atlas-todo, still accepted with a warning)
        server = withPackage ./nix/server-module.nix [ "services" "atlas" ] "atlas-server";
        atlas = server;
        # Deprecated alias from before the repository was renamed to atlastodo/atlas.
        atlas-todo = {
          key = "atlas-flake:nixosModules.atlas-todo";
          imports = [ server ];
          config.warnings = [
            "The atlas flake's nixosModules.atlas-todo is deprecated: import nixosModules.atlas (or nixosModules.server) instead."
          ];
        };

        # The server module alone. The desktop modules (programs.atlas-desktop) moved to the app's
        # flake, github:atlastodo/atlas-todo, with the app.
        default = server;
      };

      checks = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          inherit (self.packages.${system}) atlas-server;

          # Boots a VM with the server module and exercises it end to end.
          server-vm = pkgs.testers.runNixOSTest (
            import ./nix/tests/server.nix {
              module = self.nixosModules.default;
              # A stub web app: core ships none, the test checks staticDir is served.
              webDist = pkgs.writeTextDir "index.html" "<!doctype html><html><title>atlas-vm-test</title></html>";
            }
          );

          # The pre-rename names (nixosModules.atlas-todo, services.atlas-todo) still evaluate,
          # forward to services.atlas and warn; importing it next to `default` (which also
          # holds the server module) evaluates too.
          server-module-rename-eval =
            let
              eval = lib.nixosSystem {
                modules = [
                  self.nixosModules.atlas-todo
                  self.nixosModules.default
                  {
                    nixpkgs.hostPlatform = system;
                    boot.isContainer = true;
                    system.stateVersion = "25.11";
                    services.atlas-todo.enable = true;
                  }
                ];
              };
              inherit (eval) config;
              warned = needle: lib.any (lib.hasInfix needle) config.warnings;
            in
            assert config.services.atlas.enable;
            assert config.systemd.services ? atlas-todo;
            assert warned "services.atlas-todo";
            assert warned "nixosModules.atlas-todo";
            pkgs.runCommand "server-module-rename-eval" { } ''
              echo "services.atlas-todo -> services.atlas: ${config.services.atlas.package}"
              touch "$out"
            '';
        }
      );
    };
}
