import { useCallback, useEffect, useState } from "react";
import type { BugReportSummary } from "@atlastodo/client-core";
import { useAuth } from "../auth/AuthContext";
import { useLatestRequest } from "./useLatestRequest";

/** Which reports the list is showing. */
export type ReportFilter = "open" | "all";

const PAGE_SIZE = 50;

/**
 * The admin error-report list. REST-driven off the `ApiClient`, not the sync store: reports belong
 * to the deployment, not a user's replica, and this keeps an admin-only concern out of every
 * device's op log.
 */
export function useAdminReports() {
  const { api } = useAuth();
  const beginRequest = useLatestRequest();
  const [reports, setReports] = useState<BugReportSummary[]>([]);
  const [filter, setFilter] = useState<ReportFilter>("open");
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const isLatest = beginRequest();
    setLoading(true);
    setFailed(false);
    try {
      const next = await api.listReports({
        resolved: filter === "open" ? false : undefined,
        limit: PAGE_SIZE,
      });
      if (isLatest()) setReports(next);
    } catch {
      if (isLatest()) {
        setFailed(true);
        setReports([]);
      }
    } finally {
      if (isLatest()) setLoading(false);
    }
  }, [api, filter, beginRequest]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Toggle a report's resolved state. Applied optimistically, then reconciled: under the "open"
   * filter a resolved report leaves the list, so waiting for the round trip would look unchanged.
   */
  const setResolved = useCallback(
    async (id: string, resolved: boolean) => {
      setReports((prev) =>
        filter === "open" && resolved
          ? prev.filter((r) => r.id !== id)
          : prev.map((r) =>
              r.id === id ? { ...r, resolved_at_ms: resolved ? Date.now() : null } : r,
            ),
      );
      try {
        await api.setReportResolved(id, resolved);
      } catch {
        // Roll back the optimistic change.
        void load();
      }
    },
    [api, filter, load],
  );

  const deleteReport = useCallback(
    async (id: string) => {
      setReports((prev) => prev.filter((r) => r.id !== id));
      try {
        await api.deleteReport(id);
      } catch {
        void load();
      }
    },
    [api, load],
  );

  /**
   * Delete what the current filter shows -- under "open" only the unresolved reports, including
   * any beyond the loaded page -- and resolve to how many went, or null when refused.
   */
  const deleteAllReports = useCallback(async (): Promise<number | null> => {
    setReports([]);
    try {
      const { deleted } = await api.deleteAllReports(filter === "open" ? false : undefined);
      return deleted;
    } catch {
      void load();
      return null;
    }
  }, [api, filter, load]);

  return {
    reports,
    // A full page means there may be more on the server than the list shows.
    hasMore: reports.length >= PAGE_SIZE,
    filter,
    setFilter,
    loading,
    failed,
    refresh: load,
    setResolved,
    deleteReport,
    deleteAllReports,
  };
}
