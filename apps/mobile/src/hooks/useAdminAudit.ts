import { useCallback } from "react";
import type { AdminAuditEntry } from "@atlastodo/client-core";
import { useAuth } from "../auth/AuthContext";
import { useAdminResource } from "./useAdminResource";

const PAGE_SIZE = 50;

/**
 * The audit trail of admin actions (admin panel). Read-only; newest first from the server, keyed
 * forward by the identity cursor when "load more" is wired to it.
 */
export function useAdminAudit() {
  const { api } = useAuth();
  const fetchEntries = useCallback(() => api.listAudit({ limit: PAGE_SIZE }), [api]);
  const {
    data: entries,
    loading,
    failed,
    load,
  } = useAdminResource<AdminAuditEntry[]>(fetchEntries, []);

  return { entries, loading, failed, refresh: load };
}
