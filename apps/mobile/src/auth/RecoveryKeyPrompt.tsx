import { useState } from "react";
import { ActivityIndicator, Modal, Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { RecoveryPhraseError, apiErrorCode } from "@atlastodo/client-core";
import { ThemeScope } from "../theme/ThemeProvider";
import { CircleAlert, KeyRound } from "../ui/icons";
import { useAuth } from "./AuthContext";

/**
 * Asks an account without a registered recovery key (`has_recovery_key === false`, one created
 * before recovery keys existed) to confirm its phrase, so account recovery answers to the phrase
 * alone rather than to the device key every signed-in device holds.
 *
 * Non-blocking: "Not now" puts it off until the next launch. The password is asked for here
 * rather than kept from sign-in, because a restored session has none in memory.
 */
export function RecoveryKeyPrompt() {
  const { t } = useTranslation();
  const { session, registerRecoveryKey } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A refusal that ends the prompt (a key is registered already): shown until closed.
  const [final, setFinal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const needed = session?.user.has_recovery_key === false && !dismissed;
  if (!needed && final === null) return null;

  const close = () => {
    setDismissed(true);
    setFinal(null);
    setPhrase("");
    setPassword("");
  };

  const submit = async () => {
    if (busy || !phrase.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      await registerRecoveryKey(phrase.trim(), password);
      close();
    } catch (err) {
      if (err instanceof RecoveryPhraseError) setError(t("unlock.recoveryPhraseInvalid"));
      else if (apiErrorCode(err) === "invalid_credentials") setError(t("unlock.wrongPassword"));
      else if (apiErrorCode(err) === "recovery_key_already_set") setFinal(t("recovery.alreadySet"));
      else setError(t("auth.genericError"));
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || !phrase.trim() || !password;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <ThemeScope className="flex-1 items-center justify-center bg-black/40 p-4">
        <View className="w-full max-w-md gap-3 rounded-2xl bg-white p-5 dark:bg-neutral-900">
          <View className="flex-row items-center gap-2">
            <KeyRound size={20} className="text-accent-500" />
            <Text
              accessibilityRole="header"
              className="flex-1 text-base font-semibold text-neutral-900 dark:text-neutral-100"
            >
              {t("recovery.confirmTitle")}
            </Text>
          </View>

          {final !== null ? (
            <>
              <Text
                accessibilityRole="alert"
                className="text-sm text-neutral-700 dark:text-neutral-300"
              >
                {final}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={close}
                className="items-center rounded-md bg-accent-600 px-3 py-2.5 active:bg-accent-500 web:cursor-pointer"
              >
                <Text className="text-sm font-medium text-white">{t("common.close")}</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text className="text-sm text-neutral-600 dark:text-neutral-400">
                {t("recovery.confirmBody")}
              </Text>
              <View className="gap-1">
                <Text className="text-sm text-neutral-600 dark:text-neutral-400">
                  {t("recovery.phraseLabel")}
                </Text>
                <TextInput
                  accessibilityLabel={t("recovery.phraseLabel")}
                  value={phrase}
                  onChangeText={setPhrase}
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  className="min-h-20 rounded-md border border-neutral-300 bg-white px-3 py-2 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
                />
              </View>
              <View className="gap-1">
                <Text className="text-sm text-neutral-600 dark:text-neutral-400">
                  {t("recovery.currentPassword")}
                </Text>
                <TextInput
                  accessibilityLabel={t("recovery.currentPassword")}
                  value={password}
                  onChangeText={setPassword}
                  onSubmitEditing={submit}
                  secureTextEntry
                  textContentType="password"
                  autoComplete="current-password"
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
                />
              </View>

              {error !== null && (
                <View
                  accessibilityRole="alert"
                  accessibilityLiveRegion="polite"
                  className="flex-row items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900/50 dark:bg-red-950/30"
                >
                  <CircleAlert size={18} className="shrink-0 text-red-600 dark:text-red-400" />
                  <Text className="flex-1 text-sm font-medium text-red-600 dark:text-red-400">
                    {error}
                  </Text>
                </View>
              )}

              <View className="mt-1 flex-row justify-end gap-2">
                <Pressable
                  accessibilityRole="button"
                  onPress={close}
                  className="rounded-md border border-neutral-200 px-3 py-2.5 dark:border-neutral-700 web:cursor-pointer"
                >
                  <Text className="text-sm text-neutral-700 dark:text-neutral-200">
                    {t("recovery.later")}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled }}
                  disabled={disabled}
                  onPress={submit}
                  className={
                    "flex-row items-center gap-2 rounded-md bg-accent-600 px-3 py-2.5 active:bg-accent-500 web:cursor-pointer " +
                    (disabled ? "opacity-60" : "")
                  }
                >
                  {busy && <ActivityIndicator color="white" size="small" />}
                  <Text className="text-sm font-medium text-white">{t("recovery.confirm")}</Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      </ThemeScope>
    </Modal>
  );
}
