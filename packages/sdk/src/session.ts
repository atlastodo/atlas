import {
  ApiClient,
  Keyring,
  LocalStore,
  SyncClient,
  deriveApiTokenKeys,
  hydrateProjectKeys,
  isProjectCreator,
  parseApiToken,
  readKeyTrust,
  reviveLockedValues,
  trimTrailing,
  unwrapApiTokenKeys,
  unwrapSigningKey,
  type FetchLike,
} from "@atlastodo/client-core";

/**
 * An API-token session of the account's own key, the building block of a headless client: it
 * opens a session with a personal API token (`atlas_pat_…`), unwraps the keys the token carries,
 * pulls the account into memory (decrypting it on this machine: the server only ever sees
 * ciphertext) and loads the shared projects' keys. The app's own rules sit on top: register the
 * app's definition (`registerApp`) before connecting, then read and write through `store` and call
 * {@link TokenSession.push} after each write.
 */

export interface ConnectOptions {
  /** The Atlas server, e.g. `https://app.atlastodo.dev` (an `/api` suffix is fine too). */
  serverUrl: string;
  /** An `atlas_pat_…` token from Settings → API tokens. */
  token: string;
  fetch?: FetchLike;
  /** IANA zone for due dates and recurrence; the runtime's by default. */
  timeZone?: string;
}

export class AtlasError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AtlasError";
  }
}

export class TokenSession {
  private constructor(
    readonly api: ApiClient,
    readonly store: LocalStore,
    readonly sync: SyncClient,
    readonly keyring: Keyring,
    readonly userId: string,
  ) {}

  static async connect(opts: ConnectOptions): Promise<TokenSession> {
    const parts = parseApiToken(opts.token);
    const { auth } = deriveApiTokenKeys(parts);
    const baseUrl = trimTrailing(opts.serverUrl, "/");
    const api: ApiClient = new ApiClient({
      baseUrl,
      fetch: opts.fetch,
      // Token sessions have no refresh token: an expired one is opened again.
      reauthenticate: async () => (await api.openApiTokenSession(parts.id, auth)).access_token,
    });
    const session = await api.openApiTokenSession(parts.id, auth);
    api.setTokens(session.access_token);

    const { dek, privateKey } = unwrapApiTokenKeys(parts, session.user_id, session);
    const keyring = new Keyring({ dek, privateKey, publicKey: session.public_key });
    if (session.encrypted_signing_key && session.signing_public_key) {
      try {
        keyring.setSigningKey(
          unwrapSigningKey(session.encrypted_signing_key, dek, session.signing_public_key),
        );
      } catch {
        // Only needed to rotate or deliver project keys, which a token session never does.
      }
    }
    api.setKeyring(keyring);

    // The token id is this client's device: its HLC node and its session's device id.
    const store = new LocalStore(parts.id, { newId: () => globalThis.crypto.randomUUID() });
    api.setScopeContext(store, session.user_id);
    const sync = new SyncClient(store, api, { cursor: 0 });
    const s = new TokenSession(api, store, sync, keyring, session.user_id);
    await s.initialSync();
    return s;
  }

  /** Pull everything, then load the shared projects' keys under the synced trust state. */
  private async initialSync(): Promise<void> {
    await this.syncOrThrow();
    const result = await hydrateProjectKeys(this.api, this.keyring, {
      isCreator: (projectId) => isProjectCreator(this.store, projectId, this.userId),
      trust: readKeyTrust(this.store),
      userId: this.userId,
      trustWriter: this.store,
    });
    if (result.changed) {
      reviveLockedValues(this.store, this.keyring, this.userId, !this.api.isLegacyMigrated());
      await this.syncOrThrow();
    }
  }

  async syncOrThrow(): Promise<void> {
    const result = await this.sync.sync();
    if (result.skipped) {
      throw new AtlasError("sync_skipped", `sync did not run (${result.skipped}); try again later`);
    }
  }

  /** Push pending writes; throws when any did not reach the server. */
  async push(): Promise<void> {
    await this.syncOrThrow();
    const pending = this.store.unsyncedOps().length;
    if (pending > 0) {
      throw new AtlasError(
        "not_pushed",
        `${pending} change(s) did not reach the server (a shared project whose key is missing?)`,
      );
    }
  }

  /** The server cursor this session has pulled up to. */
  cursor(): number {
    return this.sync.currentCursor();
  }

  /** Stop background timers. Every write has already been pushed. */
  close(): void {
    this.sync.dispose();
  }
}
