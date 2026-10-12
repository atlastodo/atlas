import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { apiErrorCode } from "@atlas/client-core";
import { useAuth } from "../../auth/AuthContext";
import { RecoveryPhraseModal } from "../../auth/RecoveryPhraseModal";
import { useIsWide } from "../../hooks/useIsWide";
import { Row, Section } from "../../ui/Section";
import { Lock } from "../../ui/icons";
import { PasswordInput } from "./shared";

/**
 * Create a new recovery phrase. The server verifies the password and replaces the phrase's key and
 * wrapped keys in one step; the new phrase is shown once, in the modal sign-up uses. The old phrase
 * stops recovering the account.
 */
export function RecoveryPhraseSection() {
  const { t } = useTranslation();
  const { replaceRecoveryPhrase } = useAuth();
  const isWide = useIsWide();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phrase, setPhrase] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    if (password === "") {
      setError(t("settings.deletePasswordHint"));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const next = await replaceRecoveryPhrase(password);
      setPassword("");
      setPhrase(next);
    } catch (err) {
      setError(
        apiErrorCode(err) === "invalid_credentials"
          ? t("settings.passwordIncorrect")
          : t("settings.newRecoveryPhraseFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section icon={Lock} title={t("settings.recoveryPhrase")}>
      <Text className="py-3 text-sm text-neutral-600 dark:text-neutral-400">
        {t("settings.newRecoveryPhraseDesc")}
      </Text>
      <Row label={t("settings.newRecoveryPhrasePassword")}>
        <PasswordInput
          accessibilityLabel={t("settings.newRecoveryPhrasePassword")}
          value={password}
          onChangeText={(v) => {
            setPassword(v);
            setError(null);
          }}
          textContentType="password"
          onSubmitEditing={() => void submit()}
          placeholder={t("settings.recoveryPasswordPlaceholder")}
        />
      </Row>
      <View className={isWide ? "flex-row items-center gap-3 py-3" : "gap-2 py-3"}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("settings.newRecoveryPhrase")}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => void submit()}
          className={
            "items-center rounded-md border border-neutral-300 px-4 py-2.5 dark:border-neutral-600 " +
            (busy ? "opacity-60" : "")
          }
        >
          <Text className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
            {t("settings.newRecoveryPhrase")}
          </Text>
        </Pressable>
        {error !== null && (
          <Text
            accessibilityRole="alert"
            className={"text-xs text-red-600 dark:text-red-400 " + (isWide ? "flex-1" : "")}
          >
            {error}
          </Text>
        )}
      </View>
      <RecoveryPhraseModal phrase={phrase} replaced onClose={() => setPhrase(null)} />
    </Section>
  );
}
