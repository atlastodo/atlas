import {
  ApiClient,
  Keyring,
  LocalStore,
  SyncClient,
  assertServerCompatible,
  deriveApiTokenKeys,
  getPublicKey,
  parseApiToken,
  unwrapApiTokenAppKeys,
  type FetchLike,
} from "@atlastodo/client-core";
import {
  VAULT_ITEM_TYPES,
  VaultError,
  newVaultItemFields,
  resolveVaultItem,
  summarizeVaultItem,
  toVaultItem,
  vaultItemChanges,
  vaultItemField,
  type VaultItem,
  type VaultItemInput,
  type VaultItemPatch,
  type VaultItemSummary,
} from "@atlastodo/shared";
import { AtlasError } from "./client";

/**
 * A headless Atlas Vault client for integrations and CI, signed in with an API token that includes
 * the vault (`apps: ["vault"]`). Like `AtlasClient` for todo, `connect` unwraps the vault key the
 * token carries and pulls the vault into memory, decrypting it here: the server only ever sees
 * ciphertext, and reads none of an item's fields. Every sync request names the vault
 * (`x-atlas-sync-apps`). The item rules are `@atlastodo/shared`'s, at parity with the `atlas`
 * CLI's (the shared vault item test vectors).
 *
 * A vault token is read-only unless it was made with write access, and always expires; a write on
 * a read-only token fails with `api_token_read_only` before anything is written, and an expired
 * token fails to connect with the server's `api_token_expired`.
 */

export const VAULT_APP = "vault";

export interface VaultConnectOptions {
  /** The Atlas server, e.g. `https://app.atlastodo.dev` (an `/api` suffix is fine too). */
  serverUrl: string;
  /** An `atlas_pat_…` token that includes Atlas Vault. */
  token: string;
  fetch?: FetchLike;
  /** Check `GET /discovery` first (default true): a server without the vault fails clearly. */
  checkServer?: boolean;
}

export interface VaultFolder {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface VaultQuery {
  /** A folder id or name (case-insensitive). */
  folder?: string;
  /** An item type. */
  type?: string;
  /** A tag, case-insensitive. */
  tag?: string;
  /** Case-insensitive substring of the name, a URL or a tag. */
  search?: string;
}

/** An item with its folder's name. */
export type VaultItemView = VaultItem & { folder_name: string | null };
/** A listed item with its folder's name: no secret values. */
export type VaultItemSummaryView = VaultItemSummary & { folder_name: string | null };

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** By lower-cased name, then id, as the CLI orders them. */
function byNameThenId(a: { name: string; id: string }, b: { name: string; id: string }): number {
  const [an, bn] = [a.name.toLowerCase(), b.name.toLowerCase()];
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A rule's {@link VaultError} as the SDK's {@link AtlasError}, with the same code. */
function rules<T>(run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof VaultError) throw new AtlasError(e.code, e.message);
    throw e;
  }
}

export class VaultClient {
  private constructor(
    private readonly store: LocalStore,
    private readonly sync: SyncClient,
    readonly userId: string,
    /** Whether the token may write. */
    readonly canWrite: boolean,
    /** When the token expires (unix ms), if the server said. */
    readonly expiresAt: number | null,
  ) {}

  static async connect(opts: VaultConnectOptions): Promise<VaultClient> {
    const parts = parseApiToken(opts.token);
    const { auth } = deriveApiTokenKeys(parts);
    const api: ApiClient = new ApiClient({
      baseUrl: opts.serverUrl.replace(/\/+$/, ""),
      fetch: opts.fetch,
      apps: [VAULT_APP],
      // Token sessions have no refresh token: an expired one is opened again.
      reauthenticate: async () => (await api.openApiTokenSession(parts.id, auth)).access_token,
    });
    if (opts.checkServer ?? true) {
      assertServerCompatible(await api.getDiscovery(), {
        minProtocol: 6,
        capabilities: ["api_tokens", "app_scoped_sync", "app_scoped_api_tokens"],
        apps: [VAULT_APP],
      });
    }
    const session = await api.openApiTokenSession(parts.id, auth);
    const apps = session.apps ?? ["todo"];
    const wraps = session.app_keys?.[VAULT_APP];
    if (!apps.includes(VAULT_APP) || !wraps) {
      throw new AtlasError(
        "app_not_in_token",
        `this API token is not for Atlas Vault (it is for ${apps.join(", ")}); make a token that includes it`,
      );
    }
    api.setTokens(session.access_token);
    // The vault key plays the DEK's part for the vault's data: personal-scope field envelopes
    // under it. No shared projects, project keys or values from before field envelopes.
    const { appKey, privateKey } = unwrapApiTokenAppKeys(parts, session.user_id, VAULT_APP, wraps);
    api.setKeyring(new Keyring({ dek: appKey, privateKey, publicKey: getPublicKey(privateKey) }));
    api.setLegacyMigrated(true);
    // The token id is this client's device: its HLC node and its session's device id.
    const store = new LocalStore(parts.id, { newId: () => globalThis.crypto.randomUUID() });
    api.setScopeContext(store, session.user_id);
    const sync = new SyncClient(store, api, { cursor: 0 });
    const client = new VaultClient(
      store,
      sync,
      session.user_id,
      session.write ?? true,
      session.expires_at ?? null,
    );
    await client.syncOrThrow();
    return client;
  }

  private async syncOrThrow(): Promise<void> {
    const result = await this.sync.sync();
    if (result.skipped) {
      throw new AtlasError("sync_skipped", `sync did not run (${result.skipped}); try again later`);
    }
  }

  private async push(): Promise<void> {
    await this.syncOrThrow();
    const pending = this.store.unsyncedOps().length;
    if (pending > 0) {
      throw new AtlasError("not_pushed", `${pending} change(s) did not reach the server`);
    }
  }

  private requireWrite(): void {
    if (!this.canWrite) {
      throw new AtlasError(
        "api_token_read_only",
        "this API token is read-only: changing Atlas Vault data needs a token made with write access",
      );
    }
  }

  private allItems(): VaultItem[] {
    return this.store.list("vault.item").map((e) => toVaultItem(e.id, e.fields));
  }

  private folderName(id: string | null): string | null {
    const f = id ? this.store.get("vault.folder", id) : null;
    return f && typeof f.name === "string" ? f.name : null;
  }

  private view(item: VaultItem): VaultItemView {
    return { ...item, folder_name: this.folderName(item.folder) };
  }

  private summaryView(item: VaultItem): VaultItemSummaryView {
    return { ...summarizeVaultItem(item), folder_name: this.folderName(item.folder) };
  }

  /** Folders outside the trash, by name. */
  folders(): VaultFolder[] {
    return this.store
      .list("vault.folder")
      .map((e) => ({
        id: e.id,
        name: typeof e.fields.name === "string" ? e.fields.name : "",
        created_at: typeof e.fields.created_at === "number" ? e.fields.created_at : 0,
        updated_at: typeof e.fields.updated_at === "number" ? e.fields.updated_at : 0,
        deleted_at: typeof e.fields.deleted_at === "number" ? e.fields.deleted_at : null,
      }))
      .filter((f) => f.deleted_at == null)
      .sort(byNameThenId);
  }

  private folderId(ref: string): string {
    const r = ref.trim();
    const folders = this.folders();
    const byId = folders.find((f) => f.id === r);
    if (byId) return byId.id;
    const named = folders.filter((f) => sameName(f.name, r));
    if (named.length === 1) return named[0]!.id;
    if (named.length === 0) throw new AtlasError("unknown_vault_folder", `no vault folder "${r}"`);
    throw new AtlasError(
      "ambiguous_vault_folder",
      `"${r}" names ${named.length} vault folders; use an id`,
    );
  }

  /** The id of the item `ref` names: an id, or a unique name outside the trash. */
  itemId(ref: string): string {
    return rules(() => resolveVaultItem(this.allItems(), ref));
  }

  /** One item by id or name, secrets included. */
  item(ref: string): VaultItemView {
    const id = this.itemId(ref);
    return this.view(toVaultItem(id, this.store.get("vault.item", id) ?? {}));
  }

  /** One field's value of the item `ref` names: what a CI step reads. */
  secret(ref: string, field: string): string {
    const item = this.item(ref);
    return rules(() => vaultItemField(item, field));
  }

  /** Items outside the trash, filtered by `query`, without their secrets: by name. */
  items(query: VaultQuery = {}): VaultItemSummaryView[] {
    const folder = query.folder ? this.folderId(query.folder) : null;
    if (query.type && !(VAULT_ITEM_TYPES as readonly string[]).includes(query.type)) {
      throw new AtlasError("bad_input", `type must be one of ${VAULT_ITEM_TYPES.join(", ")}`);
    }
    const tag = query.tag?.toLowerCase();
    const search = query.search?.toLowerCase();
    return this.allItems()
      .filter((i) => i.deleted_at == null)
      .filter((i) => folder == null || i.folder === folder)
      .filter((i) => !query.type || i.type === query.type)
      .filter((i) => !tag || i.tags.some((t) => t.toLowerCase() === tag))
      .filter(
        (i) =>
          !search ||
          i.name.toLowerCase().includes(search) ||
          i.urls.some((u) => u.toLowerCase().includes(search)) ||
          i.tags.some((t) => t.toLowerCase().includes(search)),
      )
      .sort(byNameThenId)
      .map((i) => this.summaryView(i));
  }

  /** `input` with its `folder` (an id or name) resolved to the folder's id. */
  private withFolderId<T extends { folder?: string | null }>(input: T): T {
    return typeof input.folder === "string"
      ? { ...input, folder: this.folderId(input.folder) }
      : input;
  }

  private write(
    entity: "vault.item" | "vault.folder",
    id: string,
    fields: Record<string, unknown>,
  ) {
    for (const [field, value] of Object.entries(fields)) this.store.set(entity, id, field, value);
  }

  /** Create an item (its `folder` may be a name) and push it. */
  async createItem(input: VaultItemInput): Promise<VaultItemView> {
    this.requireWrite();
    const fields = rules(() => newVaultItemFields(this.withFolderId(input), Date.now()));
    const id = this.store.newEntityId();
    this.write("vault.item", id, fields);
    await this.push();
    return this.item(id);
  }

  /** Change the item `ref` names and push; unchanged values write nothing. */
  async updateItem(ref: string, patch: VaultItemPatch): Promise<VaultItemView> {
    const id = this.itemId(ref);
    this.requireWrite();
    const current = this.store.get("vault.item", id) ?? {};
    const changes = rules(() => vaultItemChanges(current, this.withFolderId(patch), Date.now()));
    if (Object.keys(changes).length) {
      this.write("vault.item", id, changes);
      await this.push();
    }
    return this.item(id);
  }

  /** Move the item `ref` names to the trash; a no-op when it already is. Returns its id. */
  async deleteItem(ref: string): Promise<string> {
    const id = this.itemId(ref);
    if (this.item(id).deleted_at != null) return id;
    this.requireWrite();
    const now = Date.now();
    this.write("vault.item", id, { deleted_at: now, updated_at: now });
    await this.push();
    return id;
  }

  /** Create a folder and push it. */
  async createFolder(name: string): Promise<VaultFolder> {
    this.requireWrite();
    const trimmed = name.trim();
    if (!trimmed) throw new AtlasError("bad_input", "a vault folder needs a name");
    if (this.folders().some((f) => sameName(f.name, trimmed))) {
      throw new AtlasError("vault_folder_exists", `there is already a vault folder "${trimmed}"`);
    }
    const now = Date.now();
    const id = this.store.newEntityId();
    this.write("vault.folder", id, { name: trimmed, created_at: now, updated_at: now });
    await this.push();
    return this.folders().find((f) => f.id === id)!;
  }

  /** Stop background timers. Every write has already been pushed. */
  close(): void {
    this.sync.dispose();
  }
}
