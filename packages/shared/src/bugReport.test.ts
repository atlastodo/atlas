import { describe, it, expect } from "vitest";
import type { BugReportBreadcrumb } from "@atlas/client-core";
import {
  buildBugReport,
  createBreadcrumbTrail,
  emptyDiagnostics,
  redactText,
  REPORT_LIMITS,
  sanitizeRef,
  stackFrames,
  type BuildReportInput,
} from "./bugReport";

/** Strings that must never survive into a payload, whatever shape they arrive in. */
const TITLE = "Buy anniversary flowers";
const NOTES = "Ring the florist on 5th";

function input(overrides: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    id: "0198ab00-0000-7000-8000-000000000001",
    kind: "crash",
    thrown: new Error("boom"),
    appVersion: "0.18.0",
    platform: "ios",
    osVersion: "18.0",
    route: "/today",
    deviceId: "device-1",
    diagnostics: emptyDiagnostics(),
    breadcrumbs: [],
    now: 1_754_300_000_000,
    ...overrides,
  };
}

describe("buildBugReport", () => {
  it("writes exactly the allowlisted keys", () => {
    // The point of this assertion is to fail when someone adds a field: a new key must be a
    // decision, not a side effect of widening an input type.
    expect(Object.keys(buildBugReport(input())).sort()).toEqual([
      "appVersion",
      "breadcrumbs",
      "description",
      "deviceId",
      "diagnostics",
      "id",
      "kind",
      "message",
      "occurredAt",
      "osVersion",
      "platform",
      "route",
      "stack",
    ]);
  });

  it("carries the diagnostics counts through unchanged", () => {
    const report = buildBugReport(
      input({
        diagnostics: {
          syncStatus: "offline",
          lastSyncAt: 900,
          pending: 7,
          quarantined: 2,
          lastErrorKind: "http",
          lastErrorStatus: 422,
          lastErrorMessage: "unprocessable",
          online: false,
        },
      }),
    );
    expect(report.diagnostics.pending).toBe(7);
    expect(report.diagnostics.quarantined).toBe(2);
    expect(report.diagnostics.lastErrorStatus).toBe(422);
    expect(report.diagnostics.syncStatus).toBe("offline");
  });

  it("keeps a manual description verbatim", () => {
    // The user typed it deliberately; scrubbing it would make the form useless.
    const report = buildBugReport(
      input({ kind: "manual", description: "It froze when I tapped 'Today'" }),
    );
    expect(report.description).toBe("It froze when I tapped 'Today'");
  });

  it("caps an over-long description rather than dropping it", () => {
    const report = buildBugReport(input({ kind: "manual", description: "x".repeat(9_000) }));
    expect(report.description).toHaveLength(REPORT_LIMITS.description);
  });

  it("keeps only the newest breadcrumbs", () => {
    const many: BugReportBreadcrumb[] = Array.from({ length: 80 }, (_, i) => ({
      at: i,
      code: "nav",
      ref: `/p${i}`,
    }));
    const report = buildBugReport(input({ breadcrumbs: many }));
    expect(report.breadcrumbs).toHaveLength(REPORT_LIMITS.breadcrumbs);
    expect(report.breadcrumbs[report.breadcrumbs.length - 1]!.at).toBe(79);
  });
});

describe("redaction", () => {
  // Every realistic way a task title could reach a report. Each entry builds one payload; none of
  // them may contain the canary strings.
  const shapes: Array<{ name: string; build: () => BuildReportInput }> = [
    {
      name: "thrown as a bare string",
      build: () => input({ thrown: `${TITLE} exploded` }),
    },
    {
      name: "thrown as a plain object",
      build: () => input({ thrown: { title: TITLE, notes: NOTES } }),
    },
    {
      name: "quoted inside an Error message",
      build: () => input({ thrown: new Error(`Cannot read property of "${TITLE}"`) }),
    },
    {
      name: "JSON-serialised inside an Error message",
      build: () => input({ thrown: new Error(`bad op: {"title":"${TITLE}","notes":"${NOTES}"}`) }),
    },
    {
      name: "unquoted after a content key",
      build: () => input({ thrown: new Error(`render failed, title: ${TITLE}`) }),
    },
    {
      name: "inside a non-frame stack line",
      build: () => {
        const err = new Error("render failed");
        err.stack = [
          "Error: render failed",
          `        const label = "${TITLE}";`,
          "    at render (bundle.js:1:2)",
        ].join("\n");
        return input({ thrown: err });
      },
    },
    {
      name: "as a breadcrumb ref",
      build: () => input({ breadcrumbs: [{ at: 1, code: "task.open", ref: TITLE }] }),
    },
    {
      name: "as a route",
      build: () => input({ route: `/task/${TITLE}` }),
    },
    {
      name: "inside the last sync error message",
      build: () =>
        input({
          diagnostics: {
            ...emptyDiagnostics(),
            lastErrorMessage: `rejected op {"title":"${TITLE}"}`,
          },
        }),
    },
  ];

  for (const shape of shapes) {
    it(`never leaks task content: ${shape.name}`, () => {
      const serialized = JSON.stringify(buildBugReport(shape.build()));
      expect(serialized).not.toContain(TITLE);
      expect(serialized).not.toContain(NOTES);
    });
  }

  it("a non-Error throw contributes only its type", () => {
    expect(buildBugReport(input({ thrown: "some secret string" })).message).toBe(
      "<non-error thrown: string>",
    );
    expect(buildBugReport(input({ thrown: 42 })).message).toBe("<non-error thrown: number>");
    // ...and no stack, because there is nothing trustworthy to take one from.
    expect(buildBugReport(input({ thrown: "x" })).stack).toBeUndefined();
  });

  it("still reports something useful after redacting", () => {
    // Redaction must not reduce every crash to noise; the shape of the failure has to survive.
    const report = buildBugReport(
      input({ thrown: new Error(`Cannot read property 'id' of undefined near "${TITLE}"`) }),
    );
    expect(report.message).toContain("Cannot read property");
    expect(report.message).toContain("undefined");
  });
});

describe("redactText", () => {
  it("replaces quoted runs in all three quote styles", () => {
    expect(redactText(`a "one" b 'two' c \`three\``)).toBe(
      "a <redacted> b <redacted> c <redacted>",
    );
  });

  it("leaves a short quoted run alone", () => {
    // A two-character quote is punctuation or an operator, not content, and blanking it would
    // mangle ordinary messages like `unexpected token ")"`.
    expect(redactText(`unexpected ")"`)).toBe(`unexpected ")"`);
  });

  it("replaces the value of a content-shaped key", () => {
    expect(redactText("notes: something private")).toBe("notes: <redacted>");
    expect(redactText("name=Ada Lovelace, id=7")).toBe("name=<redacted>, id=7");
  });

  it("replaces email addresses", () => {
    expect(redactText("failed for ada@example.com")).toBe("failed for <redacted>");
  });

  it("truncates without orphaning a surrogate pair", () => {
    // An astral character is two UTF-16 units; cutting between them yields an invalid string.
    const text = "\u{1F600}".repeat(10);
    const out = redactText(text, 5);
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out).toBe("\u{1F600}\u{1F600}");
  });

  it("keeps entity ids, which are the useful part", () => {
    const id = "0198ab00-0000-7000-8000-000000000001";
    expect(redactText(`missing task ${id}`)).toContain(id);
  });
});

describe("stackFrames", () => {
  it("drops the message line and any non-frame line", () => {
    const stack = [
      "Error: render failed",
      "    at render (bundle.js:1:2)",
      "        some bundled source excerpt",
      "onPress@app.bundle:99:7",
    ].join("\n");
    expect(stackFrames(stack)).toBe("at render (bundle.js:1:2)\nonPress@app.bundle:99:7");
  });

  it("is undefined when nothing looks like a frame", () => {
    expect(stackFrames("Error: nope\njust prose")).toBeUndefined();
    expect(stackFrames(undefined)).toBeUndefined();
  });
});

describe("sanitizeRef", () => {
  it("accepts a route and a uuid", () => {
    expect(sanitizeRef("/project/abc_1")).toBe("/project/abc_1");
    expect(sanitizeRef("0198ab00-0000-7000-8000-000000000001")).toBe(
      "0198ab00-0000-7000-8000-000000000001",
    );
  });

  it("drops anything with spaces or over-long", () => {
    expect(sanitizeRef("Buy anniversary flowers")).toBeUndefined();
    expect(sanitizeRef("a".repeat(65))).toBeUndefined();
    expect(sanitizeRef(undefined)).toBeUndefined();
    expect(sanitizeRef("")).toBeUndefined();
  });
});

describe("createBreadcrumbTrail", () => {
  it("keeps the newest entries, oldest first", () => {
    const trail = createBreadcrumbTrail(3);
    for (let i = 0; i < 5; i++) trail.add("nav", `/p${i}`, i);
    expect(trail.list().map((c) => c.at)).toEqual([2, 3, 4]);
  });

  it("sanitises a ref on the way in, so nothing unsafe is ever stored", () => {
    const trail = createBreadcrumbTrail();
    trail.add("task.open", TITLE, 1);
    expect(trail.list()[0]!.ref).toBeUndefined();
  });

  it("returns a copy, so a later crumb cannot mutate an earlier read", () => {
    const trail = createBreadcrumbTrail();
    trail.add("nav", "/today", 1);
    const first = trail.list();
    trail.add("nav", "/inbox", 2);
    expect(first).toHaveLength(1);
  });

  it("clears", () => {
    const trail = createBreadcrumbTrail();
    trail.add("nav", "/today", 1);
    trail.clear();
    expect(trail.list()).toEqual([]);
  });
});

describe("stackFrames on hostile input", () => {
  it("rejects a line of repeated `@`s in linear time", () => {
    const stack = `Error: x\n${"!@".repeat(50_000)}`;
    const start = performance.now();
    expect(stackFrames(stack)).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(500);
  });
});
