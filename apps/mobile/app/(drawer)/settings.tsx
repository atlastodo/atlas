import { router, useLocalSearchParams } from "expo-router";
import { SettingsScreen } from "../../src/screens/SettingsScreen";

/**
 * Settings. The screen reads its own preferences; this route mounts it and supplies the navigation
 * it needs (only route files may import expo-router's `router`).
 *
 * The open section lives in the URL (`?section=labels`, and for Admin its tab: `&tab=reports`), so
 * it deep-links and survives a refresh. setParams rewrites the current entry rather than pushing
 * one per section, so Back (the sidebar's and the browser's) leaves Settings.
 */
export default function Settings() {
  const { section, tab } = useLocalSearchParams<{ section?: string; tab?: string }>();
  return (
    <SettingsScreen
      section={section}
      onSelectSection={(id) => router.setParams({ section: id, tab: undefined })}
      adminTab={tab}
      onSelectAdminTab={(next) => router.setParams({ tab: next })}
      onOpenAbout={() => router.push("/about")}
    />
  );
}
