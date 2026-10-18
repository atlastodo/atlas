import { describe, expect, it } from "vitest";
import type { Project } from "@atlastodo/client-core";
import {
  buildProjectTree,
  flattenProjectTree,
  hiddenProjectIds,
  moveProjectTarget,
  pinnedProjectTree,
  projectAncestors,
  projectDescendantIds,
  wouldCycleProject,
} from "./projectTree";

/**
 * The project forest: folders containing projects (and other folders), the pin filter the sidebar
 * reads, and the cycle guard that is the *only* enforcement there is; the server validates a
 * parent only on its REST path, which the sync path never takes.
 */

function p(id: string, over: Partial<Project> = {}): Project {
  return {
    id,
    owner_id: "u1",
    name: id,
    color: "",
    icon: "",
    sort_order: 0,
    is_favorite: true,
    parent_id: null,
    kind: "project",
    default_view: "list",
    archived_at: null,
    deleted_at: null,
    ...over,
  };
}
const folder = (id: string, over: Partial<Project> = {}): Project =>
  p(id, { kind: "folder", ...over });

const ids = (rows: { project: Project }[]): string[] => rows.map((r) => r.project.id);
const depths = (rows: { depth: number }[]): number[] => rows.map((r) => r.depth);

describe("buildProjectTree", () => {
  it("nests projects under their folder, arbitrarily deep", () => {
    const set = [
      folder("work", { sort_order: 1 }),
      folder("clients", { parent_id: "work" }),
      p("acme", { parent_id: "clients" }),
      p("inbox", { sort_order: 2 }),
    ];
    expect(ids(flattenProjectTree(set))).toEqual(["work", "clients", "acme", "inbox"]);
    expect(depths(flattenProjectTree(set))).toEqual([0, 1, 2, 0]);
  });

  it("orders siblings by sort_order then name", () => {
    const set = [
      p("b", { sort_order: 2, name: "b" }),
      p("a", { sort_order: 1, name: "a" }),
      p("d", { sort_order: 3, name: "d" }),
      p("c", { sort_order: 3, name: "c" }),
    ];
    expect(ids(flattenProjectTree(set))).toEqual(["a", "b", "c", "d"]);
  });

  it("renders an orphan at the root rather than dropping it", () => {
    // A co-member receives your `parent_id` naming a folder that was never shared with them. It has
    // to show up somewhere, so it shows up at the top level.
    const set = [p("shared", { parent_id: "a-folder-i-cannot-see" })];
    const rows = flattenProjectTree(set);
    expect(ids(rows)).toEqual(["shared"]);
    expect(rows[0]!.depth).toBe(0);
  });

  it("reports which rows have children", () => {
    const set = [folder("work"), p("acme", { parent_id: "work" })];
    const rows = flattenProjectTree(set);
    expect(rows[0]!.hasChildren).toBe(true);
    expect(rows[0]!.childCount).toBe(1);
    expect(rows[1]!.hasChildren).toBe(false);
  });

  it("keeps a collapsed folder's own row but hides its descendants", () => {
    const set = [
      folder("work", { sort_order: 1 }),
      folder("clients", { parent_id: "work" }),
      p("acme", { parent_id: "clients" }),
      p("inbox", { sort_order: 2 }),
    ];
    expect(ids(flattenProjectTree(set, new Set(["work"])))).toEqual(["work", "inbox"]);
    expect(ids(flattenProjectTree(set, new Set(["clients"])))).toEqual([
      "work",
      "clients",
      "inbox",
    ]);
  });

  it("exposes the nested shape too", () => {
    const tree = buildProjectTree([folder("work"), p("acme", { parent_id: "work" })]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children.map((c) => c.project.id)).toEqual(["acme"]);
  });
});

describe("ancestors and descendants", () => {
  const set = [
    folder("work"),
    folder("clients", { parent_id: "work" }),
    p("acme", { parent_id: "clients" }),
    p("inbox"),
  ];

  it("walks ancestors nearest-first", () => {
    expect(projectAncestors(set, "acme").map((a) => a.id)).toEqual(["clients", "work"]);
    expect(projectAncestors(set, "inbox")).toEqual([]);
  });

  it("collects descendants, excluding the node itself", () => {
    expect([...projectDescendantIds(set, "work")].sort()).toEqual(["acme", "clients"]);
    expect([...projectDescendantIds(set, "acme")]).toEqual([]);
  });

  it("terminates on data that already contains a cycle", () => {
    const bad = [
      folder("a", { parent_id: "b" }),
      folder("b", { parent_id: "a" }),
      p("x", { parent_id: "a" }),
    ];
    expect(projectAncestors(bad, "x").map((a) => a.id).length).toBeLessThanOrEqual(2);
    expect([...projectDescendantIds(bad, "a")].sort()).toEqual(["b", "x"]);
  });
});

describe("wouldCycleProject", () => {
  const set = [
    folder("work"),
    folder("clients", { parent_id: "work" }),
    p("acme", { parent_id: "clients" }),
  ];

  it("rejects a move into itself or its own subtree", () => {
    expect(wouldCycleProject(set, "work", "work")).toBe(true);
    expect(wouldCycleProject(set, "work", "clients")).toBe(true);
    expect(wouldCycleProject(set, "work", "acme")).toBe(true);
  });

  it("allows a move to the root or to an unrelated folder", () => {
    expect(wouldCycleProject(set, "acme", null)).toBe(false);
    expect(wouldCycleProject(set, "acme", "work")).toBe(false);
  });

  it("does not hang on a pre-existing cycle in the data", () => {
    const bad = [folder("a", { parent_id: "b" }), folder("b", { parent_id: "a" }), p("x")];
    expect(wouldCycleProject(bad, "x", "a")).toBe(false);
  });
});

describe("moveProjectTarget", () => {
  it("ranks the moved project last among its new siblings", () => {
    const set = [
      folder("work"),
      p("a", { parent_id: "work", sort_order: 10 }),
      p("b", { parent_id: "work", sort_order: 20 }),
      p("loose", { sort_order: 5 }),
    ];
    const target = moveProjectTarget(set, "loose", "work");
    expect(target?.parent_id).toBe("work");
    expect(target!.sort_order).toBeGreaterThan(20);
  });

  it("moves back to the root", () => {
    const set = [folder("work"), p("a", { parent_id: "work" }), p("root", { sort_order: 4 })];
    expect(moveProjectTarget(set, "a", null)?.parent_id).toBeNull();
  });

  it("rejects a cycle and an unknown project", () => {
    const set = [folder("work"), folder("sub", { parent_id: "work" })];
    expect(moveProjectTarget(set, "work", "sub")).toBeNull();
    expect(moveProjectTarget(set, "nope", "work")).toBeNull();
  });
});

describe("hiddenProjectIds", () => {
  it("hides a project whose folder (or its folder's folder) is archived or trashed", () => {
    const set = [
      folder("work", { archived_at: 1 }),
      folder("clients", { parent_id: "work" }),
      p("acme", { parent_id: "clients" }),
      folder("bin", { deleted_at: 2 }),
      p("old", { parent_id: "bin" }),
      p("inbox"),
    ];
    const hidden = hiddenProjectIds(set);
    expect([...hidden].sort()).toEqual(["acme", "bin", "clients", "old", "work"]);
  });

  it("returns the subtree again once the folder is restored", () => {
    const restored = [folder("work"), p("acme", { parent_id: "work" })];
    expect(hiddenProjectIds(restored).size).toBe(0);
  });

  it("terminates on a pre-existing cycle", () => {
    const bad = [folder("a", { parent_id: "b" }), folder("b", { parent_id: "a", archived_at: 1 })];
    expect(hiddenProjectIds(bad).has("a")).toBe(true);
  });
});

describe("pinnedProjectTree", () => {
  // Pinning is a per-user preference, injected; not a field on the shared project entity.
  const pinnedExcept =
    (...unpinned: string[]) =>
    (id: string) =>
      !unpinned.includes(id);
  const allPinned = () => true;

  it("drops an unpinned project but keeps a pinned one's ancestor folders", () => {
    const set = [
      folder("work", { sort_order: 1 }),
      folder("clients", { parent_id: "work" }),
      p("acme", { parent_id: "clients" }),
      p("hidden", { parent_id: "clients" }),
      p("inbox", { sort_order: 2 }),
    ];
    expect(ids(pinnedProjectTree(set, pinnedExcept("hidden")))).toEqual([
      "work",
      "clients",
      "acme",
      "inbox",
    ]);
  });

  it("drops a folder whose projects are all unpinned", () => {
    const set = [folder("work"), p("acme", { parent_id: "work" }), p("inbox")];
    expect(ids(pinnedProjectTree(set, pinnedExcept("acme")))).toEqual(["inbox"]);
  });

  it("excludes anything hidden behind an archived folder", () => {
    const set = [folder("work", { archived_at: 1 }), p("acme", { parent_id: "work" }), p("inbox")];
    expect(ids(pinnedProjectTree(set, allPinned))).toEqual(["inbox"]);
  });

  it("honours collapsed folders", () => {
    const set = [
      folder("work", { sort_order: 1 }),
      p("acme", { parent_id: "work" }),
      p("inbox", { sort_order: 2 }),
    ];
    expect(ids(pinnedProjectTree(set, allPinned, new Set(["work"])))).toEqual(["work", "inbox"]);
  });
});
