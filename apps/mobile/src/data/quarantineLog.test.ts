import AsyncStorage from "@react-native-async-storage/async-storage";
import { deleteLocalData, migrationKeys } from "./localData";
import {
  MAX_QUARANTINED,
  loadQuarantined,
  mergeQuarantined,
  quarantineKey,
  saveQuarantined,
} from "./quarantineLog";
import type { QuarantinedOp } from "./StoreProvider";

jest.mock("./persistence", () => ({
  createPersistence: async () => {
    throw new Error("not used");
  },
  deleteDatabase: async () => {},
}));

const entry = (n: number): QuarantinedOp => ({
  opId: `op-${n}`,
  entityKind: "task",
  entityId: `t-${n}`,
  status: 403,
  message: "forbidden",
  at: n,
});

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe("the rejected-changes list", () => {
  it("keeps only the newest entries, each op once", () => {
    const many = Array.from({ length: MAX_QUARANTINED + 10 }, (_, i) => entry(i));
    const merged = mergeQuarantined([entry(5)], many);
    expect(merged).toHaveLength(MAX_QUARANTINED);
    expect(merged[0]!.opId).toBe(`op-${MAX_QUARANTINED + 9}`);
    expect(merged.at(-1)!.opId).toBe("op-10");
    expect(new Set(merged.map((q) => q.opId)).size).toBe(MAX_QUARANTINED);
  });

  it("saves capped, and loads only well-formed entries", async () => {
    await saveQuarantined(
      "u-1",
      Array.from({ length: MAX_QUARANTINED + 5 }, (_, i) => entry(100 - i)),
    );
    expect(await loadQuarantined("u-1")).toHaveLength(MAX_QUARANTINED);

    await AsyncStorage.setItem(quarantineKey("u-1"), JSON.stringify([entry(1), { opId: 3 }]));
    expect(await loadQuarantined("u-1")).toEqual([entry(1)]);

    await AsyncStorage.setItem(quarantineKey("u-1"), "not json");
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadQuarantined("u-1")).toEqual([]);
    warn.mockRestore();
  });

  it("is deleted with the account's local data on sign-out, and only that account's", async () => {
    await saveQuarantined("u-1", [entry(1)]);
    await saveQuarantined("u-2", [entry(2)]);
    await AsyncStorage.setItem(migrationKeys("u-1").e2ee, "true");

    await deleteLocalData("u-1");

    expect(await AsyncStorage.getItem(quarantineKey("u-1"))).toBeNull();
    expect(await AsyncStorage.getItem(migrationKeys("u-1").e2ee)).toBeNull();
    expect(await loadQuarantined("u-2")).toEqual([entry(2)]);
  });
});
