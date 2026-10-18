import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { apiErrorCode } from "@atlastodo/client-core";
import { useAuth } from "../../auth/AuthContext";
import { useSignOut } from "../../auth/useSignOut";
import { useStore } from "../../data/StoreProvider";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Row, Section } from "../../ui/Section";
import { LogOut, Trash2, UserRound } from "../../ui/icons";
import { LocalAccountSection } from "./LocalAccountSection";
import { PasskeysSection } from "./PasskeysSection";
import { RecoveryPhraseSection } from "./RecoveryPhraseSection";
import { describePasskeyError } from "../../auth/passkeyErrors";
import { SecuritySection } from "./SecuritySection";
import { DangerButton, DangerZone } from "./shared";

/** The Account pane: who is signed in, sign-out, password, recovery phrase and account deletion. */
export function AccountSection() {
  const { localOnly } = useStore();
  return localOnly ? <LocalAccountSection /> : <SignedInAccountSection />;
}

function SignedInAccountSection() {
  const { t } = useTranslation();
  const { session, deleteAccount, confirmWithPasskey } = useAuth();
  // A passkey-only account confirms the deletion with a passkey.
  const hasPassword = session?.user.has_password !== false;
  const { signOut, dialog: signOutDialog } = useSignOut();
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  return (
    <>
      <Section icon={UserRound} title={t("settings.account")}>
        <Row label={t("settings.signedInAs")}>
          <Text className="text-sm text-neutral-600 dark:text-neutral-300">
            {session?.user.display_name || session?.user.email || "-"}
          </Text>
        </Row>
        {session?.user.display_name != null && session.user.display_name !== "" && (
          <Row label={t("settings.email")}>
            <Text className="text-sm text-neutral-600 dark:text-neutral-300">
              {session.user.email}
            </Text>
          </Row>
        )}
        <View className="flex-row items-center gap-2 py-3">
          <Pressable
            accessibilityRole="button"
            onPress={signOut}
            className="flex-row items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
          >
            <LogOut size={18} className="text-neutral-600 dark:text-neutral-300" />
            <Text className="text-sm text-neutral-600 dark:text-neutral-300">
              {t("common.signOut")}
            </Text>
          </Pressable>
        </View>
      </Section>

      <SecuritySection />
      <PasskeysSection />
      <RecoveryPhraseSection />

      <DangerZone>
        <Row label={t("auth.deleteAccount")} description={t("settings.deleteAccountDesc")}>
          <DangerButton
            icon={Trash2}
            label={t("auth.deleteAccount")}
            onPress={() => setConfirmDeleteAccount(true)}
          />
        </Row>
      </DangerZone>

      <ConfirmDialog
        visible={confirmDeleteAccount}
        title={t("auth.deleteAccountConfirmTitle")}
        message={t("auth.deleteAccountConfirmMessage")}
        confirmLabel={t("auth.deleteAccount")}
        danger
        onConfirm={async () => {
          if (hasPassword && deletePassword === "") {
            setDeleteError(t("settings.deletePasswordHint"));
            return;
          }
          setDeleteError(null);
          try {
            await deleteAccount(hasPassword ? deletePassword : await confirmWithPasskey());
            setConfirmDeleteAccount(false);
          } catch (e) {
            if (apiErrorCode(e) === "invalid_credentials") {
              setDeleteError(t("settings.passwordIncorrect"));
            } else {
              setDeleteError(describePasskeyError(e, t) ?? t("auth.genericError"));
            }
          }
        }}
        onCancel={() => {
          setConfirmDeleteAccount(false);
          setDeletePassword("");
          setDeleteError(null);
        }}
      >
        <View className="gap-1">
          {hasPassword ? (
            <>
              <Text className="text-sm text-neutral-600 dark:text-neutral-400">
                {t("auth.password")}
              </Text>
              <TextInput
                accessibilityLabel={t("auth.password")}
                value={deletePassword}
                onChangeText={(v) => {
                  setDeletePassword(v);
                  setDeleteError(null);
                }}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="password"
                className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
              />
            </>
          ) : (
            <Text className="text-sm text-neutral-600 dark:text-neutral-400">
              {t("settings.deleteAccountPasskeyHint")}
            </Text>
          )}
          {deleteError !== null && (
            <Text accessibilityRole="alert" className="text-xs text-red-600 dark:text-red-400">
              {deleteError}
            </Text>
          )}
        </View>
      </ConfirmDialog>
      {signOutDialog}
    </>
  );
}
