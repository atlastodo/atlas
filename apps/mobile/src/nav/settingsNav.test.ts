import { settingsSections } from "./settingsNav";

describe("settingsSections", () => {
  afterEach(() => {
    delete (window as unknown as { atlasDesktop?: unknown }).atlasDesktop;
  });

  it("lists Desktop app only inside the desktop app", () => {
    expect(settingsSections(false).map((s) => s.id)).not.toContain("desktop");
    (window as unknown as { atlasDesktop?: unknown }).atlasDesktop = {};
    expect(settingsSections(false).map((s) => s.id)).toContain("desktop");
  });
});

describe("settingsSections: API tokens", () => {
  it("lists API tokens next to Devices, but not in local-only mode", () => {
    const ids = settingsSections(false).map((s) => s.id);
    expect(ids.indexOf("apiTokens")).toBe(ids.indexOf("devices") + 1);
    expect(settingsSections(false, true).map((s) => s.id)).not.toContain("apiTokens");
  });
});
