import { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { AdminAuditEntry, AdminInviteView } from "@atlastodo/client-core";
import { useAdminSettings } from "../hooks/useAdminSettings";
import { useAdminInvites } from "../hooks/useAdminInvites";
import { useAdminAudit } from "../hooks/useAdminAudit";
import { useFormat } from "../hooks/useFormat";
import { useToast } from "../data/ToastProvider";
import { loadServerUrl } from "../auth/serverUrl";
import { Toggle } from "../ui/Toggle";
import { SkeletonRows } from "../ui/Skeleton";
import { EmptyState } from "../ui/EmptyState";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Section } from "../ui/Section";
import { Check, CircleAlert, CircleX, History, Plus, Send, UserPlus } from "../ui/icons";
import { copyText } from "../lib/clipboard";

/** The admin panel's instance section: the runtime signup toggle, signup invites, and the audit trail of admin actions. REST-driven (instance state, not a user's replica). */
export function AdminSettingsScreen() {
  const { t } = useTranslation();
  const { settings, loading, failed, refresh, setSignupEnabled } = useAdminSettings();
  const { invites, create, revoke } = useAdminInvites();
  const { entries } = useAdminAudit();
  const format = useFormat();
  const toast = useToast();
  const [freshInvite, setFreshInvite] = useState<AdminInviteView | null>(null);
  const [copied, setCopied] = useState(false);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadServerUrl()
      .then((url) => {
        if (live) setServerUrl(url);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const onCreate = () => {
    void create().then((invite) => {
      if (invite) {
        setCopied(false);
        setFreshInvite(invite);
        toast.show(t("admin.inviteCreated"));
      } else {
        toast.show(t("admin.actionFailed"));
      }
    });
  };

  const onRevoke = (id: string) => {
    void revoke(id).then((ok) =>
      toast.show(ok ? t("admin.inviteRevoked") : t("admin.actionFailed")),
    );
  };

  return (
    <View className="flex-1">
      <ScrollView className="flex-1" contentContainerClassName="px-4 pb-16 pt-4">
        {loading ? (
          <View className="pb-6">
            <SkeletonRows count={3} />
          </View>
        ) : failed || !settings ? (
          <EmptyState
            icon={CircleAlert}
            title={t("admin.settingsLoadFailed")}
            actions={[{ label: t("common.retry"), onPress: () => void refresh(), primary: true }]}
          />
        ) : (
          <Section icon={UserPlus} title={t("admin.signupSection")}>
            <Toggle
              label={t("admin.signupToggle")}
              description={t("admin.signupToggleDesc")}
              value={settings.signup_enabled}
              onValueChange={(next) =>
                void setSignupEnabled(next).then((ok) => {
                  if (!ok) toast.show(t("admin.actionFailed"));
                })
              }
              accessibilityLabel={t("admin.signupToggle")}
              className="py-3.5"
            />
          </Section>
        )}

        <InviteSection invites={invites} onCreate={onCreate} onRevoke={onRevoke} />

        <Section icon={History} title={t("admin.auditSection")}>
          {entries.length === 0 ? (
            <Text className="py-3.5 text-sm text-neutral-500 dark:text-neutral-400">
              {t("admin.noAudit")}
            </Text>
          ) : (
            entries.map((entry, index) => (
              <AuditRow
                key={entry.id}
                entry={entry}
                first={index === 0}
                when={format.dateTime(entry.created_at_ms)}
              />
            ))
          )}
        </Section>
      </ScrollView>

      {/* The freshly minted invite, with the link to copy. The server hands out the code only in
          this answer (the list never carries it), so this is the one chance to copy the link.
          Copying keeps the dialog open; "Done" closes it. */}
      {freshInvite?.code ? (
        <ConfirmDialog
          visible
          title={t("admin.inviteCreatedTitle")}
          message={t("admin.inviteCreatedBody", {
            expires: format.date(freshInvite.expires_at_ms),
          })}
          confirmLabel={copied ? t("common.copied") : t("admin.copyInvite")}
          cancelLabel={t("common.done")}
          onConfirm={async () => {
            await copyText(inviteUrl(freshInvite.code!, serverUrl));
            setCopied(true);
            toast.show(t("admin.inviteCopied"));
          }}
          onCancel={() => setFreshInvite(null)}
        >
          <View className="flex-row items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5 dark:border-neutral-800 dark:bg-zinc-950">
            <Text
              selectable
              className="flex-1 font-mono text-xs text-neutral-800 web:break-all dark:text-neutral-200"
            >
              {inviteUrl(freshInvite.code, serverUrl)}
            </Text>
            {copied && <Check size={16} className="text-accent-600 dark:text-accent-400" />}
          </View>
          <Text className="text-xs text-neutral-500 dark:text-neutral-400">
            {t("admin.inviteLinkOnce")}
          </Text>
        </ConfirmDialog>
      ) : null}
    </View>
  );
}

/**
 * The shareable signup link for an invite code. In a browser tab it points at this web app; on a
 * phone or in the desktop app (`app://`) it points at the server, which serves the same web app
 * at its root and the API under `/api` (a trailing `/api` on the server URL is dropped).
 */
function inviteUrl(code: string, serverUrl: string | null): string {
  const inBrowserTab =
    Platform.OS === "web" &&
    typeof window !== "undefined" &&
    /^https?:$/.test(window.location?.protocol ?? "");
  const base = inBrowserTab
    ? window.location.origin
    : (serverUrl ?? "").replace(/\/+$/, "").replace(/\/api$/, "");
  return `${base}/signup?invite=${encodeURIComponent(code)}`;
}

function InviteSection({
  invites,
  onCreate,
  onRevoke,
}: {
  invites: AdminInviteView[];
  onCreate: () => void;
  onRevoke: (id: string) => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const live = invites.filter((i) => i.used_at_ms == null && i.revoked_at_ms == null);

  return (
    <Section icon={Send} title={t("admin.inviteSection")}>
      {live.length === 0 ? (
        <Text className="py-3.5 text-sm text-neutral-500 dark:text-neutral-400">
          {t("admin.noInvites")}
        </Text>
      ) : (
        live.map((invite, index) => (
          <View
            key={invite.id}
            className={
              "flex-row items-center gap-2 py-3 " +
              (index === 0 ? "" : "border-t border-neutral-200/50 dark:border-neutral-800/60")
            }
          >
            <View className="flex-1">
              <Text numberOfLines={1} className="text-sm text-neutral-900 dark:text-neutral-100">
                {t("admin.inviteExpires", {
                  created: format.date(invite.created_at_ms),
                  expires: format.date(invite.expires_at_ms),
                })}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("admin.revokeInvite")}
              onPress={() => onRevoke(invite.id)}
              className="p-2"
            >
              <CircleX size={16} className="text-red-600 dark:text-red-400" />
            </Pressable>
          </View>
        ))
      )}
      <View className="border-t border-neutral-200/50 py-3 dark:border-neutral-800/60">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("admin.createInvite")}
          onPress={onCreate}
          className="min-h-10 flex-row items-center justify-center gap-1.5 self-start rounded-md bg-accent-600 px-3.5 py-2 web:cursor-pointer web:hover:bg-accent-700 active:bg-accent-700"
        >
          <Plus size={16} className="text-white" />
          <Text className="text-sm font-semibold text-white">{t("admin.createInvite")}</Text>
        </Pressable>
      </View>
    </Section>
  );
}

function AuditRow({
  entry,
  when,
  first,
}: {
  entry: AdminAuditEntry;
  when: string;
  first: boolean;
}) {
  const { t } = useTranslation();
  return (
    <View
      className={
        "py-3 " + (first ? "" : "border-t border-neutral-200/50 dark:border-neutral-800/60")
      }
    >
      <View className="flex-row items-center gap-2">
        <Text numberOfLines={1} className="flex-1 text-sm text-neutral-900 dark:text-neutral-100">
          {t(`admin.action.${entry.action}`, entry.action)}
        </Text>
      </View>
      <Text className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        {`${actorLabel(entry, t("admin.systemActor"))}${
          entry.target_email ? ` → ${entry.target_email}` : ""
        } · ${when}`}
      </Text>
    </View>
  );
}

/** Who did it: the admin's email, or for an entry with no actor the system and its recorded source (`cli`, `env`, `purge`). */
function actorLabel(entry: AdminAuditEntry, system: string): string {
  if (entry.actor_email) return entry.actor_email;
  const source = entry.details?.source;
  return typeof source === "string" && source ? `${system} (${source})` : system;
}
