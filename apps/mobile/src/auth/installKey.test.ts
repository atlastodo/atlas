import { Platform } from "react-native";
import { getInstallKey } from "./installKey";

const mockKeychain = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async (k: string) => mockKeychain.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockKeychain.set(k, v)),
}));
jest.mock("expo-application", () => ({ getAndroidId: () => "android-id-1234" }));
let mockUuid = 0;
jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: jest.fn(async (_alg: string, data: string) => `sha256(${data})`),
  randomUUID: () => `uuid-${++mockUuid}`,
}));

function onPlatform(os: typeof Platform.OS) {
  Object.defineProperty(Platform, "OS", { value: os, configurable: true });
}

const originalOS = Platform.OS;
afterEach(() => {
  onPlatform(originalOS);
  mockKeychain.clear();
});

describe("getInstallKey", () => {
  it("sends a hash of the Android ID on Android, never the ID itself", async () => {
    onPlatform("android");
    await expect(getInstallKey()).resolves.toBe("sha256(atlas-install-key:android-id-1234)");
  });

  it("mints one keychain value on iOS and keeps answering with it", async () => {
    onPlatform("ios");
    const first = await getInstallKey();
    expect(first).toBe("sha256(atlas-install-key:uuid-1)");
    await expect(getInstallKey()).resolves.toBe(first);
  });
});
