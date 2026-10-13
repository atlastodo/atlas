import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlasClient } from "@atlas/sdk";
import { FakeServer } from "@atlas/sdk/testing";
import { run } from "./cli";

/**
 * `test-vectors/cli_golden.json`: runs of the CLI that the Rust `atlas` (crates/atlas-cli) must
 * reproduce byte for byte. `GOLDEN_UPDATE=1` rewrites the expected output from this CLI.
 */

type Step =
  | { seed: { entity: string; ref: string; fields: Record<string, unknown> } }
  | { revoke: true }
  | {
      argv: string[];
      env?: Record<string, string>;
      capture?: Record<string, string>;
      exit?: number;
      stdout?: string;
      stderr?: string[];
    };

interface Golden {
  now: number;
  scenarios: { name: string; tz: string; steps: Step[] }[];
}

const path = fileURLToPath(new URL("../../../test-vectors/cli_golden.json", import.meta.url));
const golden = JSON.parse(readFileSync(path, "utf8")) as Golden;
const update = process.env.GOLDEN_UPDATE === "1";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

afterEach(() => {
  vi.useRealTimers();
});

describe("CLI golden runs", () => {
  for (const scenario of golden.scenarios) {
    it(scenario.name, async () => {
      vi.useFakeTimers({ now: golden.now, toFake: ["Date"] });
      const server = new FakeServer();
      const refs: Record<string, string> = {};
      const ids = new Map<string, string>();
      const normalize = (text: string) =>
        text.replace(UUID, (id) => {
          if (!ids.has(id)) ids.set(id, `<id:${ids.size + 1}>`);
          return ids.get(id)!;
        });
      for (const step of scenario.steps) {
        if ("seed" in step) {
          const app = await server.appDevice();
          const id = app.store.newEntityId();
          for (const [field, value] of Object.entries(step.seed.fields)) {
            app.store.set(step.seed.entity as "project", id, field, value);
          }
          await app.sync.sync();
          refs[step.seed.ref] = id;
          continue;
        }
        if ("revoke" in step) {
          server.revoked = true;
          continue;
        }
        const argv = step.argv.map((a) =>
          a.replace(/\{(\w+)\}/g, (_, name: string) => refs[name]!),
        );
        const out: string[] = [];
        const err: string[] = [];
        const code = await run(argv, {
          env: {
            ATLAS_URL: "http://atlas.test",
            ATLAS_TOKEN: server.tokenString(),
            ATLAS_TZ: scenario.tz,
            ...step.env,
          },
          stdout: (t) => out.push(t),
          stderr: (t) => err.push(t),
          connect: (opts) => AtlasClient.connect({ ...opts, fetch: server.fetch }),
        });
        const stdoutText = out.join("\n");
        for (const [name, field] of Object.entries(step.capture ?? {})) {
          refs[name] = String((JSON.parse(stdoutText) as Record<string, unknown>)[field]);
        }
        const isUsage = stdoutText.startsWith("atlas ") && stdoutText.includes("Commands");
        const got = {
          exit: code,
          stdout: isUsage ? "<usage>" : normalize(stdoutText),
          stderr: err.map(normalize),
        };
        if (update) {
          Object.assign(step, got);
        } else {
          expect(got, JSON.stringify(step.argv)).toEqual({
            exit: step.exit,
            stdout: step.stdout,
            stderr: step.stderr,
          });
        }
      }
    });
  }

  it.runIf(update)("writes the fixture", () => {
    writeFileSync(path, `${JSON.stringify(golden, null, 2)}\n`);
  });
});
