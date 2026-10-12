# services.atlas-todo — run the Atlas Todo server as a native systemd service.
#
# Imported through the repository flake (`nixosModules.atlas-todo`), which sets
# the flake's atlas-server package as the `package` default. Importing this file
# standalone requires setting `services.atlas-todo.package` yourself (e.g. to
# `pkgs.atlas-server` from the flake's `overlays.default`).
#
# This module deliberately does not duplicate the server's defaults. Every env
# knob from crates/atlas-server/src/config.rs (+ ratelimit.rs) — mirrored in
# .env.example and docs/self-hosting.md — is passed through verbatim via
# `settings`; the first-class options below only cover what the module itself
# decides: the filesystem layout, the systemd unit, and the database.
{ config, lib, pkgs, ... }:

let
  cfg = config.services.atlas-todo;

  # DATABASE_URL when database.createLocally is set: the host Postgres's unix
  # socket, so no password is involved. sqlx reads `host` (a socket directory)
  # and `user` from the query string; an empty authority ("postgres:///") avoids
  # the EmptyHost parse error (verified against a live server).
  socketDatabaseUrl =
    "postgres:///${cfg.database.name}?host=/run/postgresql&user=${cfg.database.user}";

  usingLocalDatabase = cfg.database.url == null && cfg.database.createLocally;

  jwtSecretPath = "${cfg.dataDir}/jwt_secret";

  # Env rendering for `settings`: booleans pass as true/false (both spellings
  # are accepted by the server's parser), everything else as toString.
  envValue = value:
    if builtins.isBool value
    then lib.boolToString value
    else toString value;

  # Env vars the module derives from its own options. Refusing them in
  # `settings` keeps a stray entry from silently shadowing an option.
  reservedSettings = [
    "PORT"
    "BIND_ADDR"
    "BLOB_DIR"
    "STATIC_DIR"
    "ADMIN_EMAILS"
    "DATABASE_URL"
  ];
  shadowedSettings = lib.intersectLists reservedSettings (lib.attrNames cfg.settings);
in
{
  options.services.atlas-todo = {
    enable = lib.mkEnableOption "the Atlas Todo server (atlas-server)";

    package = lib.mkOption {
      type = lib.types.package;
      defaultText = lib.literalExpression "atlas-todo.packages.\${system}.atlas-server";
      description = ''
        The atlas-server package to run. The flake's `nixosModules.atlas-todo`
        sets its own build as the default; a standalone import of this file
        needs it set explicitly.
      '';
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/atlas-todo";
      description = ''
        Where the server keeps its persistent state: attachment blobs are
        written under `<dataDir>/blobs` (the `BLOB_DIR` env var, which only
        stages uploads with settings.BLOB_BACKEND = "s3"; the server
        creates the directory itself). Back this up together with the database —
        see docs/self-hosting.md, Backups.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8080;
      description = "Listening port (the `PORT` env var).";
    };

    bindAddress = lib.mkOption {
      type = lib.types.str;
      default = "0.0.0.0";
      example = "127.0.0.1";
      description = ''
        Listening address (the `BIND_ADDR` env var): any IPv4 or IPv6 address.
        `127.0.0.1` keeps the server to a reverse proxy on the same host; `::`
        listens on every interface, IPv4 included unless the host sets
        `net.ipv6.bindv6only`. The server refuses anything else at startup.
      '';
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Open the firewall for the listening port. Off by default: self-hosting
        puts a TLS reverse proxy in front, which reaches the server on localhost.
      '';
    };

    jwtSecretFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/agenix/atlas-todo-jwt";
      description = ''
        A file containing the `JWT_SECRET` value (at least 32 bytes; the server
        rejects placeholders at startup), read by systemd as an EnvironmentFile.
        It must not live in the nix store — an agenix/sops secret, for example.
        If null, a secret is generated under `<dataDir>/jwt_secret` on first
        start and reused afterwards. Carry the same secret over when migrating an existing
        deployment, or every session is invalidated.
      '';
    };

    adminEmails = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "you@example.com" ];
      description = ''
        Accounts promoted to admin at every startup (the `ADMIN_EMAILS` env
        var). Never demotes, and grants nothing at signup — sign up, then
        restart, or run `atlas-server promote` (see docs/self-hosting.md,
        Maintenance commands).
      '';
    };

    staticDir = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = lib.literalExpression ''
        "''${inputs.atlas-todo.packages.''${system}.web-dist}"'';
      description = ''
        Optional directory of the exported web SPA to serve (the `STATIC_DIR`
        env var) — for example the desktop tarball flake's `web-dist` package.
        Without it the server is API-only. The SPA needs its API URL typed once
        on the sign-in screen (the release web export bakes none in).
      '';
    };

    settings = lib.mkOption {
      type = lib.types.attrsOf (lib.types.oneOf [
        lib.types.str
        lib.types.int
        lib.types.bool
      ]);
      default = { };
      example = {
        OP_RETENTION_DAYS = 60;
        AUTH_RATE_LIMIT_TRUST_FORWARDED = true;
        CORS_ALLOWED_ORIGINS = "https://todo.example.com,app://atlas-todo";
      };
      description = ''
        Extra server settings, passed through as environment variables with the
        same names. The full list (retention windows, rate limits, blob quotas,
        CORS, TTLs, …) and every default lives in crates/atlas-server/src/config.rs
        and docs/self-hosting.md — the module adds no defaults of its own. An
        empty value counts as unset; booleans pass as true/false. Never put
        secrets here: env values land in the nix store.
      '';
    };

    environmentFile = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      example = [ "/run/agenix/atlas-todo-env" ];
      description = ''
        Extra systemd EnvironmentFiles (`NAME=value` lines), read by systemd
        and kept out of the nix store. The place for secrets such as a
        DATABASE_URL with a password (set database.createLocally = false and
        leave database.url null) or JWT_SECRET. Loaded after everything else,
        so its values win.
      '';
    };

    database = {
      url = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "postgres://atlas:secret@db.internal:5432/atlas";
        description = ''
          A full DATABASE_URL to an existing PostgreSQL. When set, nothing is
          provisioned locally. The value lands in the world-readable nix store:
          if it carries a password, put DATABASE_URL in environmentFile instead.
        '';
      };

      createLocally = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Provision the database and user on the host's services.postgresql
          (ensureDatabases/ensureUsers — additive, so an existing cluster keeps
          its version and settings) and connect over its unix socket, with no
          password. The migrations run at server startup.
        '';
      };

      name = lib.mkOption {
        type = lib.types.str;
        default = "atlas-todo";
        description = "Database name when database.createLocally is set.";
      };

      user = lib.mkOption {
        type = lib.types.str;
        default = "atlas-todo";
        description = ''
          Database user when database.createLocally is set. Must equal the
          database name (the ownership grant follows the user).
        '';
      };
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      assertions = [
        {
          assertion =
            cfg.database.url != null || cfg.database.createLocally || cfg.environmentFile != [ ];
          message = ''
            services.atlas-todo: set database.url or a DATABASE_URL in
            environmentFile (external Postgres), or keep
            database.createLocally = true.
          '';
        }
        {
          assertion = cfg.database.url == null || !cfg.database.createLocally;
          message = ''
            services.atlas-todo.database.url and database.createLocally are
            mutually exclusive: set database.createLocally = false when pointing
            at an external database.
          '';
        }
        {
          assertion = !(cfg.settings ? "JWT_SECRET");
          message = ''
            services.atlas-todo.settings must not set JWT_SECRET: env values
            land in the nix store. Use services.atlas-todo.jwtSecretFile.
          '';
        }
        {
          assertion = usingLocalDatabase -> cfg.database.name == cfg.database.user;
          message = ''
            services.atlas-todo.database: name and user must be equal (the
            ensureDBOwnership grant follows the user).
          '';
        }
        {
          assertion = shadowedSettings == [ ];
          message = ''
            services.atlas-todo.settings must not set ${
              lib.concatStringsSep ", " shadowedSettings
            }: each is derived from one of the module's own options (port,
            bindAddress, dataDir, staticDir, adminEmails, database).
          '';
        }
      ];

      users.groups.atlas-todo = { };
      users.users.atlas-todo = {
        isSystemUser = true;
        group = "atlas-todo";
        description = "Atlas Todo server";
      };

      systemd.tmpfiles.rules = [
        "d '${cfg.dataDir}' 0750 atlas-todo atlas-todo - -"
      ];

      systemd.services.atlas-todo = {
        description = "Atlas Todo server";
        documentation = [ "https://github.com/atlastodo/atlas-todo" ];
        wantedBy = [ "multi-user.target" ];
        # Locally, postgresql.target covers both the server and the
        # postgresql-setup unit that runs ensureUsers/ensureDatabases: ordering
        # after postgresql.service alone races the role creation. An external
        # database may be on another host, so wait for the network instead.
        after =
          if usingLocalDatabase then
            [
              "network.target"
              "postgresql.target"
            ]
          else
            [ "network-online.target" ];
        requires = lib.optionals usingLocalDatabase [ "postgresql.target" ];
        wants = lib.optionals (!usingLocalDatabase) [ "network-online.target" ];
        # No restartTriggers needed: the package and staticDir are store paths
        # inside ExecStart/Environment, so a new build rewrites the unit and
        # switch-to-configuration restarts it.
        # The server applies migrations at startup, then promotes ADMIN_EMAILS
        # and spawns its retention/purge/GC tasks.
        environment =
          {
            PORT = toString cfg.port;
            BIND_ADDR = cfg.bindAddress;
            BLOB_DIR = "${cfg.dataDir}/blobs";
            # Match the container's default log level.
            RUST_LOG = "info";
            ADMIN_EMAILS = lib.concatStringsSep "," cfg.adminEmails;
          }
          // lib.optionalAttrs (cfg.staticDir != null) {
            STATIC_DIR = toString cfg.staticDir;
          }
          // lib.optionalAttrs usingLocalDatabase { DATABASE_URL = socketDatabaseUrl; }
          // lib.optionalAttrs (cfg.database.url != null) { DATABASE_URL = cfg.database.url; }
          // lib.mapAttrs (_: value: envValue value) cfg.settings;
        unitConfig.RequiresMountsFor = [ cfg.dataDir ];
        serviceConfig = {
          User = "atlas-todo";
          Group = "atlas-todo";
          ExecStart = "${cfg.package}/bin/atlas-server";
          # Generates the secret on first start. systemd loads EnvironmentFiles
          # before spawning every command, this one included, so the generated
          # file is listed with a "-" (optional) prefix: missing here, loaded by
          # ExecStart. Written to a temp file and renamed, so an interrupted
          # start never leaves a truncated secret behind.
          ExecStartPre = lib.optional (cfg.jwtSecretFile == null) (
            pkgs.writeShellScript "atlas-todo-init-jwt" ''
              set -eu
              umask 077
              if [ ! -s ${lib.escapeShellArg jwtSecretPath} ]; then
                tmp=${lib.escapeShellArg jwtSecretPath}.tmp
                printf 'JWT_SECRET=%s\n' "$(head -c 32 /dev/urandom | base64)" > "$tmp"
                mv "$tmp" ${lib.escapeShellArg jwtSecretPath}
              fi
            ''
          );
          # Read by systemd itself, so agenix-style /run paths are fine even
          # under ProtectSystem=strict.
          EnvironmentFile =
            (
              if cfg.jwtSecretFile != null then [ (toString cfg.jwtSecretFile) ] else [ "-${jwtSecretPath}" ]
            )
            ++ map toString cfg.environmentFile;
          Restart = "on-failure";
          RestartSec = "5s";
          # Hardening: the server needs the data dir writable, the socket to
          # reach Postgres, and nothing else of the host.
          NoNewPrivileges = true;
          ProtectSystem = "strict";
          ProtectHome = true;
          PrivateTmp = true;
          PrivateDevices = true;
          ProtectKernelTunables = true;
          ProtectKernelModules = true;
          ProtectKernelLogs = true;
          ProtectControlGroups = true;
          ProtectClock = true;
          ProtectHostname = true;
          ProtectProc = "invisible";
          ProcSubset = "pid";
          RestrictAddressFamilies = [
            "AF_INET"
            "AF_INET6"
            "AF_UNIX"
          ];
          RestrictNamespaces = true;
          RestrictRealtime = true;
          LockPersonality = true;
          MemoryDenyWriteExecute = true;
          SystemCallArchitectures = "native";
          SystemCallFilter = [
            "@system-service"
            "~@privileged"
            "~@resources"
          ];
          CapabilityBoundingSet = "";
          RemoveIPC = true;
          UMask = "0077";
          ReadWritePaths = [ cfg.dataDir ];
        };
      };

      networking.firewall.allowedTCPPorts =
        lib.optionals cfg.openFirewall [ cfg.port ];
    }

    (lib.mkIf usingLocalDatabase {
      services.postgresql = {
        # mkDefault: an explicitly enabled/configured services.postgresql wins.
        enable = lib.mkDefault true;
        ensureDatabases = [ cfg.database.name ];
        ensureUsers = [
          {
            name = cfg.database.user;
            ensureDBOwnership = true;
          }
        ];
      };
    })
  ]);
}
