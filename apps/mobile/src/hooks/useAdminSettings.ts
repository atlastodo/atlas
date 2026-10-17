import { useCallback } from "react";
import type { AdminSettingsView } from "@atlastodo/client-core";
import { useAuth } from "../auth/AuthContext";
import { useAdminResource } from "./useAdminResource";

/**
 * The runtime instance settings (admin panel). The server returns **effective** values, so the
 * toggle shows what a signup attempt would see right now even when the env default, not the panel,
 * is in charge. The optimistic flip reconciles against the server's answer either way.
 */
export function useAdminSettings() {
  const { api } = useAuth();
  const fetchSettings = useCallback(() => api.getAdminSettings(), [api]);
  const {
    data: settings,
    setData: setSettings,
    loading,
    failed,
    load,
  } = useAdminResource<AdminSettingsView | null>(fetchSettings, null);

  const setSignupEnabled = useCallback(
    async (signupEnabled: boolean): Promise<boolean> => {
      setSettings((prev) => (prev ? { ...prev, signup_enabled: signupEnabled } : prev));
      try {
        setSettings(await api.updateAdminSettings({ signup_enabled: signupEnabled }));
        return true;
      } catch {
        void load();
        return false;
      }
    },
    [api, load, setSettings],
  );

  return { settings, loading, failed, refresh: load, setSignupEnabled };
}
