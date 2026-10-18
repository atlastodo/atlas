{
  description = "Atlas: the local-first sync server (NixOS module) and, until the app moves out, the Atlas Todo desktop (NixOS & Home Manager modules)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      bun2nix,
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

      # The pinned app web builds (apps.lock.json, which docker.yml reads too): a "todo" pin makes
      # atlas-web-dist that release asset instead of a build of apps/mobile.
      appsLock =
        if builtins.pathExists ./apps.lock.json then
          builtins.fromJSON (builtins.readFile ./apps.lock.json)
        else
          { };
      todoWebPin = appsLock.todo or null;

      # Adds atlas-server, atlas-web-dist(-source) and atlas-desktop to a package set.
      overlay = final: _prev: {
        atlas-server = final.callPackage ./nix/packages/atlas-server.nix { inherit version; };
        atlas-web-dist-source = final.callPackage ./nix/packages/web-dist.nix {
          inherit version;
          bun2nix = bun2nix.packages.${final.stdenv.hostPlatform.system}.default;
        };
        atlas-web-dist =
          if todoWebPin != null then
            final.callPackage ./nix/packages/web-dist-pinned.nix { pin = todoWebPin; }
          else
            final.atlas-web-dist-source;
        # Always the source build: the pinned asset is built for a server (its API at /api on the
        # page's origin), while the desktop app asks for a server at sign-in.
        atlas-desktop = final.callPackage ./nix/packages/atlas-desktop.nix {
          inherit version;
          bun2nix = bun2nix.packages.${final.stdenv.hostPlatform.system}.default;
          atlas-web-dist = final.atlas-web-dist-source;
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
          inherit (pkgs) atlas-server atlas-desktop;
          web-dist = pkgs.atlas-web-dist;
          web-dist-source = pkgs.atlas-web-dist-source;
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

        # programs.atlas-desktop
        desktop = withPackage ./nix/desktop-nixos-module.nix [
          "programs"
          "atlas-desktop"
        ] "atlas-desktop";
        atlas-desktop = desktop;

        default = {
          imports = [
            server
            desktop
          ];
        };
      };

      homeManagerModules = rec {
        desktop = withPackage ./nix/desktop-home-manager-module.nix [
          "programs"
          "atlas-desktop"
        ] "atlas-desktop";
        atlas-desktop = desktop;
        default = desktop;
      };

      checks = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          inherit (self.packages.${system}) atlas-server atlas-desktop web-dist;

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

          home-manager-module-eval =
            let
              eval = lib.evalModules {
                specialArgs = { inherit pkgs; };
                modules = [
                  {
                    options.home.packages = lib.mkOption {
                      type = lib.types.listOf lib.types.package;
                      default = [ ];
                    };
                  }
                  self.homeManagerModules.default
                  { programs.atlas-desktop.enable = true; }
                ];
              };
            in
            pkgs.runCommand "hm-module-eval-test" { } ''
              echo "HM Desktop package: ${builtins.elemAt eval.config.home.packages 0}"
              touch "$out"
            '';
        }
      );
    };
}
