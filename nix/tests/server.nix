# NixOS VM test for services.atlas: a fresh host with the local Postgres,
# the auto-generated JWT secret and the web export served from staticDir.
{ module, webDist }:
{
  name = "atlas-todo-server";

  nodes.machine = {
    imports = [ module ];
    services.atlas = {
      enable = true;
      staticDir = webDist;
      adminEmails = [ "admin@example.com" ];
      # Passed through like every other env knob; validated against the bundled manifests.
      settings.ATLAS_APPS = "todo";
    };
  };

  testScript = ''
    machine.wait_for_unit("atlas-todo.service")
    machine.wait_for_open_port(8080)

    machine.succeed("curl -sf http://localhost:8080/health")
    machine.succeed("curl -sf http://localhost:8080/ | grep -qi '<html'")
    machine.succeed("curl -sf http://localhost:8080/discovery | grep -q '\"id\":\"todo\"'")

    # The generated secret survives a restart (sessions stay valid).
    before = machine.succeed("sha256sum /var/lib/atlas-todo/jwt_secret")
    machine.succeed("stat -c %a /var/lib/atlas-todo/jwt_secret | grep -qx 600")
    machine.succeed("systemctl restart atlas-todo.service")
    machine.wait_for_open_port(8080)
    machine.succeed("curl -sf http://localhost:8080/health")
    after = machine.succeed("sha256sum /var/lib/atlas-todo/jwt_secret")
    assert before == after, "jwt_secret changed across a restart"

    print(machine.succeed("systemd-analyze security atlas-todo.service --no-pager || true"))
  '';
}
