import { Keyboard } from "react-native";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { LocalStore, type ApiClient, type BugReportPayload } from "@atlastodo/client-core";
import { ReportProblemSheet } from "./ReportProblemSheet";
import { withApp, fakeAuth } from "../testutil";
import {
  __resetReporterForTests,
  captureError,
  configureReporter,
  setReporter,
} from "../lib/crashReporter";
import { __setQueueStorageForTests, type QueueStorage } from "../lib/reportQueue";

function fakeStorage(): QueueStorage {
  const data: Record<string, string> = {};
  return {
    getItem: async (key) => data[key] ?? null,
    setItem: async (key, value) => {
      data[key] = value;
    },
  };
}

type SubmitMock = jest.Mock<Promise<void>, [BugReportPayload]>;

function submitter(): SubmitMock {
  return jest.fn(async (_report: BugReportPayload) => {}) as SubmitMock;
}

async function setup(submit: SubmitMock = submitter()) {
  __resetReporterForTests();
  __setQueueStorageForTests(fakeStorage());
  configureReporter({
    newId: () => "0198ab00-0000-7000-8000-000000000001",
    appVersion: "0.18.0",
    platform: "ios",
    osVersion: "18.0",
  });
  setReporter({ api: { submitReport: submit } as unknown as ApiClient });

  const store = new LocalStore("device-1");
  await render(<ReportProblemSheet open onClose={() => {}} />, {
    wrapper: withApp(store, fakeAuth()),
  });
  return { store, submit };
}

describe("ReportProblemSheet", () => {
  it("sends what the user typed", async () => {
    const submit = submitter();
    await setup(submit);

    await fireEvent.changeText(screen.getByLabelText("What happened?"), "It froze on Today");
    await fireEvent.press(screen.getByText("Send report"));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const payload = submit.mock.calls[0]![0];
    expect(payload.description).toBe("It froze on Today");
    expect(payload.kind).toBe("manual");
  });

  it("will not send an empty report", async () => {
    // An empty description carries no more information than a crash report already would.
    const { submit } = await setup();

    await fireEvent.press(screen.getByText("Send report"));

    expect(submit).not.toHaveBeenCalled();
  });

  it("sends exactly the report it previewed, description included", async () => {
    const submit = submitter();
    await setup(submit);

    await fireEvent.changeText(screen.getByLabelText("What happened?"), "It froze on Today");
    await fireEvent.press(screen.getByText("Show the full report"));
    const shown = JSON.parse(screen.getByText(/"kind": "manual"/).props.children as string);
    await fireEvent.press(screen.getByText("Send report"));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]![0]).toEqual(shown);
    expect(shown.description).toBe("It froze on Today");
  });

  it("still sends a manual report after a crash loop used up the automatic ones", async () => {
    const submit = submitter();
    await setup(submit);
    for (let i = 0; i < 6; i++) await captureError(new Error(`crash ${i}`), "crash");
    submit.mockClear();

    await fireEvent.changeText(screen.getByLabelText("What happened?"), "It keeps crashing");
    await fireEvent.press(screen.getByText("Send report"));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]![0].description).toBe("It keeps crashing");
  });

  it("shows no task content in the preview", async () => {
    // The claim above has to hold against a store with real content in it.
    const { store } = await setup();
    await act(() =>
      store.set("task", "0198ab00-0000-7000-8000-0000000000aa", "title", "Buy anniversary flowers"),
    );

    await fireEvent.press(screen.getByText("Show the full report"));

    await waitFor(() => expect(screen.queryByText("Hide the full report")).toBeTruthy());
    expect(screen.queryByText(/Buy anniversary flowers/)).toBeNull();
  });

  it("dismisses the keyboard when Done button is pressed on mobile", async () => {
    const dismissSpy = jest.spyOn(Keyboard, "dismiss");
    await setup();

    const doneButton = screen.getByLabelText("Done");
    expect(doneButton).toBeTruthy();
    await fireEvent.press(doneButton);

    expect(dismissSpy).toHaveBeenCalled();
    dismissSpy.mockRestore();
  });
});
