import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { SessionView } from "@atlas/client-core";
import { useAuth } from "../../auth/AuthContext";
import { useToast } from "../../data/ToastProvider";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Row, Section } from "../../ui/Section";
import { SkeletonRows } from "../../ui/Skeleton";
import { LogOut, Pencil, RefreshCw, Smartphone } from "../../ui/icons";
import { relativeLabel } from "./relativeLabel";
import { DangerButton, DangerZone } from "./shared";

function RenameDeviceDialog({
  session,
  onClose,
  onRenamed,
}: {
  session: SessionView | null;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const { t } = useTranslation();
  const { api } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(session?.device_name ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(session?.device_name ?? "");
  }, [session]);

  if (!session) return null;

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || saving) return;
    setSaving(true);
    try {
      await api.renameSession(session.device_id, trimmed);
      toast.show(t("settings.devicesRenamed"));
      onClose();
      onRenamed();
    } catch {
      toast.show(t("settings.devicesRenameFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ConfirmDialog
      visible={true}
      title={t("settings.devicesRenameTitle")}
      confirmLabel={t("common.save")}
      onConfirm={() => void submit()}
      onCancel={onClose}
    >
      <View className="gap-1 py-1">
        <TextInput
          accessibilityLabel={t("settings.devicesRenamePlaceholder")}
          placeholder={t("settings.devicesRenamePlaceholder")}
          value={name}
          onChangeText={setName}
          autoFocus
          autoCapitalize="sentences"
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          onSubmitEditing={() => void submit()}
        />
      </View>
    </ConfirmDialog>
  );
}

/**
 * Devices & sessions: every device signed in to the account (`GET /auth/sessions`). The current
 * device's row has no sign-out button, because the server refuses self-revocation on this route;
 * "Sign out" in the account section is the way out. Signing out other devices goes through a
 * {@link ConfirmDialog}, being irreversible.
 */
export function DevicesSection() {
  const { t } = useTranslation();
  const { api } = useAuth();
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRevokeOthers, setConfirmRevokeOthers] = useState(false);
  const [renameTarget, setRenameTarget] = useState<SessionView | null>(null);
  const handleCloseRename = useCallback(() => setRenameTarget(null), []);

  const load = useCallback(async () => {
    setFailed(false);
    setReloading(true);
    try {
      setSessions(await api.listSessions());
    } catch {
      setFailed(true);
    } finally {
      setReloading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (deviceId: string) => {
    setBusyId(deviceId);
    try {
      await api.revokeSession(deviceId);
      toast.show(t("settings.devicesRevoked"));
      await load();
    } catch {
      toast.show(t("settings.devicesRevokeFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const revokeOthers = async () => {
    setConfirmRevokeOthers(false);
    try {
      await api.revokeOtherSessions();
      toast.show(t("settings.devicesRevokeOthersDone"));
      await load();
    } catch {
      toast.show(t("settings.devicesRevokeOthersFailed"));
    }
  };

  const deviceName = (s: SessionView) =>
    s.device_name || t("settings.devicesDeviceLabel", { id: s.device_id.slice(0, 8) });

  const formatMoment = (ms: number, now: number, justNowKey: string, relativeKey: string) => {
    const diff = Math.round((ms - now) / 60_000);
    if (diff === 0) return t(justNowKey);
    return t(relativeKey, { when: relativeLabel(ms, now) });
  };

  const whenPart = (s: SessionView) => {
    const now = Date.now();
    return (
      formatMoment(s.created_at, now, "settings.devicesCreatedJustNow", "settings.devicesCreated") +
      " · " +
      formatMoment(
        s.last_used_at,
        now,
        "settings.devicesLastUsedJustNow",
        "settings.devicesLastUsed",
      )
    );
  };

  const expiresPart = (s: SessionView) =>
    t("settings.devicesExpires", {
      when: relativeLabel(s.expires_at, Date.now()),
    });

  const others = (sessions ?? []).filter((s) => !s.current);

  return (
    <>
      <Section icon={Smartphone} title={t("settings.devices")}>
        {sessions === null ? (
          failed ? (
            <Row label={t("settings.devicesLoadFailed")}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("settings.devicesLoadRetry")}
                onPress={() => void load()}
                className="flex-row items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
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
          <>
            {sessions.length === 0
              ? null
              : sessions.map((s) => (
                  <Row key={s.device_id} label={deviceName(s)} description={whenPart(s)}>
                    <View className="flex-row items-center gap-2">
                      {s.current && (
                        <Text className="text-xs font-medium text-accent-600 dark:text-accent-400">
                          {t("settings.devicesThisDevice")}
                        </Text>
                      )}
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${t("settings.devicesRename")} ${deviceName(s)}`}
                        disabled={busyId !== null}
                        onPress={() => setRenameTarget(s)}
                        hitSlop={8}
                        className="p-1 rounded web:cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800"
                      >
                        <Pencil size={16} className="text-neutral-500 dark:text-neutral-400" />
                      </Pressable>
                      {!s.current && (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`${t("settings.devicesRevoke")} ${deviceName(s)}`}
                          accessibilityHint={expiresPart(s)}
                          disabled={busyId !== null}
                          onPress={() => void revoke(s.device_id)}
                          className="flex-row items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
                        >
                          <LogOut size={18} className="text-neutral-600 dark:text-neutral-300" />
                          <Text className="text-sm text-neutral-600 dark:text-neutral-300">
                            {t("settings.devicesRevoke")}
                          </Text>
                        </Pressable>
                      )}
                    </View>
                  </Row>
                ))}
          </>
        )}
      </Section>

      {sessions !== null && (
        <DangerZone>
          <Row
            label={t("settings.devicesRevokeOthers")}
            description={t("settings.devicesRevokeOthersDesc")}
          >
            <DangerButton
              icon={LogOut}
              label={t("settings.devicesRevokeOthers")}
              disabled={reloading || busyId !== null || others.length === 0}
              onPress={() => setConfirmRevokeOthers(true)}
            />
          </Row>
        </DangerZone>
      )}

      <ConfirmDialog
        visible={confirmRevokeOthers}
        title={t("settings.devicesRevokeOthersConfirmTitle")}
        message={t("settings.devicesRevokeOthersConfirmMessage")}
        confirmLabel={t("settings.devicesRevokeOthers")}
        danger
        onConfirm={() => void revokeOthers()}
        onCancel={() => setConfirmRevokeOthers(false)}
      />

      <RenameDeviceDialog
        session={renameTarget}
        onClose={handleCloseRename}
        onRenamed={() => void load()}
      />
    </>
  );
}
