import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { apiErrorCode, type PasskeyProof, type PasskeyView } from "@atlastodo/client-core";
import { useAuth } from "../../auth/AuthContext";
import { describePasskeyError } from "../../auth/passkeyErrors";
import { serverOffersPasskeys } from "../../auth/serverCompat";
import { useToast } from "../../data/ToastProvider";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Row, Section } from "../../ui/Section";
import { SkeletonRows } from "../../ui/Skeleton";
import { CircleAlert, KeyRound, Pencil, Plus, RefreshCw, Trash2 } from "../../ui/icons";
import { relativeLabel } from "./relativeLabel";
import { PasswordInput } from "./shared";

const INPUT_CLASS =
  "rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100";
const BUTTON_CLASS =
  "flex-row items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800";

type Dialog =
  | { kind: "add" }
  | { kind: "rename"; passkey: PasskeyView }
  | { kind: "remove"; passkey: PasskeyView }
  | { kind: "removePassword" };

/**
 * Passkeys (`/auth/passkeys`): list, add, rename and remove them, and drop the password once a
 * passkey can stand in for it.
 *
 * Adding, removing and dropping the password are account-critical: an account with a password
 * confirms them with it, a passkey-only one with one of its passkeys (the browser or Credential
 * Manager prompts). A new passkey must support PRF: it wraps the account root key, which the
 * password (or the confirming passkey) opens first. The last way to sign in cannot be removed.
 */
export function PasskeysSection() {
  const { t } = useTranslation();
  const {
    api,
    session,
    keyring,
    passkeyAuthenticator,
    confirmWithPasskey,
    addPasskey,
    removePasskey,
    removePassword,
  } = useAuth();
  const toast = useToast();
  const [offered, setOffered] = useState<boolean | null>(null);
  const [passkeys, setPasskeys] = useState<PasskeyView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hasPassword = session?.user.has_password !== false;
  const unlocked = keyring?.hasKeys() === true;

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setPasskeys(await api.listPasskeys());
    } catch {
      setFailed(true);
    }
  }, [api]);

  useEffect(() => {
    let live = true;
    void serverOffersPasskeys(api).then((on) => {
      if (!live) return;
      setOffered(on);
      if (on) void load();
    });
    return () => {
      live = false;
    };
  }, [api, load]);

  if (offered === false) return null;

  const close = () => {
    setDialog(null);
    setName("");
    setPassword("");
    setError(null);
  };

  /** The confirmation an account-critical action carries: the password, or else a passkey. */
  const proof = async (): Promise<string | PasskeyProof> => {
    if (hasPassword) return password;
    return confirmWithPasskey();
  };

  const run = async (action: () => Promise<void>, failedKey: string) => {
    if (busy) return;
    if (hasPassword && dialog?.kind !== "rename" && password === "") {
      setError(t("settings.deletePasswordHint"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await action();
      close();
      await load();
    } catch (err) {
      setError(
        apiErrorCode(err) === "invalid_credentials"
          ? t("settings.passwordIncorrect")
          : (describePasskeyError(err, t) ?? t(failedKey)),
      );
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => {
    if (!dialog) return;
    switch (dialog.kind) {
      case "add":
        return void run(async () => {
          await addPasskey(name.trim(), await proof());
          toast.show(t("settings.passkeysAdded"));
        }, "settings.passkeysAddFailed");
      case "rename":
        if (name.trim() === "") return;
        return void run(async () => {
          await api.renamePasskey(dialog.passkey.id, name.trim());
        }, "settings.passkeysRenameFailed");
      case "remove":
        return void run(async () => {
          await removePasskey(dialog.passkey.id, await proof());
          toast.show(t("settings.passkeysRemoved"));
        }, "settings.passkeysRemoveFailed");
      case "removePassword":
        return void run(async () => {
          await removePassword(password);
          toast.show(t("settings.passkeysPasswordRemoved"));
        }, "auth.genericError");
    }
  };

  const describe = (p: PasskeyView) => {
    const now = Date.now();
    const parts = [
      t("settings.passkeysAddedOn", { when: relativeLabel(p.created_at, now) }),
      p.last_used_at != null
        ? t("settings.passkeysLastUsed", { when: relativeLabel(p.last_used_at, now) })
        : t("settings.passkeysNeverUsed"),
    ];
    if (p.backed_up) parts.push(t("settings.passkeysSynced"));
    return parts.join(" · ");
  };

  const canAct = passkeyAuthenticator !== null;
  // Proof-needing actions without a password run a passkey ceremony, so need this device's support.
  const canProve = hasPassword || canAct;
  const onlyOne = !hasPassword && passkeys?.length === 1;

  const dialogText = (() => {
    switch (dialog?.kind) {
      case "add":
        return { title: t("settings.passkeysAdd"), message: t("settings.passkeysAddMessage") };
      case "rename":
        return { title: t("settings.passkeysRenameTitle"), message: undefined };
      case "remove":
        return {
          title: t("settings.passkeysRemoveConfirmTitle"),
          message: t("settings.passkeysRemoveConfirmMessage", { name: dialog.passkey.name }),
        };
      case "removePassword":
        return {
          title: t("settings.passkeysRemovePasswordConfirmTitle"),
          message: t("settings.passkeysRemovePasswordConfirmMessage"),
        };
      default:
        return { title: "", message: undefined };
    }
  })();
  const confirmLabel =
    !hasPassword && (dialog?.kind === "add" || dialog?.kind === "remove")
      ? t("settings.confirmWithPasskey")
      : dialog?.kind === "add"
        ? t("settings.passkeysAdd")
        : dialog?.kind === "rename"
          ? t("common.save")
          : dialog?.kind === "removePassword"
            ? t("settings.passkeysRemovePassword")
            : t("settings.passkeysRemove");
  const askName = dialog?.kind === "add" || dialog?.kind === "rename";
  const askPassword = hasPassword && dialog != null && dialog.kind !== "rename";

  return (
    <>
      <Section icon={KeyRound} title={t("settings.passkeys")}>
        <Text className="py-2 text-sm text-neutral-600 dark:text-neutral-400">
          {t("settings.passkeysIntro")}
        </Text>
        {!canAct && (
          <Text className="pb-2 text-sm text-neutral-500 dark:text-neutral-400">
            {t("settings.passkeysDeviceUnavailable")}
          </Text>
        )}
        {onlyOne && (
          <View className="mb-2 flex-row items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-950/30">
            <CircleAlert size={18} className="shrink-0 text-amber-700 dark:text-amber-400" />
            <Text className="flex-1 text-sm text-amber-800 dark:text-amber-300">
              {t("settings.passkeysOnlyOne")}
            </Text>
          </View>
        )}
        {passkeys === null ? (
          failed ? (
            <Row label={t("settings.passkeysLoadFailed")}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("common.retry")}
                onPress={() => void load()}
                className={BUTTON_CLASS}
              >
                <RefreshCw size={18} className="text-neutral-600 dark:text-neutral-300" />
                <Text className="text-sm text-neutral-600 dark:text-neutral-300">
                  {t("common.retry")}
                </Text>
              </Pressable>
            </Row>
          ) : (
            <View className="py-3">
              <SkeletonRows count={1} />
            </View>
          )
        ) : (
          passkeys.map((p) => (
            <Row key={p.id} label={p.name} description={describe(p)}>
              <View className="flex-row gap-2">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${t("settings.passkeysRename")} ${p.name}`}
                  onPress={() => {
                    setName(p.name);
                    setDialog({ kind: "rename", passkey: p });
                  }}
                  className={BUTTON_CLASS}
                >
                  <Pencil size={18} className="text-neutral-600 dark:text-neutral-300" />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${t("settings.passkeysRemove")} ${p.name}`}
                  disabled={!canProve}
                  onPress={() => setDialog({ kind: "remove", passkey: p })}
                  className={`${BUTTON_CLASS} ${canProve ? "" : "opacity-50"}`}
                >
                  <Trash2 size={18} className="text-neutral-600 dark:text-neutral-300" />
                </Pressable>
              </View>
            </Row>
          ))
        )}
        <Row
          label={t("settings.passkeysAdd")}
          description={unlocked ? undefined : t("settings.apiTokensLocked")}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("settings.passkeysAdd")}
            disabled={!canAct || !unlocked}
            onPress={() => setDialog({ kind: "add" })}
            className={`${BUTTON_CLASS} ${canAct && unlocked ? "" : "opacity-50"}`}
          >
            <Plus size={18} className="text-neutral-600 dark:text-neutral-300" />
            <Text className="text-sm text-neutral-600 dark:text-neutral-300">
              {t("settings.passkeysAdd")}
            </Text>
          </Pressable>
        </Row>
        {hasPassword && (passkeys?.length ?? 0) > 0 && (
          <Row
            label={t("settings.passkeysRemovePassword")}
            description={t("settings.passkeysRemovePasswordDesc")}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("settings.passkeysRemovePassword")}
              onPress={() => setDialog({ kind: "removePassword" })}
              className={BUTTON_CLASS}
            >
              <Text className="text-sm text-neutral-600 dark:text-neutral-300">
                {t("settings.passkeysRemovePassword")}
              </Text>
            </Pressable>
          </Row>
        )}
      </Section>

      <ConfirmDialog
        visible={dialog != null}
        title={dialogText.title}
        message={dialogText.message}
        confirmLabel={confirmLabel}
        danger={dialog?.kind === "remove" || dialog?.kind === "removePassword"}
        confirmDisabled={busy || (askName && name.trim() === "")}
        onConfirm={confirm}
        onCancel={close}
      >
        <View className="gap-2 py-1">
          {askName && (
            <TextInput
              accessibilityLabel={t("settings.passkeysNamePlaceholder")}
              placeholder={t("settings.passkeysNamePlaceholder")}
              value={name}
              onChangeText={setName}
              maxLength={100}
              autoFocus
              className={INPUT_CLASS}
            />
          )}
          {askPassword && (
            <PasswordInput
              accessibilityLabel={t("settings.passkeysPasswordLabel")}
              placeholder={t("settings.passkeysPasswordLabel")}
              value={password}
              onChangeText={(v) => {
                setPassword(v);
                setError(null);
              }}
              textContentType="password"
              onSubmitEditing={confirm}
            />
          )}
          {error !== null && (
            <Text accessibilityRole="alert" className="text-xs text-red-600 dark:text-red-400">
              {error}
            </Text>
          )}
        </View>
      </ConfirmDialog>
    </>
  );
}
