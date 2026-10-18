import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import {
  ApiError,
  generatePek,
  hydrateProjectKeys,
  isProjectCreator,
  performKeyRotations,
  pinMemberKey,
  pinnedMemberKey,
  projectKeyId,
  readKeyTrust,
  recordFirstKeyMembers,
  recordMintedKey,
  reviveLockedValues,
  sealDelivery,
  wrapProjectKey,
  type ApiClient,
  type KeyTrust,
  type Keyring,
  type LocalStore,
  type RotationTransport,
} from "@atlastodo/client-core";
import { useAuth } from "../auth/AuthContext";
import { useStore } from "../data/StoreProvider";

/**
 * Owner-side key upkeep: first the rotations the server asks for (see `performKeyRotations`), then
 * delivery of project keys an earlier share could not deliver (failed seal, member without a public
 * key yet, a share made on another device, a rotated key, an unsigned legacy delivery). The server
 * lists the members of owned projects lacking the canonical key or a retired key the caller holds.
 *
 * The server's list and public keys prove nothing, so a key is sealed only to a member whose
 * public key matches the one pinned at invite time (see `pinMemberKey`); anyone else is skipped, and
 * a pinned member whose key changed is reported instead of served. Every delivery is signed with
 * the account's identity key; without it nothing is sent.
 *
 * A project shared before project keys existed gets its first key here
 * ({@link mintFirstSharedKeys}); its members are recorded with the key and pinned on first delivery.
 */

const MAINTENANCE_INTERVAL_MS = 10 * 60_000;

export type MaintenanceTransport = Pick<
  ApiClient,
  "listMissingProjectKeys" | "putMemberProjectKey" | "putProjectKey"
>;

export interface MaintenanceResult {
  sealed: number;
  /** Rows skipped: no public key yet, a key this device does not hold, or a member never pinned. */
  skipped: number;
  failed: number;
  /** Members whose public key differs from the one pinned at invite time: not delivered to. */
  keyChanged: { projectId: string; userId: string }[];
}

const changedKeys = new Set<string>();
const changedListeners = new Set<() => void>();

/** `${projectId}:${userId}` of every member whose public key no longer matches its pin. */
export function memberKeyChanges(): ReadonlySet<string> {
  return changedKeys;
}

/** Be told when {@link memberKeyChanges} changes. Returns the unsubscribe. */
export function onMemberKeyChanges(listener: () => void): () => void {
  changedListeners.add(listener);
  return () => {
    changedListeners.delete(listener);
  };
}

function reportKeyChange(projectId: string, userId: string): void {
  const id = `${projectId}:${userId}`;
  if (changedKeys.has(id)) return;
  changedKeys.add(id);
  for (const listener of changedListeners) listener();
}

/**
 * Give every owned, shared project without a key its first one, stored on the server before this
 * device uses it. The server accepts a key for a shared project only while nobody holds one, so a
 * device that failed to load the key gets a 409 and skips rather than splitting the members. Other
 * members are recorded for pinning on first delivery. Returns the projects that got a key.
 */
export async function mintFirstSharedKeys(
  api: Pick<ApiClient, "putProjectKey">,
  keyring: Keyring,
  store: LocalStore,
  userId: string,
): Promise<string[]> {
  const trust = readKeyTrust(store);
  const members = store.list("project_member");
  const owned = new Set<string>();
  for (const e of members) {
    if (e.fields.user_id !== userId || e.fields.role !== "owner" || e.fields.state !== "active") {
      continue;
    }
    if (typeof e.fields.project_id === "string") owned.add(e.fields.project_id);
  }
  const minted: string[] = [];
  for (const projectId of owned) {
    if (keyring.getProjectKey(projectId) || trust.minted.has(projectId)) continue;
    const pek = generatePek();
    const keyId = projectKeyId(pek);
    try {
      await api.putProjectKey(projectId, wrapProjectKey(pek, keyring.getDek(), projectId), keyId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        console.warn(`[atlas-e2ee] ${projectId} already has a key this device cannot load`);
      } else {
        console.warn(`[atlas-e2ee] could not store a first key for ${projectId}:`, err);
      }
      continue;
    }
    const others = members
      .filter(
        (e) =>
          e.fields.project_id === projectId &&
          e.fields.user_id !== userId &&
          (e.fields.state === "active" || e.fields.state === "pending") &&
          typeof e.fields.user_id === "string",
      )
      .map((e) => e.fields.user_id as string);
    recordFirstKeyMembers(store, projectId, others);
    recordMintedKey(store, projectId, keyId);
    keyring.setProjectKey(projectId, pek);
    minted.push(projectId);
  }
  return minted;
}

/**
 * Seal every missing member key this device can deliver to a pinned member. A member recorded with
 * a project's first key (see {@link mintFirstSharedKeys}) and not pinned yet is pinned to the
 * public key listed now, through `pin`. Per-row failures are logged and skipped.
 */
export async function sealMissingProjectKeys(
  api: MaintenanceTransport,
  keyring: Keyring,
  trust: KeyTrust,
  pin?: (projectId: string, userId: string, publicKey: string) => void,
): Promise<MaintenanceResult> {
  const result: MaintenanceResult = { sealed: 0, skipped: 0, failed: 0, keyChanged: [] };
  const signingKey = keyring.getSigningKey();
  if (!signingKey) return result;
  for (const row of await api.listMissingProjectKeys()) {
    const key = keyring.projectKeys(row.project_id).find((k) => k.keyId === row.key_id)?.key;
    let pinned = pinnedMemberKey(trust, row.project_id, row.user_id);
    if (
      !pinned &&
      pin &&
      row.public_key &&
      key &&
      trust.firstKeyMembers.get(row.project_id)?.has(row.user_id)
    ) {
      pin(row.project_id, row.user_id, row.public_key);
      pinned = row.public_key;
    }
    if (!row.public_key || !key || !pinned) {
      result.skipped++;
      continue;
    }
    if (pinned !== row.public_key) {
      result.keyChanged.push({ projectId: row.project_id, userId: row.user_id });
      reportKeyChange(row.project_id, row.user_id);
      console.warn(
        `[atlas-e2ee] not delivering ${row.project_id} to ${row.user_id}: public key changed since the invite`,
      );
      continue;
    }
    try {
      const { sealed, signature } = sealDelivery(key, {
        projectId: row.project_id,
        recipientId: row.user_id,
        recipientPublicKey: row.public_key,
        keyId: row.key_id,
        signingKey,
      });
      await api.putMemberProjectKey(row.project_id, row.user_id, sealed, row.key_id, signature);
      result.sealed++;
    } catch (err) {
      result.failed++;
      console.warn(
        `[atlas-e2ee] could not deliver key ${row.key_id} of ${row.project_id} to ${row.user_id}:`,
        err,
      );
    }
  }
  return result;
}

/**
 * First keys ({@link mintFirstSharedKeys}), pending rotations, then missing deliveries. A first key
 * releases held-back changes and a rotation changes the write key, so the caller should sync once
 * either happened.
 */
async function maintainProjectKeys(
  api: MaintenanceTransport & RotationTransport & Partial<Pick<ApiClient, "isLegacyMigrated">>,
  keyring: Keyring,
  store: LocalStore,
  userId: string,
): Promise<{ minted: string[]; rotated: string[]; delivered: MaintenanceResult }> {
  const minted = await mintFirstSharedKeys(api, keyring, store, userId);
  if (minted.length > 0) {
    reviveLockedValues(store, keyring, userId, !(api.isLegacyMigrated?.() ?? false));
  }
  let rotated: string[] = [];
  try {
    ({ rotated } = await performKeyRotations(api, keyring, store, userId));
  } catch (err) {
    console.warn("[atlas-e2ee] could not check for key rotations:", err);
  }
  const delivered = await sealMissingProjectKeys(
    api,
    keyring,
    readKeyTrust(store),
    (projectId, memberId, key) => pinMemberKey(store, projectId, memberId, key),
  );
  return { minted, rotated, delivered };
}

/** Whether `userId` owns any shared project: only owners can deliver keys. */
function ownsSharedProject(store: LocalStore, userId: string): boolean {
  return store
    .list("project_member")
    .some(
      (e) =>
        e.fields.user_id === userId && e.fields.role === "owner" && e.fields.state === "active",
    );
}

const runners = new Set<() => void>();

/** Ask the mounted maintenance to run now (e.g. when the share dialog opens). */
export function requestProjectKeyMaintenance(): void {
  for (const run of runners) run();
}

/**
 * Reload project keys outside the store's own reload (share dialog, accepting an invite). The store
 * opens early-arrived values only when its own reload changes something, so this opens them itself.
 * Returns whether anything changed; the caller syncs to push the repairs.
 */
export async function loadProjectKeys(
  api: Parameters<typeof hydrateProjectKeys>[0] & Partial<Pick<ApiClient, "isLegacyMigrated">>,
  keyring: Keyring,
  store: LocalStore,
  userId: string | undefined,
): Promise<boolean> {
  const { changed } = await hydrateProjectKeys(api, keyring, {
    isCreator: (projectId) => (userId ? isProjectCreator(store, projectId, userId) : false),
    trust: readKeyTrust(store),
    userId,
    trustWriter: store,
  });
  if (changed) {
    reviveLockedValues(store, keyring, userId, !(api.isLegacyMigrated?.() ?? false));
    requestProjectKeyMaintenance();
  }
  return changed;
}

/** The memberships in the store, as one comparable string. */
function membershipSignature(store: LocalStore): string {
  return store
    .list("project_member")
    .map((e) => `${e.fields.project_id}:${e.fields.user_id}:${e.fields.state}:${e.fields.role}`)
    .sort()
    .join(",");
}

/**
 * Keep up the signed-in owner's project keys ({@link maintainProjectKeys}): after the first sync,
 * after the sync following a foreground return, re-unlock or membership change, every
 * {@link MAINTENANCE_INTERVAL_MS}, and on {@link requestProjectKeyMaintenance}. Runs never overlap.
 * Mount once, inside `StoreProvider`.
 */
export function useProjectKeyMaintenance(): void {
  const { api, keyring, session } = useAuth();
  const { store, initialSyncDone, diagnostics, kick } = useStore();
  const userId = session?.user.id;

  const latest = useRef({ api, keyring, store, userId, kick });
  useEffect(() => {
    latest.current = { api, keyring, store, userId, kick };
  });

  const inFlight = useRef<Promise<void> | null>(null);
  const run = useCallback(() => {
    if (inFlight.current) return;
    const { api: client, keyring: kr, store: s, userId: me, kick: sync } = latest.current;
    if (!kr?.hasKeys() || !me || !ownsSharedProject(s, me)) return;
    inFlight.current = maintainProjectKeys(client, kr, s, me)
      .then(({ minted, rotated }) => {
        // Changes held back for want of a key go out once a first key exists, and a rotation
        // changes the key the project writes with.
        if (minted.length > 0 || rotated.length > 0) sync();
      })
      .catch((err) => console.warn("[atlas-e2ee] project key maintenance failed:", err))
      .finally(() => {
        inFlight.current = null;
      });
  }, []);

  useEffect(() => {
    if (initialSyncDone) run();
  }, [initialSyncDone, run]);

  // Armed by a foreground return or a new keyring, fired by the next completed sync.
  const armed = useRef(false);
  const firstKeyring = useRef(keyring);
  useEffect(() => {
    if (keyring !== firstKeyring.current) armed.current = true;
  }, [keyring]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") armed.current = true;
    });
    return () => sub.remove();
  }, []);
  const memberships = useRef<string | null>(null);
  useEffect(() => {
    const signature = membershipSignature(latest.current.store);
    if (memberships.current !== null && memberships.current !== signature) armed.current = true;
    memberships.current = signature;
    if (!armed.current) return;
    armed.current = false;
    run();
  }, [diagnostics.lastSyncAt, run]);

  useEffect(() => {
    const id = setInterval(run, MAINTENANCE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [run]);

  useEffect(() => {
    runners.add(run);
    return () => {
      runners.delete(run);
    };
  }, [run]);
}

/** {@link useProjectKeyMaintenance} as a mountable component, for the root layout. */
export function ProjectKeyMaintenance(): null {
  useProjectKeyMaintenance();
  return null;
}
