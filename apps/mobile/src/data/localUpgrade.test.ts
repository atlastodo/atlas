import AsyncStorage from "@react-native-async-storage/async-storage";
import { LocalStore, MemoryPersistence } from "@atlastodo/client-core";
import { PREFERENCES_ID } from "@atlastodo/shared";
import {
  markLocalDataUsed,
  moveLocalDataInto,
  readLocalData,
  withoutSettings,
} from "./localUpgrade";

// One in-memory database per scope, standing in for `atlas-<scope>`.
const mockDatabases = new Map<string, MemoryPersistence>();
const mockDb = (scope: string) => {
  const existing = mockDatabases.get(scope);
  if (existing) return existing;
  const created = new MemoryPersistence();
  mockDatabases.set(scope, created);
  return created;
};
jest.mock("./persistence", () => ({
  createPersistence: async (scope: string) => mockDb(scope),
}));
jest.mock("./localData", () => ({
  deleteLocalData: async (scope: string) => {
    mockDatabases.delete(scope);
  },
}));

const NODE = "00000000-0000-0000-0000-0000000010ca";

/** Write through a real store over the local database, as the local-only app does. */
async function writeLocally(edit: (store: LocalStore) => void) {
  await markLocalDataUsed();
  let n = 0;
  const store = new LocalStore(NODE, { persistence: mockDb("local"), newId: () => `id-${n++}` });
  edit(store);
  await store.flush();
}

beforeEach(async () => {
  mockDatabases.clear();
  await AsyncStorage.clear();
});

describe("local data upgrade", () => {
  it("has nothing to move before local-only mode was used", async () => {
    expect(await readLocalData()).toBeNull();
    expect(mockDatabases.has("local")).toBe(false);
  });

  it("reads the current state only, counting items but not settings", async () => {
    await writeLocally((store) => {
      store.set("task", "t1", "title", "draft");
      store.set("task", "t1", "title", "final");
      store.set("project", "p1", "name", "Home");
      store.set("preference", PREFERENCES_ID, "theme", "dark");
    });
    const snapshot = await readLocalData();
    expect(snapshot?.itemCount).toBe(2);
    expect(snapshot?.ops.map((o) => [o.entity, o.op === "set" ? o.value : null])).toEqual([
      ["task", "final"],
      ["project", "Home"],
      ["preference", "dark"],
    ]);
    expect(withoutSettings(snapshot!.ops).map((o) => o.entity)).toEqual(["task", "project"]);
  });

  it("moves the ops into the account as unsynced and deletes the local database", async () => {
    await writeLocally((store) => store.set("task", "t1", "title", "Buy milk"));
    const snapshot = (await readLocalData())!;
    await moveLocalDataInto("u1", snapshot.ops);

    const rows = await mockDb("u1").load();
    expect(rows.map((r) => [r.op.id, r.synced])).toEqual([[snapshot.ops[0]!.id, false]]);
    expect(mockDatabases.has("local")).toBe(false);
    expect(await readLocalData()).toBeNull();

    const account = new LocalStore("account-device", { persistence: mockDb("u1") });
    await account.hydrate();
    expect(account.get("task", "t1")).toEqual({ title: "Buy milk" });
    expect(account.unsyncedOps()).toHaveLength(1);
  });
});
