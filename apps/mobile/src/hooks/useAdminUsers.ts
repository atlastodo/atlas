import { useCallback, useState } from "react";
import type { AdminUserView } from "@atlastodo/client-core";
import { useAuth } from "../auth/AuthContext";
import { useAdminResource } from "./useAdminResource";

const PAGE_SIZE = 50;

/**
 * The admin panel's account list. REST-driven off the `ApiClient`, not the sync store, like
 * `useAdminReports`: accounts belong to the deployment, not a user's replica. Mutations are
 * optimistic with reload-on-failure, since the server's guardrails (self-actions, last-admin
 * lockout) are the real ones.
 */
export function useAdminUsers() {
  const { api } = useAuth();
  const [search, setSearch] = useState("");
  const fetchUsers = useCallback(
    () => api.listUsers({ search: search || undefined, limit: PAGE_SIZE }),
    [api, search],
  );
  const {
    data: users,
    setData: setUsers,
    loading,
    failed,
    load,
  } = useAdminResource<AdminUserView[]>(fetchUsers, []);

  /** Splice the server's authoritative view back into the list. */
  const reconcile = useCallback(
    (view: AdminUserView) => {
      setUsers((prev) => prev.map((u) => (u.id === view.id ? view : u)));
    },
    [setUsers],
  );

  const setUserAdmin = useCallback(
    async (id: string, isAdmin: boolean): Promise<boolean> => {
      setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, is_admin: isAdmin } : u)));
      try {
        reconcile(await api.setUserAdmin(id, isAdmin));
        return true;
      } catch {
        void load();
        return false;
      }
    },
    [api, load, reconcile, setUsers],
  );

  const setUserDisabled = useCallback(
    async (id: string, disabled: boolean): Promise<boolean> => {
      setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, disabled } : u)));
      try {
        reconcile(await api.setUserDisabled(id, disabled));
        return true;
      } catch {
        void load();
        return false;
      }
    },
    [api, load, reconcile, setUsers],
  );

  /** Sign out every device. Nothing to preview locally; a failure surfaces as a `false`. */
  const logoutDevices = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        await api.logoutUserDevices(id);
        return true;
      } catch {
        return false;
      }
    },
    [api],
  );

  const deleteUser = useCallback(
    async (id: string): Promise<boolean> => {
      setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, deletion_scheduled: true } : u)));
      try {
        reconcile(await api.deleteUser(id));
        return true;
      } catch {
        void load();
        return false;
      }
    },
    [api, load, reconcile, setUsers],
  );

  return {
    users,
    search,
    setSearch,
    loading,
    failed,
    refresh: load,
    setUserAdmin,
    setUserDisabled,
    logoutDevices,
    deleteUser,
  };
}
