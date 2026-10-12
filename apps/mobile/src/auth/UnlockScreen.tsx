import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import { hasWrappedKeys } from "@atlas/client-core";
import { CircleAlert, KeyRound } from "../ui/icons";
import { useAuth } from "./AuthContext";
import { useSignOut } from "./useSignOut";
import { LoginScreen } from "./LoginScreen";

/**
 * The gate for a locked session: signed in but without the unwrapped keys, so nothing can be
 * decrypted and sync must not run. The password unlocks the key blobs the session already holds,
 * with no server round trip and no new device session.
 *
 * A session without wrapped blobs to unlock falls back to a full sign-in with the email prefilled.
 */
export function UnlockScreen() {
  const { t } = useTranslation();
  const { session, unlock } = useAuth();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { signOut, dialog } = useSignOut();

  if (!session) return null;
  if (!hasWrappedKeys(session)) {
    return <LoginScreen initialEmail={session.user.email} notice={t("unlock.reloginNotice")} />;
  }

  const submit = async () => {
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      const unlocked = await unlock(password);
      if (!unlocked) setError(t("unlock.wrongPassword"));
    } catch {
      setError(t("auth.genericError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-neutral-50 dark:bg-neutral-950"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerClassName="flex-grow justify-center p-4"
        keyboardShouldPersistTaps="handled"
      >
        <View className="w-full self-center rounded-xl border border-neutral-200 bg-white p-6 sm:max-w-sm dark:border-neutral-800 dark:bg-neutral-900">
          <View className="mb-3 flex-row items-center gap-2">
            <KeyRound size={22} className="text-accent-500" />
            <Text className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              {t("unlock.title")}
            </Text>
          </View>
          <Text className="text-sm text-neutral-600 dark:text-neutral-400">{t("unlock.body")}</Text>
          <Text className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {t("unlock.signedInAs", { email: session.user.email })}
          </Text>

          <View className="mt-4 gap-3">
            <View className="gap-1">
              <Text className="text-sm text-neutral-600 dark:text-neutral-400">
                {t("auth.password")}
              </Text>
              <TextInput
                accessibilityLabel={t("auth.password")}
                value={password}
                onChangeText={setPassword}
                onSubmitEditing={submit}
                secureTextEntry
                textContentType="password"
                autoComplete="current-password"
                autoCapitalize="none"
                autoCorrect={false}
                className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
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

            <Pressable
              accessibilityRole="button"
              disabled={busy || !password}
              onPress={submit}
              className={
                "mt-1 flex-row items-center justify-center gap-2 rounded-md bg-accent-600 px-3 py-3 active:bg-accent-500 web:cursor-pointer " +
                (busy || !password ? "opacity-60" : "")
              }
            >
              {busy && <ActivityIndicator color="white" size="small" />}
              <Text className="text-sm font-medium text-white">{t("unlock.submit")}</Text>
            </Pressable>
          </View>

          <Pressable
            accessibilityRole="button"
            onPress={signOut}
            className="mt-4 py-1 web:cursor-pointer"
          >
            <Text className="text-center text-sm text-neutral-500 dark:text-neutral-400">
              {t("common.signOut")}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
      {dialog}
    </KeyboardAvoidingView>
  );
}
