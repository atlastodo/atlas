import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  defaultServerUrl,
  getServerUrlOverride,
  isOnlineWeb,
  setServerUrlOverride,
} from "../../auth/serverUrl";
import { Row, Section } from "../../ui/Section";
import { Server } from "../../ui/icons";

/**
 * The self-hosted API server URL; storage lives in `auth/serverUrl.ts`. The stored value is read
 * asynchronously, so the field starts empty and fills in. Production builds ship no default, so the
 * placeholder is only a hint.
 */
export function ServerSection() {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (isOnlineWeb()) return;
    let live = true;
    void getServerUrlOverride().then((stored) => {
      if (live) setUrl(stored);
    });
    return () => {
      live = false;
    };
  }, []);

  if (isOnlineWeb()) return null;

  const save = () => {
    setServerUrlOverride(url).then(
      () => setSaved(true),
      (err) => console.warn("[atlas] could not save the server address:", err),
    );
  };

  return (
    <Section icon={Server} title={t("settings.server")}>
      <Row label={t("settings.serverUrl")} description={t("settings.serverUrlHint")}>
        <TextInput
          accessibilityLabel={t("settings.serverUrl")}
          value={url}
          onChangeText={(v) => {
            setUrl(v);
            setSaved(false);
          }}
          placeholder={defaultServerUrl || "http://localhost:8080"}
          placeholderTextColor="#737373"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          className="w-44 rounded border border-neutral-200 px-2 py-1 text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100"
        />
      </Row>
      <View className="flex-row items-center gap-3 py-2">
        <Pressable
          accessibilityRole="button"
          onPress={save}
          className="rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
        >
          <Text className="text-sm text-neutral-600 dark:text-neutral-300">{t("common.save")}</Text>
        </Pressable>
        {saved && (
          <Text className="flex-1 text-xs text-neutral-500">{t("settings.serverUrlSaved")}</Text>
        )}
      </View>
    </Section>
  );
}
