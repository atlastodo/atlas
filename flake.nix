{
  description = "Atlas: the local-first sync server (package and NixOS module) and the pinned Atlas Todo web build";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
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

      # The pinned app web build (the "todo" pin of apps.lock.json, which docker/Dockerfile reads
      # too): a release asset of atlastodo/atlas-todo, set with scripts/pin-app-web.mjs.
      todoWebPin =
        (builtins.fromJSON (builtins.readFile ./apps.lock.json)).todo
          or (throw "apps.lock.json has no todo pin: run scripts/pin-app-web.mjs <version>");

      # Adds atlas-server and atlas-web-dist to a package set.
      overlay = final: _prev: {
        atlas-server = final.callPackage ./nix/packages/atlas-server.nix { inherit version; };
        atlas-web-dist = final.callPackage ./nix/packages/web-dist-pinned.nix { pin = todoWebPin; };
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
          inherit (pkgs) atlas-server;
          # What a services.atlas.staticDir points at.
          web-dist = pkgs.atlas-web-dist;
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
          inherit (self.packages.${system}) atlas-server web-dist;

          # Boots a VM with the server module and exercises it end to end.
          server-vm = pkgs.testers.runNixOSTest (
            import ./nix/tests/server.nix {
              module = self.nixosModules.default;
              webDist = self.packages.${system}.web-dist;
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
