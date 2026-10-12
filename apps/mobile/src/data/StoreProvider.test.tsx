import { Text } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import {
  ApiError,
  MemoryPersistence,
  type ApiClient,
  type Keyring,
  type Persistence,
} from "@atlas/client-core";
import { StoreProvider, useStore } from "./StoreProvider";
import { migrationKeys } from "./localData";
import { quarantineKey } from "./quarantineLog";

/**
 * The real provider over an in-memory database and a server with nothing to sync. The database
 * opener and the local-data reset are injected, as the provider's props allow.
 */
const USER = "u-1";

function quietApi(overrides: Record<string, unknown> = {}): ApiClient {
  return {
    setLegacyMigrated: () => {},
    isLegacyMigrated: () => true,
    setScopeContext: () => {},
    syncWsUrl: async () => null,
    getAttachmentConfig: () => new Promise(() => {}),
    syncPush: async () => ({ cursor: 0, applied: 0 }),
    syncPull: async () => ({ operations: [], cursor: 0 }),
    ...overrides,
  } as unknown as ApiClient;
}

const keyring = { hasKeys: () => false } as unknown as Keyring;

function Probe() {
  const { store } = useStore();
  return <Text>{`loaded ${store.list("task").length}`}</Text>;
}

async function mount(props: {
  openPersistence: (userId: string) => Promise<Persistence>;
  resetLocalData?: (userId: string) => Promise<void>;
  api?: ApiClient;
}) {
  const { api = quietApi(), ...rest } = props;
  return await render(
    <StoreProvider api={api} deviceId="d-1" userId={USER} keyring={keyring} {...rest}>
      <Probe />
    </StoreProvider>,
  );
}

describe("StoreProvider loading the local database", () => {
  it("shows the failure with Retry instead of loading forever, and loads on retry", async () => {
    const open = jest
      .fn<Promise<Persistence>, [string]>()
      .mockRejectedValueOnce(new Error("database disk image is malformed"))
      .mockResolvedValue(new MemoryPersistence());
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const view = await mount({ openPersistence: open });

    expect(await screen.findByText("database disk image is malformed")).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(
      "[atlas] could not load the local database:",
      expect.objectContaining({ message: "database disk image is malformed" }),
    );
    await fireEvent.press(screen.getByText("Retry"));
    expect(await screen.findByText("loaded 0")).toBeTruthy();
    await view.unmount();
    warn.mockRestore();
  });

  it("offers to reset the local data, then loads again", async () => {
    const open = jest
      .fn<Promise<Persistence>, [string]>()
      .mockRejectedValueOnce(new Error("VersionError"))
      .mockResolvedValue(new MemoryPersistence());
    const reset = jest.fn(async (_userId: string) => {});
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const view = await mount({ openPersistence: open, resetLocalData: reset });

    await fireEvent.press(await screen.findByText("Reset local data"));
    await screen.findByText("Reset local data?");
    // The dialog's confirm button carries the same label as the one that opened it.
    const [, confirm] = screen.getAllByText("Reset local data");
    await fireEvent.press(confirm!);
    await waitFor(() => expect(reset).toHaveBeenCalledWith(USER));
    expect(await screen.findByText("loaded 0")).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(
      "[atlas] could not load the local database:",
      expect.objectContaining({ message: "VersionError" }),
    );
    await view.unmount();
    warn.mockRestore();
  });
});

describe("StoreProvider resuming sync", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    // The one-time migrations ran on an earlier launch.
    await AsyncStorage.setItem(migrationKeys(USER).atomicSync, "true");
    await AsyncStorage.setItem(migrationKeys(USER).e2ee, "true");
  });

  it("resumes from the saved cursor for an account that holds only habits", async () => {
    const persistence = new MemoryPersistence();
    await persistence.append(
      {
        id: "op-1",
        entity: "habit",
        entityId: "h1",
        ts: { wallMs: 1000, counter: 0, node: "00000000-0000-0000-0000-0000000000b1" },
        op: "set",
        field: "name",
        value: "Walk",
      },
      true,
    );
    await persistence.setCursor(50);
    const syncPull = jest.fn(async (since: number) => ({ operations: [], cursor: since }));
    const view = await mount({
      openPersistence: async () => persistence,
      api: quietApi({ syncPull }),
    });

    await waitFor(() => expect(syncPull).toHaveBeenCalled());
    expect(syncPull.mock.calls[0]![0]).toBe(50);
    expect(await persistence.getCursor()).toBe(50);
    await view.unmount();
  });
});

describe("StoreProvider resync", () => {
  let resync: (() => Promise<"postponed" | void>) | undefined;
  function ResyncProbe() {
    ({ resync } = useStore());
    return <Text>ready</Text>;
  }

  it("hands a failed cycle to its caller instead of swallowing it", async () => {
    // Sync details reports the outcome, so a failure must reach it.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const syncPull = jest
      .fn(async (since: number) => ({ operations: [], cursor: since }))
      .mockResolvedValueOnce({ operations: [], cursor: 0 })
      .mockRejectedValue(new Error("Network request failed"));
    const view = await render(
      <StoreProvider
        api={quietApi({ syncPull })}
        deviceId="d-1"
        userId={USER}
        keyring={keyring}
        openPersistence={async () => new MemoryPersistence()}
      >
        <ResyncProbe />
      </StoreProvider>,
    );
    await screen.findByText("ready");
    await waitFor(() => expect(syncPull).toHaveBeenCalledTimes(1));

    let outcome: Promise<unknown> = Promise.resolve();
    await act(async () => {
      outcome = resync!().catch((err: unknown) => err);
      await outcome;
    });
    expect(await outcome).toEqual(new Error("Network request failed"));
    await view.unmount();
    warn.mockRestore();
  });
});

describe("StoreProvider unmounting", () => {
  it("writes what is queued, then closes the database", async () => {
    const persistence = new MemoryPersistence();
    const close = jest.spyOn(persistence, "close");
    const view = await mount({ openPersistence: async () => persistence });
    await screen.findByText("loaded 0");

    await view.unmount();
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
});

describe("StoreProvider E2EE migration walk", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    await AsyncStorage.setItem(migrationKeys(USER).atomicSync, "true");
  });

  it("starts the walk from page 1 on the migration's first launch", async () => {
    const persistence = new MemoryPersistence();
    await persistence.setCursor(40);
    const syncSnapshot = jest.fn(async (_next?: string) => ({ operations: [], cursor: 40 }));
    // A saved cursor over an empty store is what the sync client treats as lost entities.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const view = await mount({
      openPersistence: async () => persistence,
      api: quietApi({ syncSnapshot, isLegacyMigrated: () => false }),
    });

    await waitFor(() => expect(syncSnapshot).toHaveBeenCalled());
    expect(syncSnapshot.mock.calls[0]![0]).toBeUndefined();
    expect(await AsyncStorage.getItem(migrationKeys(USER).e2eeWalk)).toBe("true");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("rebuilding from the snapshot"));
    await view.unmount();
    warn.mockRestore();
  });

  it("continues a walk an earlier launch started, instead of going back to page 1", async () => {
    await AsyncStorage.setItem(migrationKeys(USER).e2eeWalk, "true");
    const persistence = new MemoryPersistence();
    await persistence.setBootstrap({ next: "page-7", cursor: 40 });
    const syncSnapshot = jest.fn(async (_next?: string) => ({ operations: [], cursor: 40 }));
    // A saved cursor over an empty store is what the sync client treats as lost entities.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const view = await mount({
      openPersistence: async () => persistence,
      api: quietApi({ syncSnapshot, isLegacyMigrated: () => false }),
    });

    await waitFor(() => expect(syncSnapshot).toHaveBeenCalled());
    expect(syncSnapshot.mock.calls[0]![0]).toBe("page-7");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("rebuilding from the snapshot"));
    await view.unmount();
    warn.mockRestore();
  });
});

describe("StoreProvider in local-only mode", () => {
  function LocalProbe() {
    const { store, localOnly, initialSyncDone } = useStore();
    return (
      <Text>{`local ${String(localOnly)} ready ${String(initialSyncDone)} tasks ${store.list("task").length}`}</Text>
    );
  }

  it("loads without a server, trims superseded history, and records the database", async () => {
    const persistence = new MemoryPersistence();
    const node = "00000000-0000-0000-0000-0000000010ca";
    const ts = (wallMs: number) => ({ wallMs, counter: 0, node });
    await persistence.append(
      {
        id: "a",
        entity: "task",
        entityId: "t1",
        ts: ts(1),
        op: "set",
        field: "title",
        value: "v1",
      },
      false,
    );
    await persistence.append(
      {
        id: "b",
        entity: "task",
        entityId: "t1",
        ts: ts(2),
        op: "set",
        field: "title",
        value: "v2",
      },
      false,
    );
    const open = jest.fn(async (_userId: string) => persistence as Persistence);

    const view = await render(
      <StoreProvider
        api={null}
        deviceId={node}
        userId="local"
        keyring={null}
        openPersistence={open}
      >
        <LocalProbe />
      </StoreProvider>,
    );

    expect(await screen.findByText("local true ready true tasks 1")).toBeTruthy();
    expect(open).toHaveBeenCalledWith("local", expect.anything());
    expect((await persistence.load()).map((r) => r.op.id)).toEqual(["b"]);
    expect(await AsyncStorage.getItem("@atlas_local_db_used")).toBe("1");
    await view.unmount();
  });
});

describe("StoreProvider rejected changes", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    await AsyncStorage.setItem(migrationKeys(USER).atomicSync, "true");
    await AsyncStorage.setItem(migrationKeys(USER).e2ee, "true");
  });

  let dismiss: ((opId?: string) => void) | undefined;
  function QuarantineProbe() {
    const { diagnostics, dismissQuarantined } = useStore();
    dismiss = dismissQuarantined;
    return (
      <Text>{`rejected ${diagnostics.quarantined.map((q) => q.opId).join(",") || "none"}`}</Text>
    );
  }

  async function mountProbe(persistence: Persistence, api: ApiClient) {
    return await render(
      <StoreProvider
        api={api}
        deviceId="d-1"
        userId={USER}
        keyring={keyring}
        openPersistence={async () => persistence}
      >
        <QuarantineProbe />
      </StoreProvider>,
    );
  }

  async function saved(): Promise<string[]> {
    const raw = await AsyncStorage.getItem(quarantineKey(USER));
    return raw ? (JSON.parse(raw) as { opId: string }[]).map((q) => q.opId) : [];
  }

  it("keeps a change the server rejected listed after a restart, until it is dismissed", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const persistence = new MemoryPersistence();
    await persistence.append(
      {
        id: "op-x",
        entity: "task",
        entityId: "t1",
        ts: { wallMs: 1000, counter: 0, node: "00000000-0000-0000-0000-0000000000d1" },
        op: "set",
        field: "title",
        value: "Shared",
      },
      false,
    );
    const syncPush = jest.fn(async () => {
      throw new ApiError(403, "no edit access to this project");
    });
    const first = await mountProbe(persistence, quietApi({ syncPush }));
    expect(await screen.findByText("rejected op-x")).toBeTruthy();
    await waitFor(async () => expect(await saved()).toEqual(["op-x"]));
    await first.unmount();

    // The next launch pushes nothing (the change was taken back), yet still lists it.
    const second = await mountProbe(new MemoryPersistence(), quietApi());
    expect(await screen.findByText("rejected op-x")).toBeTruthy();

    await act(async () => dismiss!("op-x"));
    expect(await screen.findByText("rejected none")).toBeTruthy();
    await waitFor(async () => expect(await saved()).toEqual([]));
    await second.unmount();

    const third = await mountProbe(new MemoryPersistence(), quietApi());
    expect(await screen.findByText("rejected none")).toBeTruthy();
    await third.unmount();
    warn.mockRestore();
  });

  it("clears every entry at once", async () => {
    const entry = (opId: string, at: number) => ({
      opId,
      entityKind: "task",
      entityId: "t1",
      status: 403,
      message: "forbidden",
      at,
    });
    await AsyncStorage.setItem(
      quarantineKey(USER),
      JSON.stringify([entry("op-a", 2), entry("op-b", 1)]),
    );
    const view = await mountProbe(new MemoryPersistence(), quietApi());
    expect(await screen.findByText("rejected op-a,op-b")).toBeTruthy();

    await act(async () => dismiss!());
    expect(await screen.findByText("rejected none")).toBeTruthy();
    await waitFor(async () => expect(await AsyncStorage.getItem(quarantineKey(USER))).toBeNull());
    await view.unmount();
  });

  it("does not show another account's entries", async () => {
    await AsyncStorage.setItem(
      quarantineKey("u-2"),
      JSON.stringify([
        { opId: "op-other", entityKind: "task", entityId: "t9", message: "forbidden", at: 1 },
      ]),
    );
    const view = await mountProbe(new MemoryPersistence(), quietApi());
    expect(await screen.findByText("rejected none")).toBeTruthy();
    await view.unmount();
  });
});
