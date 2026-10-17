import { Text } from "react-native";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { Operation } from "@atlastodo/client-core";
import { LocalUpgradeGate } from "./LocalUpgradeGate";
import {
  discardLocalData,
  moveLocalDataInto,
  readLocalData,
  type LocalSnapshot,
} from "../data/localUpgrade";

jest.mock("../data/localUpgrade", () => ({
  ...jest.requireActual<typeof import("../data/localUpgrade")>("../data/localUpgrade"),
  readLocalData: jest.fn(),
  moveLocalDataInto: jest.fn(async () => {}),
  discardLocalData: jest.fn(async () => {}),
}));

const NODE = "00000000-0000-0000-0000-0000000010ca";
const op = (id: string, entity: Operation["entity"]): Operation => ({
  id,
  entity,
  entityId: `${entity}-1`,
  ts: { wallMs: 1, counter: 0, node: NODE },
  op: "set",
  field: "title",
  value: id,
});
const TASK = op("task-op", "task");
const PREF = op("pref-op", "preference");

function snapshot(itemCount: number, ops = [TASK, PREF]): LocalSnapshot {
  return { ops, itemCount };
}

async function mount(intent: "login" | "signup" | null) {
  await render(
    <LocalUpgradeGate userId="u1" accountLabel="ada@example.com" intentOverride={intent}>
      <Text>ACCOUNT APP</Text>
    </LocalUpgradeGate>,
  );
}

beforeEach(() => jest.clearAllMocks());

describe("LocalUpgradeGate", () => {
  it("opens the account at once when there is no local data", async () => {
    jest.mocked(readLocalData).mockResolvedValue(null);
    await mount("login");
    expect(await screen.findByText("ACCOUNT APP")).toBeTruthy();
    expect(moveLocalDataInto).not.toHaveBeenCalled();
  });

  it("moves everything, settings included, into a new account without asking", async () => {
    jest.mocked(readLocalData).mockResolvedValue(snapshot(1));
    await mount("signup");
    expect(await screen.findByText("ACCOUNT APP")).toBeTruthy();
    expect(moveLocalDataInto).toHaveBeenCalledWith("u1", [TASK, PREF]);
  });

  it("drops settings-only local data without asking on a sign-in", async () => {
    jest.mocked(readLocalData).mockResolvedValue(snapshot(0, [PREF]));
    await mount("login");
    expect(await screen.findByText("ACCOUNT APP")).toBeTruthy();
    expect(discardLocalData).toHaveBeenCalled();
    expect(moveLocalDataInto).not.toHaveBeenCalled();
  });

  it("asks before merging into an existing account, and leaves the settings behind", async () => {
    jest.mocked(readLocalData).mockResolvedValue(snapshot(1));
    // After a restart the intent is unknown: asked, like a sign-in.
    await mount(null);
    expect(await screen.findByText("Bring your local data?")).toBeTruthy();
    expect(screen.getByText(/1 item .* Merge it into ada@example.com\?/)).toBeTruthy();
    expect(screen.queryByText("ACCOUNT APP")).toBeNull();

    await fireEvent.press(screen.getByLabelText("Merge into my account"));
    expect(await screen.findByText("ACCOUNT APP")).toBeTruthy();
    expect(moveLocalDataInto).toHaveBeenCalledWith("u1", [TASK]);
  });

  it("discards only after a confirmation", async () => {
    jest.mocked(readLocalData).mockResolvedValue(snapshot(2));
    await mount("login");
    await fireEvent.press(await screen.findByLabelText("Discard local data"));
    expect(screen.getByText("Discard local data?")).toBeTruthy();

    // Backing out returns to the question with nothing deleted.
    await fireEvent.press(screen.getByLabelText("Cancel"));
    expect(discardLocalData).not.toHaveBeenCalled();
    expect(screen.queryByText("Discard local data?")).toBeNull();

    await fireEvent.press(screen.getByLabelText("Discard local data"));
    const buttons = screen.getAllByLabelText("Discard local data");
    await fireEvent.press(buttons[buttons.length - 1]!);
    await waitFor(() => expect(discardLocalData).toHaveBeenCalled());
    expect(await screen.findByText("ACCOUNT APP")).toBeTruthy();
    expect(moveLocalDataInto).not.toHaveBeenCalled();
  });

  it("opens the account, keeping the local data, when the move fails", async () => {
    jest.mocked(readLocalData).mockResolvedValue(snapshot(1));
    jest.mocked(moveLocalDataInto).mockRejectedValueOnce(new Error("disk full"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await mount("signup");
    expect(await screen.findByText("ACCOUNT APP")).toBeTruthy();
    expect(discardLocalData).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
