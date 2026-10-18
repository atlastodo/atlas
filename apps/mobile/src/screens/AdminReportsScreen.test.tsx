import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { LocalStore, type ApiClient, type BugReportSummary } from "@atlastodo/client-core";
import { AdminReportsScreen } from "./AdminReportsScreen";
import { withApp, fakeAuth } from "../testutil";

function summary(over: Partial<BugReportSummary> = {}): BugReportSummary {
  return {
    id: "r-1",
    user_id: null,
    user_email: null,
    kind: "crash",
    message: "Cannot read property of undefined",
    app_version: "0.18.0",
    platform: "ios",
    os_version: "18.0",
    route: "/today",
    occurred_at_ms: 1_754_300_000_000,
    created_at_ms: 1_754_300_000_000,
    resolved_at_ms: null,
    ...over,
  };
}

/** Typed so the query-shape assertions below stay checked rather than sliding into `any`. */
type ListMock = jest.Mock<Promise<BugReportSummary[]>, [Parameters<ApiClient["listReports"]>[0]]>;

function listMock(): ListMock {
  return jest.fn(async (_params: Parameters<ApiClient["listReports"]>[0]) => []) as ListMock;
}

async function setup(api: Partial<ApiClient>) {
  const store = new LocalStore("device-1");
  await render(<AdminReportsScreen />, {
    wrapper: withApp(store, fakeAuth({ api: api as ApiClient })),
  });
}

describe("AdminReportsScreen", () => {
  it("drops the resolved filter when showing all", async () => {
    const listReports = listMock();
    await setup({ listReports });
    await waitFor(() => expect(listReports).toHaveBeenCalled());

    await fireEvent.press(screen.getByText("All"));

    await waitFor(() => expect(listReports).toHaveBeenCalledTimes(2));
    expect(listReports.mock.calls[1]![0]?.resolved).toBeUndefined();
  });

  it("surfaces a failure instead of an empty list", async () => {
    // "No reports" would be a lie when the request never succeeded.
    await setup({
      listReports: async () => {
        throw new Error("nope");
      },
    });

    await screen.findByText("Could not load reports");
  });

  it("clears only the unresolved reports it confirmed, including ones past the first page", async () => {
    const deleteAllReports = jest.fn(async (_resolved?: boolean) => ({ deleted: 73 }));
    const page = Array.from({ length: 50 }, (_, i) =>
      summary({ id: `r-${i}`, message: `Failure ${i}` }),
    );
    await setup({ listReports: async () => page, deleteAllReports });

    await screen.findByText("Failure 0");
    await fireEvent.press(screen.getByText("Clear all"));
    // Fifty rows on screen, more on the server: the confirmation says so rather than "50".
    expect(
      screen.getByText(/every unresolved incident report, including those beyond the 50/),
    ).toBeTruthy();
    const confirmButtons = screen.getAllByText("Clear all");
    await fireEvent.press(confirmButtons[confirmButtons.length - 1]!);

    await waitFor(() => expect(deleteAllReports).toHaveBeenCalledWith(false));
    expect(await screen.findByText("73 incident reports deleted")).toBeTruthy();
  });

  it("never lets a slower, older list response replace the newer one", async () => {
    let releaseOpen: (rows: BugReportSummary[]) => void = () => {};
    const listReports = jest.fn((params: Parameters<ApiClient["listReports"]>[0]) =>
      params?.resolved === false
        ? new Promise<BugReportSummary[]>((resolve) => (releaseOpen = resolve))
        : Promise.resolve([summary({ id: "r-all", message: "From the all filter" })]),
    );
    await setup({ listReports });
    await waitFor(() => expect(listReports).toHaveBeenCalledTimes(1));

    await fireEvent.press(screen.getByLabelText("All"));
    await screen.findByText("From the all filter");
    // The first request (the "open" filter) finally answers.
    releaseOpen([summary({ id: "r-open", message: "Stale open row" })]);

    await waitFor(() => expect(screen.getByText("From the all filter")).toBeTruthy());
    expect(screen.queryByText("Stale open row")).toBeNull();
  });

  it("asks the server only for unresolved reports by default", async () => {
    const listReports = listMock();
    await setup({ listReports });

    await waitFor(() => expect(listReports).toHaveBeenCalled());
    expect(listReports.mock.calls[0]![0]).toMatchObject({ resolved: false });
  });

  it("clears all reports when confirmed", async () => {
    const deleteAllReports = jest.fn(async () => ({ deleted: 1 }));
    await setup({
      listReports: async () => [summary()],
      deleteAllReports,
    });

    await screen.findByText("Cannot read property of undefined");
    expect(screen.getByText("Clear all")).toBeTruthy();

    await fireEvent.press(screen.getByText("Clear all"));
    expect(screen.getByText("Clear all incidents?")).toBeTruthy();

    // Confirm button in ConfirmDialog
    const confirmButtons = screen.getAllByText("Clear all");
    await fireEvent.press(confirmButtons[confirmButtons.length - 1]!);

    await waitFor(() => expect(deleteAllReports).toHaveBeenCalled());
  });
});
