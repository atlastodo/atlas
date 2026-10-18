import { useMemo } from "react";
import type { Section } from "@atlastodo/client-core";
import { isTrashed, toSection } from "@atlastodo/shared";
import { useStore } from "../data/StoreProvider";

export interface UseAllSections {
  /** Every section across all projects. */
  sections: Section[];
  /** Look up a section by id (cross-project); undefined when unknown. */
  byId: (id: string) => Section | undefined;
}

/**
 * All sections across every project. `useSections` is scoped to one project; this flat lookup lets
 * a smart list show each task's origin (project, section).
 */
export function useAllSections(): UseAllSections {
  const { store, version } = useStore();

  const map = useMemo(() => {
    const m = new Map<string, Section>();
    for (const e of store.list("section")) {
      if (!isTrashed(e.fields)) {
        m.set(e.id, toSection(e.id, e.fields));
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, version]);

  return useMemo(
    () => ({
      sections: [...map.values()],
      byId: (id: string) => map.get(id),
    }),
    [map],
  );
}
