import { renderHook, act } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { PREFERENCES_ID } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { usePreferences } from "./usePreferences";

/**
 * Defaults (a fresh store has no preference entity, and synced values can be any shape) and write-through
 * (a setting that does not reach the store does not sync). Tests assert the stored field names, the contract with the web.
 */
async function mount(seed: Record<string, unknown> = {}) {
  const store = new LocalStore("test");
  for (const [field, value] of Object.entries(seed)) {
    store.set("preference", PREFERENCES_ID, field, value);
  }
  const view = await renderHook(() => usePreferences(), { wrapper: withApp(store) });
  return { store, view };
}

const read = (store: LocalStore, field: string) =>
  (store.get("preference", PREFERENCES_ID) ?? {})[field];

describe("usePreferences defaults", () => {
  it("has sensible defaults with no preference entity at all", async () => {
    const { view } = await mount();
    expect(view.result.current.theme).toBe("system");
    expect(view.result.current.accent).toBe("indigo");
    expect(view.result.current.timezone).toBe("");
    expect(view.result.current.region).toBe("");
    expect(view.result.current.timeFormat).toBe("auto");
    expect(view.result.current.dateFormat).toBe("auto");
    expect(view.result.current.weekStartsOn).toBe(0);
    expect(view.result.current.defaultView).toBe("today");
    expect(view.result.current.showWeekNumbers).toBe(true);
    expect(view.result.current.toastDuration).toBe(6);
    expect(view.result.current.swipeRightAction).toBe("indent");
    expect(view.result.current.swipeLeftAction).toBe("schedule");
    expect(view.result.current.smartViewInMenu("today")).toBe(true);
  });

  it("falls back to the default when a synced value is nonsense", async () => {
    // Another client (or an older version) can put anything in these fields; an unreadable value
    // must degrade to the default rather than reach a screen.
    const { view } = await mount({
      theme: "chartreuse",
      accent: 7,
      default_view: "settings",
      time_format: true,
      week_starts_on: "monday",
    });
    expect(view.result.current.theme).toBe("system");
    expect(view.result.current.accent).toBe("indigo");
    expect(view.result.current.defaultView).toBe("today");
    expect(view.result.current.timeFormat).toBe("auto");
    expect(view.result.current.weekStartsOn).toBe(0);
  });
});

describe("usePreferences writes", () => {
  it("writes each setting to the field the web reads", async () => {
    const { store, view } = await mount();

    await act(() => view.result.current.setTheme("dark"));
    await act(() => view.result.current.setAccent("emerald"));
    await act(() => view.result.current.setTimezone("Asia/Tokyo"));
    await act(() => view.result.current.setRegion("en-GB"));
    await act(() => view.result.current.setWeekStartsOn(1));
    await act(() => view.result.current.setDefaultView("upcoming"));
    await act(() => view.result.current.setRemindersEnabled(true));
    await act(() => view.result.current.setFocusEnabled(false));
    await act(() => view.result.current.setHapticsEnabled(false));
    await act(() => view.result.current.setShowWeekNumbers(false));
    await act(() => view.result.current.setToastDuration(3));
    await act(() => view.result.current.setSwipeRightAction("complete"));
    await act(() => view.result.current.setSwipeLeftAction("delete"));
    await act(() => view.result.current.setSmartViewInMenu("today", false));

    expect(read(store, "theme")).toBe("dark");
    expect(read(store, "accent")).toBe("emerald");
    expect(read(store, "timezone")).toBe("Asia/Tokyo");
    expect(read(store, "region")).toBe("en-GB");
    expect(read(store, "week_starts_on")).toBe(1);
    expect(read(store, "default_view")).toBe("upcoming");
    expect(read(store, "reminders_enabled")).toBe(true);
    expect(read(store, "focus_enabled")).toBe(false);
    expect(read(store, "haptics_enabled")).toBe(false);
    expect(read(store, "show_week_numbers")).toBe(false);
    expect(read(store, "toast_duration")).toBe(3);
    expect(read(store, "swipe_right_action")).toBe("complete");
    expect(read(store, "swipe_left_action")).toBe("delete");
    expect((read(store, "menu_smart_views") as Record<string, boolean>)?.today).toBe(false);
  });

  it("kicks a sync only through the provider's kick", async () => {
    // The store is the source of truth; the hook must not keep its own copy of a setting.
    const { store, view } = await mount();
    await act(() => view.result.current.setTheme("light"));
    await act(() => {
      store.set("preference", PREFERENCES_ID, "theme", "dark");
    });
    expect(view.result.current.theme).toBe("dark");
  });
});

describe("usePreferences list prefs", () => {
  it("returns the caller's fallback for a view with no stored choice", async () => {
    const { view } = await mount();
    expect(view.result.current.listPrefFor("today", { group: "date", sort: "manual" })).toEqual({
      group: "date",
      sort: "manual",
    });
    expect(view.result.current.listPrefFor("inbox")).toEqual({ group: "none", sort: "manual" });
  });

  it("keeps other views' choices when one view changes", async () => {
    // `list_prefs` is a single LWW field holding every view's setting, so a careless write would
    // drop the others.
    const { store, view } = await mount();
    await act(() => view.result.current.setListPref("today", { group: "priority" }));
    await act(() => view.result.current.setListPref("inbox", { sort: "due" }));

    expect(view.result.current.listPrefFor("today")).toEqual({
      group: "priority",
      sort: "manual",
    });
    expect(view.result.current.listPrefFor("inbox")).toEqual({ group: "none", sort: "due" });
    expect(read(store, "list_prefs")).toEqual({
      today: { group: "priority", sort: "manual" },
      inbox: { group: "none", sort: "due" },
    });
  });

  it("merges a patch into a view's existing choice", async () => {
    const { view } = await mount();
    await act(() => view.result.current.setListPref("all", { group: "project", sort: "alpha" }));
    await act(() => view.result.current.setListPref("all", { sort: "due" }));
    expect(view.result.current.listPrefFor("all")).toEqual({ group: "project", sort: "due" });
  });

  it("guards a nonsense stored list pref", async () => {
    const { view } = await mount({ list_prefs: { today: { group: "banana", sort: 3 } } });
    expect(view.result.current.listPrefFor("today")).toEqual({ group: "none", sort: "manual" });
  });
});

describe("sidebar pins and folder collapse", () => {
  it("defaults every project to pinned and every folder to expanded", async () => {
    // Nothing may vanish from the sidebar on upgrade, and a folder arriving from another device
    // must show its contents rather than looking empty.
    const { view } = await mount();
    expect(view.result.current.projectPinned("p1")).toBe(true);
    expect(view.result.current.folderExpanded("f1")).toBe(true);
  });

  it("keeps the pin on the private preference entity, not the shared project", async () => {
    // A project op fans out to every member of a shared project; a preference does not. Storing
    // the pin on the project would let one member's unpin hide it for everyone.
    const { store, view } = await mount();
    await act(() => view.result.current.setProjectPinned("p1", false));

    expect(view.result.current.projectPinned("p1")).toBe(false);
    expect(read(store, "project_pinned")).toEqual({ p1: false });
    expect(store.get("project", "p1")).toBeNull();
  });

  it("merges into the map rather than replacing it", async () => {
    // One LWW field holds every project, so a stale copy would silently drop the others.
    const { store, view } = await mount({ project_pinned: { a: false } });
    await act(() => view.result.current.setProjectPinned("b", false));
    expect(read(store, "project_pinned")).toEqual({ a: false, b: false });

    await act(() => view.result.current.setFolderExpanded("f1", false));
    await act(() => view.result.current.setFolderExpanded("f2", false));
    expect(read(store, "folder_expanded")).toEqual({ f1: false, f2: false });
  });

  it("guards nonsense stored values", async () => {
    const { view } = await mount({ project_pinned: "nope", folder_expanded: { f1: 7 } });
    expect(view.result.current.projectPinned("p1")).toBe(true);
    expect(view.result.current.folderExpanded("f1")).toBe(true);
  });
});

describe("favorites preference", () => {
  it("sets, gets, and toggles favorite status", async () => {
    const { store, view } = await mount();
    await act(() => view.result.current.setFavorite("project:p1", true));
    expect(view.result.current.isFavorite("project:p1")).toBe(true);
    expect(read(store, "favorites")).toEqual({ "project:p1": true });

    await act(() => view.result.current.toggleFavorite("project:p1"));
    expect(view.result.current.isFavorite("project:p1")).toBe(false);
    expect(read(store, "favorites")).toEqual({ "project:p1": false });

    await act(() => view.result.current.toggleFavorite("view:today"));
    expect(view.result.current.isFavorite("view:today")).toBe(true);
  });

  it("guards nonsense stored values in favorites", async () => {
    const { view } = await mount({ favorites: "invalid" as unknown as Record<string, boolean> });
    expect(view.result.current.isFavorite("project:p1")).toBe(false);
    expect(view.result.current.favorites).toEqual({});
  });
});
