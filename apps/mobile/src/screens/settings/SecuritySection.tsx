import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { apiErrorCode } from "@atlas/client-core";
import { useAuth } from "../../auth/AuthContext";
import { useToast } from "../../data/ToastProvider";
import { useIsWide } from "../../hooks/useIsWide";
import { Row, Section } from "../../ui/Section";
import { KeyRound } from "../../ui/icons";
import { PasswordInput } from "./shared";
import { describePasskeyError } from "../../auth/passkeyErrors";

/** The new password's length floor; the server only sees the derived auth hash, so this rule is the client's. */
const MIN_PASSWORD_LEN = 8;

/**
 * Change password. For an E2EE account the key material is re-wrapped under the new password in
 * `@atlas/client-core` (`buildE2eePasswordChange`); the server verifies the current credential and
 * swaps hash and wrapped keys atomically. Inline validation covers the length floor and confirm match.
 */
export function SecuritySection() {
  const { t } = useTranslation();
  const { changePassword, confirmWithPasskey, session } = useAuth();
  // A passkey-only account sets its first password, confirmed with a passkey.
  const hasPassword = session?.user.has_password !== false;
  const toast = useToast();
  const isWide = useIsWide();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setError(null);
    if (next.length < MIN_PASSWORD_LEN) {
      setError(t("settings.passwordTooShort"));
      return;
    }
    if (next !== confirm) {
      setError(t("settings.passwordMismatch"));
      return;
    }
    setBusy(true);
    try {
      await changePassword(hasPassword ? current : await confirmWithPasskey(), next);
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.show(t(hasPassword ? "settings.changePasswordDone" : "settings.setPasswordDone"));
    } catch (err) {
      // A wrong current password is a 403 with its own code; a 401 is the session, not the password.
      if (apiErrorCode(err) === "invalid_credentials") {
        setError(t("settings.passwordIncorrect"));
      } else if (describePasskeyError(err, t) !== null) {
        setError(describePasskeyError(err, t));
      } else {
        setError(t("settings.changePasswordFailed"));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      icon={KeyRound}
      title={hasPassword ? t("settings.changePassword") : t("settings.setPassword")}
    >
      {hasPassword ? (
        <Row label={t("settings.currentPassword")}>
          <PasswordInput
            accessibilityLabel={t("settings.currentPassword")}
            value={current}
            onChangeText={setCurrent}
            placeholder={t("settings.currentPasswordPlaceholder")}
          />
        </Row>
      ) : (
        <Text className="py-3 text-sm text-neutral-600 dark:text-neutral-400">
          {t("settings.setPasswordDesc")}
        </Text>
      )}
      <Row label={t("settings.newPassword")}>
        <PasswordInput
          accessibilityLabel={t("settings.newPassword")}
          value={next}
          onChangeText={setNext}
          textContentType="newPassword"
          placeholder={t("settings.newPasswordPlaceholder")}
        />
      </Row>
      <Row label={t("settings.confirmNewPassword")}>
        <PasswordInput
          accessibilityLabel={t("settings.confirmNewPassword")}
          value={confirm}
          onChangeText={setConfirm}
          textContentType="newPassword"
          onSubmitEditing={() => void submit()}
          placeholder={t("settings.confirmNewPasswordPlaceholder")}
        />
      </Row>
      <View className={isWide ? "flex-row items-center gap-3 py-3" : "gap-2 py-3"}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            hasPassword ? t("settings.updatePassword") : t("settings.setPassword")
          }
          disabled={busy}
          onPress={() => void submit()}
          className={
            "items-center rounded-md bg-accent-600 px-4 py-2.5 active:bg-accent-500 " +
            (busy ? "opacity-60" : "")
          }
        >
          <Text className="text-sm font-medium text-white">
            {hasPassword ? t("settings.updatePassword") : t("settings.setPassword")}
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
    </Section>
  );
}
