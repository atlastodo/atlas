import "../lib/polyfillCrypto";
import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { copySecret } from "../lib/clipboard";
import { ThemeScope } from "../theme/ThemeProvider";
import { Check, Copy } from "../ui/icons";

/**
 * Shows a new recovery phrase once: a new account's, right after sign-up, or the one that replaced
 * the old phrase from Settings (`replaced`). It is the only way back into the account's data after
 * a forgotten password, so the copy says so plainly.
 */
export function RecoveryPhraseModal({
  phrase,
  onClose,
  replaced = false,
}: {
  phrase: string | null;
  onClose: () => void;
  /** The phrase replaced an earlier one, which no longer works: the copy says so. */
  replaced?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  if (!phrase) return null;

  const words = phrase.split(" ");

  const handleCopy = async () => {
    const ok = await copySecret(phrase);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <Modal visible transparent animationType="fade">
      <ThemeScope className="flex-1 items-center justify-center bg-black/60 p-4">
        <View className="w-full max-w-lg rounded-2xl border border-neutral-200 bg-white p-6 shadow-2xl dark:border-neutral-800 dark:bg-neutral-900">
          <Text
            accessibilityRole="header"
            className="text-xl font-bold text-neutral-900 dark:text-neutral-100"
          >
            {t("recovery.phraseTitle")}
          </Text>
          <Text className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            {t("recovery.phraseBody")}
          </Text>
          <Text className="mt-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {t("recovery.phraseWarning")}
          </Text>
          {replaced && (
            <Text className="mt-2 text-sm font-semibold text-red-600 dark:text-red-400">
              {t("recovery.replacedNotice")}
            </Text>
          )}

          <View
            accessible
            accessibilityLabel={`${t("recovery.phraseWords")}: ${phrase}`}
            className="mt-4 flex-row flex-wrap gap-2 rounded-xl bg-neutral-100 p-3.5 dark:bg-neutral-800"
          >
            {words.map((w, idx) => (
              <View
                key={idx}
                className="flex-row items-center gap-1.5 rounded-md bg-white px-2.5 py-1.5 shadow-sm dark:bg-neutral-700"
              >
                <Text className="text-xs text-neutral-500 dark:text-neutral-400">{idx + 1}.</Text>
                <Text className="font-mono text-xs font-bold text-neutral-900 dark:text-neutral-100">
                  {w}
                </Text>
              </View>
            ))}
          </View>

          <View className="mt-4 flex-row gap-3">
            <Pressable
              accessibilityRole="button"
              onPress={handleCopy}
              className="flex-1 flex-row items-center justify-center gap-2 rounded-lg border border-neutral-300 py-3 active:bg-neutral-100 dark:border-neutral-700 dark:active:bg-neutral-800 web:cursor-pointer"
            >
              {copied ? (
                <Check size={16} className="text-green-600 dark:text-green-400" />
              ) : (
                <Copy size={16} className="text-neutral-600 dark:text-neutral-300" />
              )}
              <Text className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                {copied ? t("recovery.copied") : t("recovery.copy")}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={onClose}
              className="flex-1 items-center justify-center rounded-lg bg-accent-600 py-3 active:bg-accent-500 web:cursor-pointer"
            >
              <Text className="text-sm font-semibold text-white">{t("recovery.saved")}</Text>
            </Pressable>
          </View>
        </View>
      </ThemeScope>
    </Modal>
  );
}
