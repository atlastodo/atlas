import { useCallback } from "react";
import type { AdminInviteView } from "@atlastodo/client-core";
import { useAuth } from "../auth/AuthContext";
import { useAdminResource } from "./useAdminResource";

/**
 * The signup-invite list (admin panel). REST-driven like the other admin hooks; creation is not
 * optimistic because the server mints the code -- the UI cannot guess it.
 */
export function useAdminInvites() {
  const { api } = useAuth();
  const fetchInvites = useCallback(() => api.listSignupInvites({ limit: 50 }), [api]);
  const {
    data: invites,
    setData: setInvites,
    loading,
    failed,
    load,
  } = useAdminResource<AdminInviteView[]>(fetchInvites, []);

  const create = useCallback(async (): Promise<AdminInviteView | null> => {
    try {
      const invite = await api.createSignupInvite();
      setInvites((prev) => [invite, ...prev]);
      return invite;
    } catch {
      void load();
      return null;
    }
  }, [api, load, setInvites]);

  const revoke = useCallback(
    async (id: string): Promise<boolean> => {
      setInvites((prev) =>
        prev.map((i) => (i.id === id ? { ...i, revoked_at_ms: i.revoked_at_ms ?? Date.now() } : i)),
      );
      try {
        await api.revokeSignupInvite(id);
        return true;
      } catch {
        void load();
        return false;
      }
    },
    [api, load, setInvites],
  );

  return { invites, loading, failed, refresh: load, create, revoke };
}
