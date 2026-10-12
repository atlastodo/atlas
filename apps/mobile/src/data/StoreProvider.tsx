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
import { AppState, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { randomUUID } from "expo-crypto";
import {
  ApiError,
  AttachmentQueue,
  DEFAULT_MAX_BLOB_BYTES,
  LocalStore,
  NetworkError,
  PersistError,
  SyncClient,
  KEY_TRUST_ID,
  hydrateProjectKeys,
  isProjectCreator,
  readKeyTrust,
  recordKeyTrustBaseline,
  recordLegacySharesAccepted,
  revokedProjectOps,
  recordLegacyMigrated,
  reviveLockedValues,
  type ApiClient,
  type Keyring,
  type Operation,
  type Persistence,
  type SyncStatus,
} from "@atlas/client-core";
import type { SyncErrorKind } from "../lib/syncStatus";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { CIPHERTEXT_AS_BLOB, createPersistence } from "./persistence";
import { deleteLocalData, migrationKeys } from "./localData";
import { markLocalDataUsed } from "./localUpgrade";
import { loadQuarantined, mergeQuarantined, saveQuarantined } from "./quarantineLog";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { clearSharedFiles } from "../lib/attachmentFiles";
import { AppSkeleton } from "../ui/AppSkeleton";
import { SkeletonGate } from "../ui/Skeleton";

const SYNC_INTERVAL_MS = 5000;
/**
 * The poll while the realtime socket is live and nothing waits to push: the socket delivers other
 * devices' changes (and pulls any gap it sees), so the poll is only the safety net then.
 */
const LIVE_SYNC_INTERVAL_MS = 30_000;

/** A sync failure, captured for the "Sync details" panel. */
export interface SyncErrorInfo {
  kind: SyncErrorKind;
  /** HTTP status when the error came from the server; absent for a network error. */
  status?: number;
  message: string;
  /** When it happened (Unix ms). */
  at: number;
}

/** A permanently-rejected op the server refused, dropped from the outbox so it stops wedging sync. */
export interface QuarantinedOp {
  opId: string;
  entityKind: string;
  entityId: string;
  status?: number;
  message: string;
  at: number;
}

/** Diagnostics surfaced by the sync layer, for the tappable badge's details panel. */
export interface SyncDiagnostics {
  /** The most recent sync failure, or null if the last cycle succeeded. */
  lastError: SyncErrorInfo | null;
  /** When the last sync cycle succeeded (Unix ms), or null if none yet this session. */
  lastSyncAt: number | null;
  /**
   * Ops the server permanently rejected (403/400/422/413) and dropped from the outbox, newest
   * first. Kept on this device across restarts (see `quarantineLog`) until the user dismisses them.
   */
  quarantined: QuarantinedOp[];
  /** Unsynced ops still waiting to push. */
  pending: number;
  /** Field values no key on this device opens yet (shown as locked content). */
  locked?: number;
  /** Queued ops held back until this device has their shared project's key. */
  deferred?: number;
  /** Queued changes to projects the user left, dropped this session: they could never be sent. */
  leftDiscarded?: number;
  /**
   * `"closed"`: another browser tab upgraded the local database, so this tab can no longer save to
   * it and should be reloaded (web only).
   */
  storage?: "closed" | null;
  /**
   * Server time minus device time while the server refuses pushes for a fast device clock; null
   * (or absent) otherwise.
   */
  clockSkewMs?: number | null;
  /**
   * Why changes could not be written to the local database, while some are still unsaved; null
   * (or absent) otherwise. They stay in memory and are written again on the next sync.
   */
  saveError?: string | null;
}

/** What the server said about attachments (`GET /attachments/config`). */
export interface AttachmentServerConfig {
  enabled: boolean;
  /** The largest blob it accepts; null when the server did not say. */
  maxBlobBytes: number | null;
}

export interface AttachmentsContextValue {
  /** The session's durable upload queue (one per persistence/user). */
  queue: AttachmentQueue;
  /**
   * Drop one device-local queue row. A terminal `failed`/`cancelled` entry has no synced entity,
   * so this is local cleanup; an upload of that row still in flight publishes nothing.
   */
  removeUpload: (id: string) => Promise<void>;
  /** The server's answer, or null until it gave one (offline, or not asked yet). */
  server?: AttachmentServerConfig | null;
}

export interface StoreContextValue {
  /** The one local-first store shared by every view (tasks, projects, sections, filters). */
  store: LocalStore;
  status: SyncStatus;
  /** Bumps on every store change; use it as a memo dependency to re-derive reads. */
  version: number;
  /** Trigger a background sync now (call after local writes for prompt propagation). */
  kick: () => void;
  /**
   * Rebuild the synced state from the server's snapshot, keeping unsynced local changes (they are
   * pushed first). Rejects when the cycle fails; resolves `"postponed"` when sync is paused (a
   * rate-limit wait, or a refused app version) and the rebuild waits for the next cycle.
   */
  resync: () => Promise<"postponed" | void>;
  /** Sync diagnostics for the "Sync details" panel. */
  diagnostics: SyncDiagnostics;
  /** Drop one rejected change from the list (by op id), or every one without an id. */
  dismissQuarantined?: (opId?: string) => void;
  /** Whether the store has completed its initial sync pull or loaded existing persisted data. */
  initialSyncDone: boolean;
  /** The attachment queue, or null until the store and an unlocked keyring exist (no plaintext path). */
  attachments: AttachmentsContextValue | null;
  /**
   * Local-only mode: the store lives only on this device, with no server, sync, sharing or
   * attachments. Absent (false) for an account's store.
   */
  localOnly?: boolean;
}

function toErrorInfo(err: unknown): SyncErrorInfo {
  if (err instanceof ApiError)
    return { kind: "http", status: err.status, message: err.message, at: Date.now() };
  // The server was fine; this device could not store what it received.
  if (err instanceof PersistError) return { kind: "storage", message: err.message, at: Date.now() };
  // A NetworkError (or any non-HTTP throw) means the request never reached the server.
  const message = err instanceof NetworkError || err instanceof Error ? err.message : String(err);
  return { kind: "network", message, at: Date.now() };
}

/** Exported so a test can supply a real in-memory `LocalStore` without SQLite, a network or a session. */
export const StoreContext = createContext<StoreContextValue | null>(null);

/**
 * Owns the single {@link LocalStore} + {@link SyncClient} for the signed-in session and exposes them
 * to every view.
 *
 * - Ids come from expo-crypto: `LocalStore` defaults to `crypto.randomUUID()`, which Hermes lacks,
 *   and the server rejects a non-UUID `entity_id` with a 422 that fails the whole push batch.
 * - The cursor lives in the op-log database (persistence is always present).
 * - Sync also runs when the app returns to the foreground; RN has no `online` event.
 *
 * `api` and `deviceId` are injected rather than read from the auth context, keeping the store
 * independent and testable. Without `api` the store is local-only (see `auth/localMode.tsx`): it
 * loads and saves on this device and nothing else runs.
 */
export function StoreProvider({
  api,
  deviceId,
  userId,
  keyring,
  children,
  openPersistence = createPersistence,
  resetLocalData = deleteLocalData,
}: {
  /** The session's client, or null in local-only mode (no server at all). */
  api: ApiClient | null;
  /** The session's device id: the HLC tiebreak, so it must be stable per device. */
  deviceId: string;
  /**
   * The signed-in user's id, or `LOCAL_SCOPE` in local-only mode; scopes the durable op log so
   * accounts never share one on a device.
   */
  userId: string;
  /**
   * The unlocked keyring (an account's store only mounts unlocked), or null in local-only mode. A
   * prop so the attachment queue follows it.
   */
  keyring: Keyring | null;
  children: ReactNode;
  /** Opens the user's local database (injectable for tests). */
  openPersistence?: typeof createPersistence;
  /** Deletes the user's local database, for the load-failure screen (injectable for tests). */
  resetLocalData?: (userId: string) => Promise<void>;
}) {
  const [status, setStatus] = useState<SyncStatus>("idle");
  // `version` bumps on every store change and keys subscribers' derivation memos.
  const [version, bump] = useState(0);
  const [lastError, setLastError] = useState<SyncErrorInfo | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [quarantined, setQuarantined] = useState<QuarantinedOp[]>([]);
  const [e2ee, setE2ee] = useState({ locked: 0, deferred: 0 });
  const [leftDiscarded, setLeftDiscarded] = useState(0);
  const [clockSkewMs, setClockSkewMs] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Why the local database could not be loaded; the screen offers Retry and a reset.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped by Retry: runs the loading effect again.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  // The web database's state across tabs (see `IndexedDbEvents`); null while all is well.
  const [storage, setStorage] = useState<"blocked" | "closed" | null>(null);
  const { t } = useTranslation();
  const [initialSyncDone, setInitialSyncDone] = useState(false);
  // Built asynchronously: the persisted op log is replayed before the UI mounts, so offline edits
  // are present on first paint.
  const [ready, setReady] = useState<{
    store: LocalStore;
    /** Null in local-only mode. */
    sync: SyncClient | null;
    /** The op-log persistence; also owns the attachment upload queue table. */
    persistence: Persistence;
  } | null>(null);
  // Built once the store and an unlocked keyring exist: without keys there is no queue.
  const [attachments, setAttachments] = useState<AttachmentsContextValue | null>(null);
  const [attachmentServer, setAttachmentServer] = useState<AttachmentServerConfig | null>(null);
  // Read by the queue at enqueue time, so it needs no rebuild when the answer arrives.
  const attachmentServerRef = useRef<AttachmentServerConfig | null>(null);
  attachmentServerRef.current = attachmentServer;

  const syncingUntilRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(true);
  /** The attachment queue's drain trigger, so sync-cycle closures need no re-wiring per queue. */
  const drainRef = useRef<(() => void) | null>(null);
  // Read by the long-lived sync effect, so a re-unlock's keyring is the one hydration fills.
  const keyringRef = useRef(keyring);
  keyringRef.current = keyring;
  /** Reload project keys (single-flight); set by the sync effect once the store exists. */
  const hydrateKeysRef = useRef<(() => Promise<void>) | null>(null);
  // The account whose saved list of rejected changes has been read: until then the (empty or
  // partial) list in memory must not overwrite it.
  const quarantineLoadedRef = useRef<string | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    let opened: Persistence | null = null;
    setLoadError(null);
    void (async () => {
      const persistence = await openPersistence(userId, {
        onBlocked: () => {
          if (!cancelled) setStorage("blocked");
        },
        onVersionChange: () => {
          console.warn("[atlas] another tab upgraded the local database; reload this tab");
          if (!cancelled) setStorage("closed");
        },
      });
      opened = persistence;
      const store = new LocalStore(deviceId, {
        persistence,
        newId: randomUUID,
        onPersistError: (err) => {
          console.warn("[atlas] could not write to the local database:", err);
          if (!cancelled) setSaveError(err instanceof Error ? err.message : String(err));
        },
      });
      await store.hydrate();
      if (cancelled) return;
      setStorage((s) => (s === "blocked" ? null : s));

      if (!api) {
        // Local-only: nothing is ever pushed, so superseded history can go now (see `compactLocal`).
        await markLocalDataUsed();
        await store.compactLocal();
        if (cancelled) return;
        const unsubLocal = store.onChange(() => bump((v) => v + 1));
        setReady({ store, sync: null, persistence });
        setInitialSyncDone(true);
        cleanup = () => {
          unsubLocal();
          void store
            .flush()
            .catch(() => {})
            .then(() => persistence.close?.())
            .catch((err) => console.warn("[atlas] could not close the local database:", err));
        };
        return;
      }
      const client = api;

      let savedCursor = await persistence.getCursor();
      if (cancelled) return;

      // One-time migration: databases written by early builds may be partially persisted (an
      // un-flushed write race). Resetting the cursor to 0 once forces a complete, idempotent backfill.
      const migrationKey = migrationKeys(userId).atomicSync;
      try {
        const migrated = await AsyncStorage.getItem(migrationKey);
        if (!migrated) {
          await persistence.setCursor(0);
          await persistence.setBootstrap?.(null);
          savedCursor = 0;
          await AsyncStorage.setItem(migrationKey, "true");
        }
      } catch (err) {
        console.warn("[atlas] migration check failed:", err);
      }

      // One-time E2EE migration: with the project keys loaded, re-download the server's state so
      // values in the old envelope format or in plaintext are re-written in the current one. Marked
      // done only after a successful sync that followed a successful key load; from then on such
      // values are dropped as forgeries (see `ApiClient.setLegacyMigrated`).
      const scopeMigrationKey = migrationKeys(userId).e2ee;
      const scopeWalkKey = migrationKeys(userId).e2eeWalk;
      let scopeMigrationPending = false;
      try {
        if (await AsyncStorage.getItem(scopeMigrationKey)) client.setLegacyMigrated(true);
        else {
          // A full walk from page 1, started once; a later launch continues where it stopped, so a
          // walk longer than one session still ends.
          if (!(await AsyncStorage.getItem(scopeWalkKey))) {
            await persistence.setCursor(0);
            await persistence.setBootstrap?.(null);
            savedCursor = 0;
            await AsyncStorage.setItem(scopeWalkKey, "true");
          }
          scopeMigrationPending = true;
        }
      } catch (err) {
        console.warn("[atlas] e2ee scope migration check failed:", err);
      }
      if (cancelled) return;

      // Project keys live only in memory: reload them before the first sync so shared content
      // decrypts and new edits use the project's key. Sync waits for the first attempt.
      client.setScopeContext(store, userId);
      let keysLoaded = false;
      let keysHydrated = false;
      // Keys loaded before the account's key trust state was known (a fresh device, or an account
      // from before it existed) followed the old, permissive rules; see `settleKeyTrust`.
      let loadedUntrusted = false;
      const freshStore = store.isEmpty();
      let synced = false;
      let hydrating: Promise<void> | null = null;
      const hydrateKeys = (): Promise<void> => {
        if (hydrating) return hydrating;
        hydrating = (async () => {
          const kr = keyringRef.current;
          try {
            if (!kr?.hasKeys()) return;
            const trust = readKeyTrust(store);
            // A fresh device learns the account's trust state from its first sync: until then it
            // loads nothing rather than whatever the server offers.
            if (!trust.initialized && freshStore && !synced) return;
            if (!trust.initialized) loadedUntrusted = true;
            const result = await hydrateProjectKeys(client, kr, {
              isCreator: (projectId) => isProjectCreator(store, projectId, userId),
              trust,
              userId,
              trustWriter: store,
            });
            keysHydrated = true;
            if (result.changed && !cancelled) {
              // Values that arrived before their key: open them in place, repair the misfiled.
              reviveLockedValues(store, kr, userId, !client.isLegacyMigrated());
              setE2ee({ locked: store.lockedCount(), deferred: sync.deferredCount() });
              if (keysLoaded) runSync();
            }
          } catch (err) {
            console.warn("[atlas-e2ee] could not load project keys:", err);
          } finally {
            keysLoaded = true;
          }
        })().finally(() => {
          hydrating = null;
        });
        return hydrating;
      };
      hydrateKeysRef.current = hydrateKeys;

      /**
       * After a successful sync, when the synced key trust state has had its chance to arrive: an
       * account without one records its baseline from the keys it uses now (once, at the upgrade);
       * keys loaded before the state was known are reloaded under it.
       */
      const settleKeyTrust = async () => {
        synced = true;
        const kr = keyringRef.current;
        if (!kr?.hasKeys()) return;
        if (!keysHydrated) await hydrateKeys();
        if (!keysHydrated) return;
        if (!readKeyTrust(store).initialized) {
          recordKeyTrustBaseline(store, kr, userId);
          loadedUntrusted = false;
        } else if (loadedUntrusted) {
          loadedUntrusted = false;
          kr.clearProjectKeys();
          await hydrateKeys();
        }
        // Shares joined before invites were recorded take their owner's key from now on.
        if (recordLegacySharesAccepted(store, userId)) await hydrateKeys();
      };

      let pollDelay = 0;
      let reschedulePoll: (() => void) | null = null;
      const handleStatus = (s: SyncStatus) => {
        // The socket dropped: back to the short poll now, not after the long wait.
        if (s !== "live-ws" && pollDelay === LIVE_SYNC_INTERVAL_MS) reschedulePoll?.();
        if (Date.now() < syncingUntilRef.current) {
          return;
        }
        setStatus(s);
      };

      // An unfinished snapshot walk continues at its next page rather than page 1; one that ended
      // just before the app did still has its repairs to write.
      const bootstrap = (await persistence.getBootstrap?.()) ?? null;
      if (cancelled) return;

      const sync = new SyncClient(store, client, {
        cursor: Number.isFinite(savedCursor) ? savedCursor : 0,
        bootstrap,
        onBootstrapProgress: (progress, page) => {
          persistence.setBootstrap?.(progress, page).catch((err) => {
            console.warn("[atlas sync] could not persist the bootstrap progress:", err);
          });
        },
        onCursor: (c) => {
          // A failed write only means the next launch pulls a little more; never an uncaught
          // rejection, which would be filed as a crash.
          persistence.setCursor(c).catch((err) => {
            console.warn("[atlas sync] could not persist the cursor:", err);
          });
        },
        onStatus: handleStatus,
        // Every completed cycle, including those the client runs by itself.
        onSynced: () => {
          if (cancelled) return;
          setLastSyncAt(Date.now());
          setLastError(null);
          // Changes queued for a project this account has since left (on any device) can never be
          // sent: the server takes no writes from a non-member. Drop them, and sync again so the
          // counts below stop including them.
          const dropped = revokedProjectOps(store, userId);
          if (dropped.length > 0) {
            store.discard(dropped.map((op) => op.id));
            setLeftDiscarded((n) => n + dropped.length);
            console.info(
              `[atlas sync] dropped ${dropped.length} queued change(s) to projects this account left`,
            );
            runSync();
          }
          setE2ee({ locked: store.lockedCount(), deferred: sync.deferredCount() });
          setClockSkewMs(sync.clockSkewMs());
          if (store.unsavedCount() === 0) setSaveError(null);
        },
        onError: (err) => {
          console.warn("[atlas sync] background sync failed:", err);
          setLastError(toErrorInfo(err));
        },
        onQuarantine: (op: Operation, err) => {
          console.warn("[atlas sync] op quarantined (server rejected it permanently):", op.id, err);
          const info = toErrorInfo(err);
          setQuarantined((prev) =>
            mergeQuarantined(
              [
                {
                  opId: op.id,
                  entityKind: op.entity,
                  entityId: op.entityId,
                  status: info.status,
                  message: info.message,
                  at: info.at,
                },
              ],
              prev,
            ),
          );
        },
        // The server pushes pull-shaped payloads over `/sync/ws`. The poll below remains the
        // fallback: the hub can drop messages for a lagging device.
        realtime: {
          url: (since) => client.syncWsUrl(since),
        },
        // Joining, accepting or a role change on a project can bring new keys.
        onRemoteApplied: (ops) => {
          const mine = ops.some(
            (o) =>
              (o.entity === "project_member" &&
                store.get("project_member", o.entityId)?.user_id === userId) ||
              // Another device accepted an invite or minted a key.
              (o.entity === "preference" && o.entityId === KEY_TRUST_ID),
          );
          if (mine) void hydrateKeys();
        },
      });

      const unsub = store.onChange(() => bump((v) => v + 1));
      setReady({ store, sync, persistence });

      // If the initial sync cannot complete within 4s (offline), proceed with local state.
      let fallbackTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        if (!cancelled) {
          setInitialSyncDone(true);
        }
      }, 4000);

      const runSync = () => {
        if (!keysLoaded) return;
        const migrating = scopeMigrationPending && keysHydrated;
        return void sync
          .sync()
          .then((res) => {
            // Held back by the rate limit (or halted): nothing happened. `onSynced` recorded the rest.
            if (res.skipped) return;
            if (migrating && scopeMigrationPending) {
              scopeMigrationPending = false;
              client.setLegacyMigrated(true);
              recordLegacyMigrated(store);
              void AsyncStorage.setItem(scopeMigrationKey, "true")
                .then(() => AsyncStorage.removeItem(scopeWalkKey))
                .catch((err) => console.warn("[atlas] could not record the e2ee migration:", err));
            }
            void settleKeyTrust().catch((err) =>
              console.warn("[atlas-e2ee] could not settle the key trust state:", err),
            );
            // The queue single-flights, so an over-eager trigger costs nothing.
            drainRef.current?.();
          })
          .catch((err) => {
            console.warn("[atlas sync] runSync failed:", err);
          })
          .finally(() => {
            if (fallbackTimer) {
              clearTimeout(fallbackTimer);
              fallbackTimer = undefined;
            }
            if (!cancelled) {
              setInitialSyncDone(true);
            }
          });
      };
      void hydrateKeys().then(runSync);
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      const schedulePoll = () => {
        if (cancelled) return;
        pollDelay =
          sync.isRealtimeLive() && !sync.hasPendingPush()
            ? LIVE_SYNC_INTERVAL_MS
            : SYNC_INTERVAL_MS;
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(() => {
          runSync();
          schedulePoll();
        }, pollDelay);
      };
      reschedulePoll = schedulePoll;
      schedulePoll();
      // A local write during the long wait goes out on the short poll (most writes also kick).
      const unsubPoll = store.onChange(() => {
        if (pollDelay === LIVE_SYNC_INTERVAL_MS && sync.hasPendingPush()) schedulePoll();
      });
      const appState = AppState.addEventListener("change", (next) => {
        if (next === "active") void hydrateKeys().then(runSync);
      });
      cleanup = () => {
        hydrateKeysRef.current = null;
        client.setScopeContext(null);
        if (fallbackTimer) clearTimeout(fallbackTimer);
        if (pollTimer) clearTimeout(pollTimer);
        reschedulePoll = null;
        unsubPoll();
        // Close the realtime socket and cancel its pending reconnects with the session's timers.
        sync.dispose();
        unsub();
        appState.remove();
        // Let queued writes land, then release the connection: a remount opens a new one, and two
        // live connections would write the same database without serializing against each other.
        void store
          .flush()
          .catch(() => {})
          .then(() => persistence.close?.())
          .catch((err) => console.warn("[atlas] could not close the local database:", err));
      };
    })().then(
      () => {
        // Unmounted while loading: nothing else will close what was opened.
        if (cancelled && !cleanup) void opened?.close?.().catch(() => {});
      },
      (err: unknown) => {
        // A corrupt or unreadable database, a disk error, or a database a newer build upgraded:
        // without this the app would wait on the skeleton forever.
        console.warn("[atlas] could not load the local database:", err);
        void opened?.close?.().catch(() => {});
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [deviceId, userId, api, openPersistence, loadAttempt]);

  // The rejected changes an earlier run listed. Merged, not replaced: a cycle may already have
  // rejected more by the time the read returns. Local-only mode never pushes, so has none.
  const hasServer = api !== null;
  useEffect(() => {
    quarantineLoadedRef.current = null;
    setQuarantined([]);
    if (!hasServer) return;
    let cancelled = false;
    void loadQuarantined(userId).then((saved) => {
      if (cancelled) return;
      quarantineLoadedRef.current = userId;
      setQuarantined((prev) => mergeQuarantined(prev, saved));
    });
    return () => {
      cancelled = true;
    };
  }, [userId, hasServer]);

  useEffect(() => {
    if (quarantineLoadedRef.current === userId) void saveQuarantined(userId, quarantined);
  }, [quarantined, userId]);

  const dismissQuarantined = useCallback((opId?: string) => {
    setQuarantined((prev) => (opId === undefined ? [] : prev.filter((q) => q.opId !== opId)));
  }, []);

  // A re-unlocked session brings a fresh keyring with no project keys in it.
  useEffect(() => {
    void hydrateKeysRef.current?.();
  }, [keyring]);

  // Rebuilt with the keyring. The queue's rows are durable in the op-log database, so a fresh
  // instance over the same persistence resumes where the last one left off.
  useEffect(() => {
    if (!ready || !api || !keyring?.hasKeys()) {
      setAttachments(null);
      return;
    }
    const queue = new AttachmentQueue({
      transport: {
        put: (sha, body) => api.putBlob(sha, body),
        get: (sha) => api.streamBlob(sha),
      },
      persistence: {
        // The `AttachmentQueueStore` slice; the guards satisfy the optional-port shape.
        listAttachmentQueue: () => ready.persistence.listAttachmentQueue?.() ?? Promise.resolve([]),
        loadAttachmentCiphertext: (id) =>
          ready.persistence.loadAttachmentCiphertext?.(id) ?? Promise.resolve(null),
        putAttachmentUpload: (u) => ready.persistence.putAttachmentUpload?.(u) ?? Promise.resolve(),
        updateAttachmentUpload: (u) =>
          ready.persistence.updateAttachmentUpload?.(u) ?? Promise.resolve(),
        deleteAttachmentUpload: (id) =>
          ready.persistence.deleteAttachmentUpload?.(id) ?? Promise.resolve(),
      },
      keyring,
      store: ready.store,
      newId: () => ready.store.newEntityId(),
      maxBlobBytes: () => attachmentServerRef.current?.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES,
      ciphertextAsBlob: CIPHERTEXT_AS_BLOB,
      // One drain per database across rebuilds and tabs: two would upload and publish an entry twice.
      lockKey: ready.persistence,
      lockName: `atlas-attachment-queue:${userId}`,
    });
    setAttachments({ queue, removeUpload: (id) => queue.remove(id) });
  }, [ready, keyring, api, userId]);

  // Decrypted files a previous run handed to the share sheet are no longer in use.
  useEffect(() => {
    if (ready) clearSharedFiles();
  }, [ready]);

  // Ask the server whether it stores attachments (and how large), once it is reachable.
  const online = status === "idle" || status === "live-ws";
  useEffect(() => {
    if (!ready || !api || !online || attachmentServer) return;
    let cancelled = false;
    api
      .getAttachmentConfig()
      .then((config) => {
        if (!cancelled) setAttachmentServer(config);
      })
      .catch(() => {
        // Unknown: attachments stay available and the next reconnect asks again.
      });
    return () => {
      cancelled = true;
    };
  }, [ready, online, api, attachmentServer]);

  const attachmentsValue = useMemo(
    () => (attachments ? { ...attachments, server: attachmentServer } : null),
    [attachments, attachmentServer],
  );

  useEffect(() => {
    drainRef.current = attachments
      ? () => {
          void attachments.queue.drain().catch((err) => {
            console.warn("[atlas attachments] drain failed:", err);
          });
        }
      : null;
  }, [attachments]);

  const drainAfterSync = useCallback(() => {
    drainRef.current?.();
  }, []);

  const kick = useCallback(async () => {
    if (!ready?.sync) return;
    const sync = ready.sync;
    syncingUntilRef.current = Date.now() + 500;
    setStatus("syncing");

    const timerPromise = new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const res = await sync.sync();
      if (res.skipped) return;
      if (isMountedRef.current) setInitialSyncDone(true);
      drainAfterSync();
    } catch (err) {
      console.warn("[atlas sync] kick() sync failed:", err);
    } finally {
      await timerPromise;
      if (isMountedRef.current && Date.now() >= syncingUntilRef.current) {
        setStatus(sync.currentStatus());
      }
    }
  }, [ready, drainAfterSync]);

  const resync = useCallback(async () => {
    if (!ready?.sync) return;
    // Failures propagate: the one caller (Sync details) tells the user what happened.
    const res = await ready.sync.resetAndBootstrap();
    if (res.skipped) return "postponed" as const;
  }, [ready]);

  // Drain when the server becomes reachable again.
  useEffect(() => {
    if (status === "idle" || status === "live-ws") drainRef.current?.();
  }, [status]);

  // A relaunch must resume uploads the previous process left queued, even if the status never changes.
  useEffect(() => {
    if (initialSyncDone) drainRef.current?.();
  }, [initialSyncDone]);

  const value = useMemo<StoreContextValue | null>(
    () =>
      ready
        ? {
            store: ready.store,
            status,
            version,
            kick,
            resync,
            diagnostics: {
              lastError,
              lastSyncAt,
              quarantined,
              pending: ready.store.unsyncedOps().length,
              locked: e2ee.locked,
              deferred: e2ee.deferred,
              leftDiscarded,
              clockSkewMs,
              storage: storage === "closed" ? "closed" : null,
              saveError,
            },
            dismissQuarantined,
            initialSyncDone,
            attachments: attachmentsValue,
            localOnly: ready.sync === null,
          }
        : null,
    [
      ready,
      status,
      version,
      kick,
      resync,
      lastError,
      lastSyncAt,
      quarantined,
      dismissQuarantined,
      initialSyncDone,
      attachmentsValue,
      e2ee,
      leftDiscarded,
      clockSkewMs,
      storage,
      saveError,
    ],
  );

  // The skeleton is delay-gated so a warm cache shows nothing instead of a placeholder flash.
  if (!value && loadError !== null)
    return (
      <View className="flex-1 items-center justify-center gap-3 p-6">
        <Text
          accessibilityRole="header"
          className="text-center text-base font-semibold text-neutral-900 dark:text-neutral-100"
        >
          {t("sync.loadFailed")}
        </Text>
        <Text className="text-center text-sm text-neutral-600 dark:text-neutral-300">
          {loadError}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => setLoadAttempt((n) => n + 1)}
          className="rounded-md bg-accent-600 px-4 py-2 active:bg-accent-500 web:cursor-pointer"
        >
          <Text className="text-sm font-medium text-white">{t("common.retry")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => setConfirmReset(true)}
          className="px-4 py-2 web:cursor-pointer"
        >
          <Text className="text-sm text-red-600 dark:text-red-400">{t("sync.resetLocalData")}</Text>
        </Pressable>
        <ConfirmDialog
          visible={confirmReset}
          danger
          title={t("sync.resetLocalDataTitle")}
          message={t("sync.resetLocalDataBody")}
          confirmLabel={t("sync.resetLocalData")}
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => {
            setConfirmReset(false);
            void resetLocalData(userId)
              .catch((err) => console.warn("[atlas] could not reset the local data:", err))
              .finally(() => setLoadAttempt((n) => n + 1));
          }}
        />
      </View>
    );
  if (!value && storage === "blocked")
    return (
      <View className="flex-1 items-center justify-center p-6">
        <Text className="text-center text-sm text-neutral-600 dark:text-neutral-300">
          {t("sync.storageBlocked")}
        </Text>
      </View>
    );
  if (!value)
    return (
      <SkeletonGate active>
        <AppSkeleton />
      </SkeletonGate>
    );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within a StoreProvider");
  return ctx;
}

export function useStoreOptional(): StoreContextValue | null {
  return useContext(StoreContext);
}
