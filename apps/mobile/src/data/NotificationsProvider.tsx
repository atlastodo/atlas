import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  decryptField,
  decryptJson,
  isEncryptedEnvelope,
  isFieldEnvelopeV2,
  openFieldValue,
  openProjectKeyRow,
  projectKeyId,
  recordAcceptedProject,
  type InviteView,
  type KeyScope,
  type Keyring,
  type LocalStore,
} from "@atlastodo/client-core";
import { useAuth } from "../auth/AuthContext";
import { loadProjectKeys } from "../hooks/useProjectKeyMaintenance";
import { useStore } from "./StoreProvider";
import { useToast } from "./ToastProvider";

/**
 * Notifications: a screen and a drawer badge read one shared list. Invites are listed over REST
 * (`GET /invites`); the sync store only says when to look again, since a pending invitee receives
 * its own `project_member` row the moment it is invited. The only kind today is a shared-project
 * invite; the discriminated union leaves room for others.
 */

/** An invite's project fields, decrypted where possible. */
export interface InviteProject {
  /** The decrypted name, or null when it cannot be read (render a generic, locked label). */
  name: string | null;
  icon: string | null;
  color: string | null;
  kind: string | null;
}

export interface InviteNotification {
  kind: "invite";
  /** Stable id for keys/dedup -- the project the invite is for. */
  id: string;
  invite: InviteView;
  project: InviteProject;
}
export type AppNotification = InviteNotification;

export interface NotificationsApi {
  notifications: AppNotification[];
  count: number;
  loading: boolean;
  error: boolean;
  refresh: () => Promise<void>;
  /** Accept an invite. Rejects when it fails, so the caller can say so. */
  accept: (projectId: string) => Promise<void>;
  /** Decline an invite (server removes the pending row). Rejects when it fails. */
  decline: (projectId: string) => Promise<void>;
  /** Invites that newly arrived and have not been announced with a toast yet. */
  announcements: InviteNotification[];
  /** Mark announcements as shown. */
  markAnnounced: (ids: string[]) => void;
}

/** Exported so tests can supply a controlled value without a live ApiClient. */
const NotificationsContext = createContext<NotificationsApi | null>(null);

/** The project ids of the user's own pending `project_member` rows, sorted. */
function ownPendingProjectIds(store: LocalStore, userId: string | undefined): string[] {
  if (!userId) return [];
  const ids = new Set<string>();
  for (const e of store.list("project_member")) {
    const f = e.fields;
    if (f.user_id === userId && f.state === "pending" && typeof f.project_id === "string") {
      ids.add(f.project_id);
    }
  }
  return [...ids].sort();
}

type InviteKey = { key: Uint8Array; keyId: string };

/**
 * The project key delivered with the invite, if this device can open it. Used only to preview the
 * invite's project; the key is loaded for use only once the user accepts.
 */
function inviteKey(invite: InviteView, keyring: Keyring | null): InviteKey | null {
  if (!invite.sealed_key || !keyring?.getPrivateKey()) return null;
  try {
    const key = openProjectKeyRow(invite.sealed_key.encrypted_pek, keyring, invite.project_id);
    return { key, keyId: projectKeyId(key) };
  } catch {
    return null;
  }
}

/** A project field as stored: plaintext, or an envelope (possibly serialised) that must be opened. */
function readField(
  raw: unknown,
  projectId: string,
  field: string,
  key: InviteKey | null,
  keyring: Keyring | null,
): { ok: true; value: unknown } | { ok: false } {
  let value = raw;
  if (typeof value === "string" && value.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isEncryptedEnvelope(parsed)) value = parsed;
    } catch {
      // an ordinary string that happens to start with a brace
    }
  }
  if (!isEncryptedEnvelope(value)) return { ok: true, value };
  const scope: KeyScope = { kind: "project", projectId };
  const at = { entity: "project", entityId: projectId, field };
  if (key) {
    try {
      if (isFieldEnvelopeV2(value))
        return { ok: true, value: decryptField(key.key, scope, at, value) };
      return { ok: true, value: decryptJson(key.key, { iv: value.iv, ct: value.ct }) };
    } catch {
      // not under the delivered key; try what the keyring holds
    }
  }
  if (keyring?.hasKeys()) {
    const opened = openFieldValue(keyring, value, at, scope);
    if (opened) return { ok: true, value: opened.value };
  }
  return { ok: false };
}

function readString(
  invite: InviteView,
  field: "name" | "icon" | "color" | "kind",
  key: InviteKey | null,
  keyring: Keyring | null,
): string | null {
  const read = readField(invite.project[field], invite.project_id, field, key, keyring);
  return read.ok && typeof read.value === "string" && read.value !== "" ? read.value : null;
}

/**
 * Decrypt an invite's project fields with the key sealed to this user, falling back to the keys the
 * keyring already holds. Anything that stays unreadable comes back null, never as envelope JSON.
 */
function readInviteProject(invite: InviteView, keyring: Keyring | null): InviteProject {
  const key = inviteKey(invite, keyring);
  return {
    name: readString(invite, "name", key, keyring),
    icon: readString(invite, "icon", key, keyring),
    color: readString(invite, "color", key, keyring),
    kind: readString(invite, "kind", key, keyring),
  };
}

/** One toast per invite: a re-invite after a decline has a new `invited_at` and toasts again. */
const announceKey = (invite: InviteView) => `${invite.project_id}:${invite.invited_at}`;

/**
 * Fetches the user's notifications and shares them. The list is fetched again whenever the user's
 * own pending membership rows change: a new row is a new invite, a vanished one an accept, decline
 * or revoke made elsewhere.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { api, keyring, session } = useAuth();
  const { store, version, kick, localOnly } = useStore();
  const userId = session?.user.id;
  const [invites, setInvites] = useState<InviteView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [announcements, setAnnouncements] = useState<InviteNotification[]>([]);
  // The latest listing wins the displayed state, so a slow earlier one never overwrites it.
  const requestSeq = useRef(0);

  const load = useCallback(async (): Promise<InviteView[] | null> => {
    // Local-only mode has no server and so no invites.
    if (localOnly) {
      setLoading(false);
      return [];
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const list = await api.listInvites();
      if (seq === requestSeq.current) {
        setInvites(list);
        setError(false);
      }
      return list;
    } catch {
      if (seq === requestSeq.current) setError(true);
      return null;
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [api, localOnly]);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toNotification = useCallback(
    (invite: InviteView): InviteNotification => ({
      kind: "invite",
      id: invite.project_id,
      invite,
      project: readInviteProject(invite, keyring),
    }),
    [keyring],
  );

  // Rows present when the provider mounts are not news; only rows that appear later are announced.
  const pendingKey = useMemo(
    () => ownPendingProjectIds(store, userId).join(","),
    // `version` bumps on every store change; the ids are re-derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, version, userId],
  );
  const seenRows = useRef<Set<string> | null>(null);
  const announced = useRef(new Set<string>());
  useEffect(() => {
    const current = new Set(pendingKey === "" ? [] : pendingKey.split(","));
    const previous = seenRows.current;
    seenRows.current = current;
    if (previous === null) return;
    const appeared = [...current].filter((id) => !previous.has(id));
    const vanished = [...previous].some((id) => !current.has(id));
    if (appeared.length === 0 && !vanished) return;
    void load().then((list) => {
      if (!list) return;
      const fresh = list.filter(
        (inv) => appeared.includes(inv.project_id) && !announced.current.has(announceKey(inv)),
      );
      if (fresh.length === 0) return;
      for (const inv of fresh) announced.current.add(announceKey(inv));
      setAnnouncements((prev) => [...prev, ...fresh.map(toNotification)]);
    });
  }, [pendingKey, load, toNotification]);

  const markAnnounced = useCallback((ids: string[]) => {
    setAnnouncements((prev) => prev.filter((n) => !ids.includes(n.id)));
  }, []);

  const hydrate = useCallback(async () => {
    if (keyring?.hasKeys()) await loadProjectKeys(api, keyring, store, userId);
  }, [api, keyring, store, userId]);

  const accept = useCallback(
    async (projectId: string) => {
      // Sealed keys are loaded only for invites we accepted; recorded before the load.
      recordAcceptedProject(store, projectId);
      // Load the key the owner sealed to us first, so the project reads the moment it syncs in.
      await hydrate();
      await api.acceptInvite(projectId);
      // Once a member, the server names the canonical key and hydrating stores our wrapped copy.
      // The store reloads keys when our membership turns active, so a failure here is not fatal.
      try {
        await hydrate();
      } catch (err) {
        console.warn("[atlas-e2ee] could not reload project keys after accepting:", err);
      }
      await refresh();
      kick();
    },
    [api, store, hydrate, refresh, kick],
  );

  const decline = useCallback(
    async (projectId: string) => {
      await api.declineInvite(projectId);
      await refresh();
    },
    [api, refresh],
  );

  const notifications = useMemo<AppNotification[]>(
    () => invites.map(toNotification),
    [invites, toNotification],
  );

  const value = useMemo<NotificationsApi>(
    () => ({
      notifications,
      count: notifications.length,
      loading,
      error,
      refresh,
      accept,
      decline,
      announcements,
      markAnnounced,
    }),
    [notifications, loading, error, refresh, accept, decline, announcements, markAnnounced],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsApi {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("useNotifications must be used within a NotificationsProvider");
  return ctx;
}

const ROLE_KEY = {
  owner: "share.owner",
  editor: "share.editor",
  commenter: "share.commenter",
} as const;

/** Who sent an invite, for display: their name, else their email. */
function inviterName(invite: InviteView): string | null {
  return invite.inviter?.display_name || invite.inviter?.email || null;
}

/**
 * Toast each newly arrived invite once, with a View action. A hook rather than part of the
 * provider because the toast layer mounts inside it; `onView` is injected so navigation stays with
 * the route tree.
 */
export function useInviteToasts(onView: () => void): void {
  const { t } = useTranslation();
  const toast = useToast();
  const { announcements, markAnnounced } = useNotifications();
  const onViewRef = useRef(onView);
  useEffect(() => {
    onViewRef.current = onView;
  });

  useEffect(() => {
    if (announcements.length === 0) return;
    for (const n of announcements) {
      const opts = {
        inviter: inviterName(n.invite) ?? t("invites.someone"),
        project: n.project.name ?? "",
        role: t(ROLE_KEY[n.invite.role]),
      };
      toast.show(
        n.project.name != null ? t("invites.toast", opts) : t("invites.toastLocked", opts),
        { label: t("invites.view"), run: () => onViewRef.current() },
      );
    }
    markAnnounced(announcements.map((n) => n.id));
  }, [announcements, markAnnounced, toast, t]);
}
