import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlas/client-core";
import { PREFERENCES_ID } from "@atlas/shared";
import { fakeAuth, withApp, lastCopiedText } from "../testutil";
import appConfig from "../../app.json";
import { AboutScreen, noticesUrl } from "./AboutScreen";

// The version this build was made from -- never a number written into the screen.
const VERSION = appConfig.expo.version;

async function mount(seed: Record<string, unknown> = {}) {
  const store = new LocalStore("test");
  for (const [field, value] of Object.entries(seed)) {
    store.set("preference", PREFERENCES_ID, field, value);
  }
  const auth = fakeAuth({
    session: {
      accessToken: "a",
      refreshToken: "r",
      deviceId: "d",
      user: { id: "u1", email: "mikkel@example.com", display_name: "Mikkel" },
    },
  });
  await render(<AboutScreen />, { wrapper: withApp(store, auth) });
  return store;
}

describe("AboutScreen", () => {
  it("copies system info to clipboard when 'Copy system info' is pressed", async () => {
    await mount({ theme: "dark", accent: "violet" });
    const copyButton = screen.getByLabelText("Copy system info");
    await act(async () => {
      await fireEvent.press(copyButton);
    });

    const copied = lastCopiedText();
    expect(copied).not.toBeNull();
    expect(copied).toContain(`Atlas Todo v${VERSION}`);
    expect(copied).toContain("Theme: dark, Accent: violet");
  });
});

describe("noticesUrl", () => {
  it("points at the notices asset of this version's release, or nowhere without a repository", () => {
    expect(noticesUrl("https://github.com/atlastodo/atlas-todo", "0.1.10")).toBe(
      "https://github.com/atlastodo/atlas-todo/releases/download/v0.1.10/THIRD_PARTY_NOTICES.txt",
    );
    expect(noticesUrl(null, "0.1.10")).toBeNull();
  });
});
