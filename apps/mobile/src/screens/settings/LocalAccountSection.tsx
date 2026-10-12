import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useLocalMode } from "../../auth/localMode";
import { Section } from "../../ui/Section";
import { UserPlus, UserRound } from "../../ui/icons";

/**
 * The Account pane in local-only mode: the data is on this device only, and an account (to sync
 * between devices and share projects) is one tap away. Either way the local data moves into the
 * account (`LocalUpgradeGate`).
 */
export function LocalAccountSection() {
  const { t } = useTranslation();
  const local = useLocalMode();
  return (
    <Section icon={UserRound} title={t("settings.account")}>
      <View className="gap-1 py-3">
        <Text className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
          {t("localMode.settingsTitle")}
        </Text>
        <Text className="text-sm text-neutral-600 dark:text-neutral-300">
          {t("localMode.settingsDesc")}
        </Text>
      </View>
      <View className="flex-row flex-wrap items-center gap-2 pb-3">
        <Pressable
          accessibilityRole="button"
          onPress={() => local?.openAuth("signup")}
          className="flex-row items-center gap-1.5 rounded-md bg-accent-600 px-3 py-2"
        >
          <UserPlus size={18} className="text-white" />
          <Text className="text-sm font-medium text-white">{t("localMode.createAccount")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => local?.openAuth("login")}
          className="flex-row items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
        >
          <UserRound size={18} className="text-neutral-600 dark:text-neutral-300" />
          <Text className="text-sm text-neutral-600 dark:text-neutral-300">
            {t("localMode.signIn")}
          </Text>
        </Pressable>
      </View>
    </Section>
  );
}
