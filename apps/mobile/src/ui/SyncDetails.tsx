import { useContext, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  batchLinksOf,
  resolveScope,
  type EntityKind,
  type LocalStore,
} from "@atlastodo/client-core";
import { AuthContext } from "../auth/AuthContext";
import { useStore } from "../data/StoreProvider";
import { useOnline } from "../hooks/useOnline";
import { useFormat } from "../hooks/useFormat";
import { effectiveSyncStatus } from "../lib/syncStatus";
import { BottomSheet } from "./BottomSheet";
import { SheetScrollView } from "./SheetScroll";
import { ConfirmDialog } from "./ConfirmDialog";
import { Field } from "./Field";
import { RefreshCw, RotateCcw, X } from "./icons";
import { SpinningSyncIcon } from "./SpinningSyncIcon";

/**
 * The "Sync details" panel: current status, last successful sync, ops waiting to push, content
 * waiting for a project key, the last error (HTTP status and server message) and permanently
 * rejected ops (kept until dismissed). "Sync now" runs a cycle immediately; "Resync" (after a confirm) rebuilds this
 * device's copy from the server snapshot, keeping unpushed changes. Opened by the sync badge.
 */
export function SyncDetails({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { store, status, diagnostics, kick, resync, dismissQuarantined } = useStore();
  const online = useOnline();
  const format = useFormat();

  const effective = effectiveSyncStatus(status, online, diagnostics.lastError?.kind);
  const isSyncing = effective === "syncing";
  const networkError = diagnostics.lastError?.kind === "network";

  const statusLabel =
    effective === "syncing"
      ? t("sync.syncing")
      : effective === "offline"
        ? t("sync.offline")
        : effective === "unreachable"
          ? t("sync.serverUnreachable")
          : effective === "error"
            ? t("sync.error")
            : effective === "throttled"
              ? t("sync.throttled")
              : effective === "live-ws"
                ? t("sync.live")
                : t("sync.synced");

  const handleSyncNow = () => {
    void kick();
  };

  const [confirmingResync, setConfirmingResync] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [resyncNotice, setResyncNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const handleResync = () => {
    setConfirmingResync(false);
    if (effective === "offline" || effective === "unreachable") {
      setResyncNotice({
        ok: false,
        text: t(effective === "offline" ? "sync.resyncOffline" : "sync.resyncUnreachable"),
      });
      return;
    }
    setResyncNotice(null);
    setResyncing(true);
    resync()
      .then(
        (outcome) =>
          setResyncNotice(
            outcome === "postponed"
              ? { ok: false, text: t("sync.resyncPostponed") }
              : { ok: true, text: t("sync.resyncDone") },
          ),
        (err: unknown) =>
          setResyncNotice({
            ok: false,
            text: t("sync.resyncFailed", {
              message: err instanceof Error ? err.message : String(err),
            }),
          }),
      )
      .finally(() => setResyncing(false));
  };

  return (
    <BottomSheet visible={open} onClose={onClose} title={t("sync.detailsTitle")}>
      <View className="gap-3">
        <SheetScrollView className="max-h-96">
          <Field label={t("sync.status")} value={statusLabel} />
          <Field
            label={t("sync.lastSynced")}
            value={
              diagnostics.lastSyncAt != null
                ? format.dateTime(diagnostics.lastSyncAt)
                : t("sync.never")
            }
          />
          <Field label={t("sync.pending")} value={String(diagnostics.pending)} />

          {diagnostics.storage === "closed" && (
            <View className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
              <Text className="text-sm text-neutral-800 dark:text-neutral-100">
                {t("sync.storageClosed")}
              </Text>
            </View>
          )}

          {diagnostics.saveError != null && (
            <View className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
              <Text className="text-sm text-neutral-800 dark:text-neutral-100">
                {t("sync.saveFailed", { message: diagnostics.saveError })}
              </Text>
            </View>
          )}

          {diagnostics.clockSkewMs != null && Math.abs(diagnostics.clockSkewMs) >= 60_000 && (
            <View className="mt-2 gap-1 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
              <Text className="text-xs font-medium text-amber-700 dark:text-amber-300">
                {t("sync.clockSkew", {
                  minutes: Math.round(Math.abs(diagnostics.clockSkewMs) / 60_000),
                })}
              </Text>
              <Text className="text-sm text-neutral-800 dark:text-neutral-100">
                {t("sync.clockSkewDetail")}
              </Text>
            </View>
          )}

          {(diagnostics.locked ?? 0) > 0 && (
            <KeyWait
              title={t("invites.lockedValues", { count: diagnostics.locked })}
              hint={t("invites.lockedValuesHint")}
            />
          )}
          {(diagnostics.deferred ?? 0) > 0 && (
            <KeyWait
              title={t("invites.deferredOps", { count: diagnostics.deferred })}
              hint={t("invites.deferredOpsHint")}
            />
          )}
          <KeylessProjects />
          {(diagnostics.leftDiscarded ?? 0) > 0 && (
            <KeyWait
              title={t("sync.leftDiscarded", { count: diagnostics.leftDiscarded })}
              hint={t("sync.leftDiscardedHint")}
            />
          )}

          <View className="mt-2 flex-row flex-wrap gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("sync.syncNow")}
              disabled={isSyncing}
              onPress={handleSyncNow}
              className={`flex-row items-center justify-center gap-2 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-700 web:cursor-pointer ${
                isSyncing ? "opacity-60" : ""
              }`}
            >
              {isSyncing ? (
                <SpinningSyncIcon
                  size={14}
                  duration={500}
                  className="text-neutral-600 dark:text-neutral-300"
                />
              ) : (
                <RefreshCw size={14} className="text-neutral-600 dark:text-neutral-300" />
              )}
              <Text className="text-sm text-neutral-600 dark:text-neutral-300">
                {t("sync.syncNow")}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("sync.resync")}
              accessibilityHint={t("sync.resyncHint")}
              disabled={resyncing}
              onPress={() => setConfirmingResync(true)}
              className={`flex-row items-center justify-center gap-2 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-700 web:cursor-pointer ${
                resyncing ? "opacity-60" : ""
              }`}
            >
              {resyncing ? (
                <SpinningSyncIcon
                  size={14}
                  duration={500}
                  className="text-neutral-600 dark:text-neutral-300"
                />
              ) : (
                <RotateCcw size={14} className="text-neutral-600 dark:text-neutral-300" />
              )}
              <Text className="text-sm text-neutral-600 dark:text-neutral-300">
                {resyncing ? t("sync.resyncing") : t("sync.resync")}
              </Text>
            </Pressable>
          </View>

          {resyncNotice && (
            <View
              accessibilityLiveRegion="polite"
              className={
                "mt-2 rounded-md border p-3 " +
                (resyncNotice.ok
                  ? "border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900"
                  : "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950")
              }
            >
              <Text className="text-sm text-neutral-800 dark:text-neutral-100">
                {resyncNotice.text}
              </Text>
            </View>
          )}

          {diagnostics.lastError && (
            <View className="mt-2 gap-1 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
              <Text className="text-xs font-medium text-amber-700 dark:text-amber-300">
                {networkError ? t("sync.serverUnreachable") : t("sync.lastError")}
                {diagnostics.lastError.status != null
                  ? ` (HTTP ${diagnostics.lastError.status})`
                  : ""}
              </Text>
              {/* A network failure never reached the server, so lead with what to check. */}
              <Text className="text-sm text-neutral-800 dark:text-neutral-100">
                {networkError ? t("sync.serverUnreachableDetail") : diagnostics.lastError.message}
              </Text>
              {networkError && (
                <Text className="text-xs text-neutral-500">{diagnostics.lastError.message}</Text>
              )}
              <Text className="text-xs text-neutral-500">
                {format.dateTime(diagnostics.lastError.at)}
              </Text>
            </View>
          )}

          {diagnostics.quarantined.length > 0 && (
            <View className="mt-2 gap-2">
              <View className="flex-row items-center justify-between gap-2">
                <Text className="flex-1 text-xs font-medium text-neutral-500">
                  {t("sync.quarantined", { count: diagnostics.quarantined.length })}
                </Text>
                {dismissQuarantined && (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => dismissQuarantined()}
                    className="px-1 web:cursor-pointer"
                  >
                    <Text className="text-xs text-neutral-600 dark:text-neutral-300">
                      {t("sync.quarantinedClearAll")}
                    </Text>
                  </Pressable>
                )}
              </View>
              {diagnostics.quarantined.map((q) => {
                const title = entityTitle(store, q.entityKind, q.entityId);
                return (
                  <View
                    key={q.opId}
                    className="gap-0.5 rounded-md border border-red-200 bg-red-50 p-2 dark:border-red-900 dark:bg-red-950"
                  >
                    <View className="flex-row items-start gap-2">
                      <Text className="flex-1 text-xs font-medium text-red-700 dark:text-red-300">
                        {q.entityKind}
                        {q.status != null ? ` - HTTP ${q.status}` : ""}
                      </Text>
                      {dismissQuarantined && (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={t("sync.quarantinedDismiss")}
                          hitSlop={8}
                          onPress={() => dismissQuarantined(q.opId)}
                          className="web:cursor-pointer"
                        >
                          <X size={14} className="text-neutral-500 dark:text-neutral-400" />
                        </Pressable>
                      )}
                    </View>
                    {title !== null && (
                      <Text
                        numberOfLines={2}
                        className="text-sm font-medium text-neutral-900 dark:text-neutral-100"
                      >
                        {title}
                      </Text>
                    )}
                    <Text className="text-sm text-neutral-800 dark:text-neutral-100">
                      {q.status === 413 ? t("sync.quarantinedTooLarge") : q.message}
                    </Text>
                    <Text className="text-xs text-neutral-500">
                      {title === null ? `${q.entityId} · ` : ""}
                      {format.dateTime(q.at)}
                    </Text>
                  </View>
                );
              })}
            </View>
          )}
        </SheetScrollView>
      </View>

      {confirmingResync && (
        <ConfirmDialog
          visible
          title={t("sync.resyncTitle")}
          message={t("sync.resyncBody")}
          confirmLabel={t("sync.resync")}
          onConfirm={handleResync}
          onCancel={() => setConfirmingResync(false)}
        />
      )}
    </BottomSheet>
  );
}

/**
 * The shared projects the user is a member (not owner) of and holds no key for, each with a way
 * out. Their names are encrypted under the missing key, so this is the only place to leave them;
 * only the owner can send the key. Leaving discards the changes held back for the key. The user's
 * own projects are not listed: key maintenance gives them a key.
 */
function KeylessProjects() {
  const { t } = useTranslation();
  const auth = useContext(AuthContext);
  const { store, kick, diagnostics } = useStore();
  const [confirming, setConfirming] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const keyring = auth?.keyring ?? null;
  const myId = auth?.session?.user.id;

  const projects = useMemo(() => {
    if (!keyring || !myId) return [];
    const joined = new Set<string>();
    for (const e of store.list("project_member")) {
      if (e.fields.user_id === myId && e.fields.state === "active" && e.fields.role !== "owner")
        joined.add(String(e.fields.project_id));
    }
    return [...joined]
      .filter((id) => !keyring.getProjectKey(id))
      .sort()
      .map((id) => {
        const name = store.get("project", id)?.name;
        return {
          id,
          name:
            typeof name === "string" && name !== ""
              ? name
              : t("sync.keylessProject", { id: id.slice(0, 8) }),
        };
      });
    // The diagnostics fields change after a sync and re-read the mutable store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, keyring, myId, t, diagnostics.lastSyncAt, diagnostics.deferred, diagnostics.locked]);

  if (!auth || !myId || projects.length === 0) return null;

  const leave = async (project: { id: string; name: string }) => {
    setConfirming(null);
    setBusy(true);
    setNotice(null);
    try {
      await auth.api.removeMember(project.id, myId);
      const ops = store.unsyncedOps();
      const batch = batchLinksOf(ops);
      store.discard(
        ops
          .filter((op) => {
            const scope = resolveScope(store, op.entity, op.entityId, batch);
            return scope.kind === "project" && scope.projectId === project.id;
          })
          .map((op) => op.id),
      );
      kick();
      setNotice({ ok: true, text: t("sync.keylessLeft", { name: project.name }) });
    } catch (err) {
      setNotice({
        ok: false,
        text: t("sync.keylessLeaveFailed", {
          name: project.name,
          message: err instanceof Error ? err.message : String(err),
        }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="gap-1 border-b border-neutral-100 py-2 dark:border-neutral-800">
      <Text className="text-sm text-neutral-900 dark:text-neutral-100">
        {t("sync.keylessTitle")}
      </Text>
      <Text className="text-xs text-neutral-500">{t("sync.keylessHint")}</Text>
      {projects.map((project) => (
        <View key={project.id} className="flex-row items-center justify-between gap-2 py-1">
          <Text className="flex-1 text-sm text-neutral-700 dark:text-neutral-300">
            {project.name}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("sync.keylessLeaveLabel", { name: project.name })}
            disabled={busy}
            onPress={() => setConfirming(project)}
            className={`rounded-md border border-neutral-200 px-3 py-1.5 dark:border-neutral-700 web:cursor-pointer ${
              busy ? "opacity-60" : ""
            }`}
          >
            <Text className="text-sm text-neutral-600 dark:text-neutral-300">
              {t("sync.keylessLeave")}
            </Text>
          </Pressable>
        </View>
      ))}
      {notice && (
        <Text
          accessibilityLiveRegion="polite"
          className={
            "text-xs " +
            (notice.ok
              ? "text-neutral-600 dark:text-neutral-300"
              : "text-red-600 dark:text-red-400")
          }
        >
          {notice.text}
        </Text>
      )}
      {confirming && (
        <ConfirmDialog
          visible
          title={t("sync.keylessLeaveTitle")}
          message={t("sync.keylessLeaveBody", { name: confirming.name })}
          confirmLabel={t("sync.keylessLeave")}
          danger
          onConfirm={() => void leave(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </View>
  );
}

/**
 * The rejected change's entity as the user named it (a task's title, a project's name, ...), while
 * this device still holds it readable; null for one it never kept (a rejected create was taken
 * back) or can't open (no key yet).
 */
function entityTitle(store: LocalStore, kind: string, id: string): string | null {
  const fields = store.get(kind as EntityKind, id);
  const value = fields?.title ?? fields?.name;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function KeyWait({ title, hint }: { title: string; hint: string }) {
  return (
    <View className="gap-0.5 border-b border-neutral-100 py-2 dark:border-neutral-800">
      <Text className="text-sm text-neutral-900 dark:text-neutral-100">{title}</Text>
      <Text className="text-xs text-neutral-500">{hint}</Text>
    </View>
  );
}
