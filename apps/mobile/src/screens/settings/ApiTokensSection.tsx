import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  deriveApiTokenKeys,
  formatApiToken,
  generateApiToken,
  wrapKeysForApiToken,
  type ApiTokenView,
} from "@atlas/client-core";
import { useAuth } from "../../auth/AuthContext";
import { useToast } from "../../data/ToastProvider";
import { copySecret } from "../../lib/clipboard";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Row, Section } from "../../ui/Section";
import { SkeletonRows } from "../../ui/Skeleton";
import { Copy, KeyRound, Plus, RefreshCw, Trash2 } from "../../ui/icons";
import { relativeLabel } from "./relativeLabel";

const INPUT_CLASS =
  "rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100";
const BUTTON_CLASS =
  "flex-row items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800";

/**
 * API tokens (`/auth/api-tokens`) for integrations such as n8n and the `atlas` CLI.
 *
 * A token is made here, on a device holding the unlocked keys: it carries a secret the server
 * never sees, under which this device wraps a copy of the account's keys, so whoever holds the
 * token can decrypt the account and the server still cannot. It is shown once. Revoking it ends
 * its sessions and drops the wrapped keys.
 */
export function ApiTokensSection() {
  const { t } = useTranslation();
  const { api, keyring, session } = useAuth();
  const toast = useToast();
  const [tokens, setTokens] = useState<ApiTokenView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiTokenView | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setTokens(await api.listApiTokens());
    } catch {
      setFailed(true);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const unlocked = keyring?.hasKeys() === true && session != null;

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy || !keyring || !session) return;
    setBusy(true);
    try {
      const parts = generateApiToken();
      await api.createApiToken({
        id: parts.id,
        name: trimmed,
        auth: deriveApiTokenKeys(parts).auth,
        ...wrapKeysForApiToken(parts, session.user.id, {
          dek: keyring.getDek(),
          privateKey: keyring.getUserPrivateKey(),
        }),
      });
      setCreating(false);
      setName("");
      setCreated(formatApiToken(parts));
      await load();
    } catch {
      toast.show(t("settings.apiTokensCreateFailed"));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    const target = revokeTarget;
    setRevokeTarget(null);
    if (!target) return;
    try {
      await api.revokeApiToken(target.id);
      toast.show(t("settings.apiTokensRevoked"));
      await load();
    } catch {
      toast.show(t("settings.apiTokensRevokeFailed"));
    }
  };

  const copy = async () => {
    if (created && (await copySecret(created))) toast.show(t("settings.apiTokensCopied"));
  };

  const describe = (token: ApiTokenView) => {
    const now = Date.now();
    const made = t("settings.apiTokensCreated", { when: relativeLabel(token.created_at, now) });
    const used =
      token.last_used_at != null
        ? t("settings.apiTokensLastUsed", { when: relativeLabel(token.last_used_at, now) })
        : t("settings.apiTokensNeverUsed");
    return `${made} · ${used}`;
  };

  return (
    <>
      <Section icon={KeyRound} title={t("settings.apiTokens")}>
        <Text className="py-2 text-sm text-neutral-600 dark:text-neutral-400">
          {t("settings.apiTokensIntro")}
        </Text>
        {tokens === null ? (
          failed ? (
            <Row label={t("settings.apiTokensLoadFailed")}>
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
              <SkeletonRows count={2} />
            </View>
          )
        ) : (
          tokens.map((token) => (
            <Row key={token.id} label={token.name} description={describe(token)}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${t("settings.apiTokensRevoke")} ${token.name}`}
                onPress={() => setRevokeTarget(token)}
                className={BUTTON_CLASS}
              >
                <Trash2 size={18} className="text-neutral-600 dark:text-neutral-300" />
                <Text className="text-sm text-neutral-600 dark:text-neutral-300">
                  {t("settings.apiTokensRevoke")}
                </Text>
              </Pressable>
            </Row>
          ))
        )}
        <Row
          label={t("settings.apiTokensCreate")}
          description={unlocked ? undefined : t("settings.apiTokensLocked")}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("settings.apiTokensCreate")}
            disabled={!unlocked}
            onPress={() => setCreating(true)}
            className={`${BUTTON_CLASS} ${unlocked ? "" : "opacity-50"}`}
          >
            <Plus size={18} className="text-neutral-600 dark:text-neutral-300" />
            <Text className="text-sm text-neutral-600 dark:text-neutral-300">
              {t("settings.apiTokensCreate")}
            </Text>
          </Pressable>
        </Row>
      </Section>

      <ConfirmDialog
        visible={creating}
        title={t("settings.apiTokensCreate")}
        message={t("settings.apiTokensCreateMessage")}
        confirmLabel={t("settings.apiTokensCreateConfirm")}
        confirmDisabled={busy || name.trim().length === 0}
        onConfirm={() => void create()}
        onCancel={() => {
          setCreating(false);
          setName("");
        }}
      >
        <View className="gap-1 py-1">
          <TextInput
            accessibilityLabel={t("settings.apiTokensNamePlaceholder")}
            placeholder={t("settings.apiTokensNamePlaceholder")}
            value={name}
            onChangeText={setName}
            maxLength={100}
            autoFocus
            className={INPUT_CLASS}
            onSubmitEditing={() => void create()}
          />
        </View>
      </ConfirmDialog>

      <ConfirmDialog
        visible={created != null}
        title={t("settings.apiTokensCreatedTitle")}
        message={t("settings.apiTokensShownOnce")}
        confirmLabel={t("common.done")}
        onConfirm={() => setCreated(null)}
        onCancel={() => setCreated(null)}
      >
        <View className="gap-2 py-1">
          <Text
            selectable
            testID="api-token-value"
            className="rounded-md bg-neutral-100 px-3 py-2 font-mono text-xs text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
          >
            {created}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("settings.apiTokensCopy")}
            onPress={() => void copy()}
            className={`${BUTTON_CLASS} self-start`}
          >
            <Copy size={18} className="text-neutral-600 dark:text-neutral-300" />
            <Text className="text-sm text-neutral-600 dark:text-neutral-300">
              {t("settings.apiTokensCopy")}
            </Text>
          </Pressable>
        </View>
      </ConfirmDialog>

      <ConfirmDialog
        visible={revokeTarget != null}
        title={t("settings.apiTokensRevokeConfirmTitle")}
        message={t("settings.apiTokensRevokeConfirmMessage", { name: revokeTarget?.name ?? "" })}
        confirmLabel={t("settings.apiTokensRevoke")}
        danger
        onConfirm={() => void revoke()}
        onCancel={() => setRevokeTarget(null)}
      />
    </>
  );
}
