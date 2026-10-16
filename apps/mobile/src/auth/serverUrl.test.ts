import AsyncStorage from "@react-native-async-storage/async-storage";
import { loadServerUrl } from "./serverUrl";

type Desktop = { serverUrl?: { set?: (url: string) => Promise<unknown> } };
const win = globalThis as { atlasDesktop?: Desktop };

describe("loadServerUrl", () => {
  afterEach(async () => {
    delete win.atlasDesktop;
    await AsyncStorage.clear();
  });

  it("reports the resolved server to the desktop shell", async () => {
    const set = jest.fn(async () => false);
    win.atlasDesktop = { serverUrl: { set } };
    await AsyncStorage.setItem("atlas.serverUrl", "http://192.168.1.10:8080");
    await expect(loadServerUrl()).resolves.toBe("http://192.168.1.10:8080");
    expect(set).toHaveBeenCalledWith("http://192.168.1.10:8080");
  });

  it("still resolves under a shell without the bridge, or one whose call fails", async () => {
    await AsyncStorage.setItem("atlas.serverUrl", "https://atlas.example");
    await expect(loadServerUrl()).resolves.toBe("https://atlas.example");
    win.atlasDesktop = { serverUrl: { set: async () => Promise.reject(new Error("no handler")) } };
    await expect(loadServerUrl()).resolves.toBe("https://atlas.example");
  });
});
