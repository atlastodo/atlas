import { render, screen } from "@testing-library/react-native";
import { LocalStore, type ApiClient, type BugReportView } from "@atlastodo/client-core";
import { fakeAuth, withApp } from "../testutil";
import { AdminReportDetail } from "./AdminReportDetail";

function report(over: Partial<BugReportView>): BugReportView {
  return {
    id: "r-1",
    user_id: null,
    user_email: null,
    kind: "crash",
    message: "It broke",
    app_version: "0.28.2",
    platform: "android",
    os_version: "15",
    route: "/today",
    occurred_at_ms: 1_754_300_000_000,
    created_at_ms: 1_754_300_000_000,
    resolved_at_ms: null,
    stack: null,
    description: null,
    device_id: null,
    diagnostics: {},
    breadcrumbs: [],
    ...over,
  };
}

async function open(view: BugReportView) {
  const api = { getReport: async () => view } as unknown as ApiClient;
  await render(<AdminReportDetail id="r-1" onClose={() => {}} onSetResolved={() => {}} />, {
    wrapper: withApp(new LocalStore("test"), fakeAuth({ api })),
  });
}

describe("AdminReportDetail", () => {
  it("shows a report whose stored breadcrumbs or diagnostics are null", async () => {
    await open(
      report({
        breadcrumbs: [null, { code: "nav", ref: "/inbox", at: 1 }] as never,
        diagnostics: null as never,
      }),
    );
    expect(await screen.findByText("It broke")).toBeTruthy();
    expect(screen.getByText("nav /inbox")).toBeTruthy();
  });

  it("shows a report with no breadcrumb list at all", async () => {
    await open(report({ breadcrumbs: null as never }));
    expect(await screen.findByText("It broke")).toBeTruthy();
  });
});
