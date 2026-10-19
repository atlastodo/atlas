/**
 * Atlas Vault item rules (`vault.item`, manifests/vault.json), at parity with
 * `crates/atlas-client/src/vault.rs` through `test-vectors/vault_item_vectors.json`. Every field of
 * an item is end-to-end encrypted under the vault app key; these rules decide what a client
 * writes. An item's stored fields:
 * - `type`: one of {@link VAULT_ITEM_TYPES}; `name`: non-empty text.
 * - `fields`: `{name, kind, value}[]`, names unique case-insensitively, `kind` one of
 *   {@link VAULT_FIELD_KINDS}; `hidden` and `totp` values are secrets (a TOTP value is an
 *   `otpauth://` URI or a base32 seed, stored upper-case without spaces or padding).
 * - `urls`, `tags`: string lists; `notes`: text; `folder`: a `vault.folder` id or null;
 *   `favorite`: a boolean.
 * - `history`: earlier values of secret fields, `{field, value, changed_at}`, newest first, at most
 *   {@link VAULT_HISTORY_PER_FIELD} per field name.
 * - `created_at`, `updated_at`: unix ms; `deleted_at`: unix ms once in the trash, else null.
 */

export const VAULT_ITEM_TYPES = [
  "login",
  "note",
  "card",
  "identity",
  "ssh_key",
  "api_key",
] as const;
export const VAULT_FIELD_KINDS = ["text", "hidden", "totp", "email", "url", "phone"] as const;
/** Secret field kinds; a kind this client does not know counts as secret too. */
export const VAULT_SECRET_KINDS = ["hidden", "totp"] as const;
export const VAULT_HISTORY_PER_FIELD = 5;

export type VaultItemType = (typeof VAULT_ITEM_TYPES)[number];

export interface VaultField {
  name: string;
  kind: string;
  value: string;
}

export interface VaultHistoryEntry {
  field: string;
  value: string;
  changed_at: number;
}

/** A vault item as integrations see it, secrets included. */
export interface VaultItem {
  id: string;
  type: string;
  name: string;
  fields: VaultField[];
  urls: string[];
  notes: string;
  tags: string[];
  folder: string | null;
  favorite: boolean;
  history: VaultHistoryEntry[];
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

/** An item in a listing: everything but the field values, notes and history. */
export interface VaultItemSummary {
  id: string;
  type: string;
  name: string;
  fields: { name: string; kind: string }[];
  urls: string[];
  tags: string[];
  folder: string | null;
  favorite: boolean;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

/** A field as given: kind `text` when left out. */
export interface VaultFieldInput {
  name: string;
  kind?: string;
  value: string;
}

/** A new item. `folder` is a folder id (a client resolves names first). */
export interface VaultItemInput {
  type?: string;
  name: string;
  fields?: VaultFieldInput[];
  urls?: string[];
  notes?: string;
  tags?: string[];
  folder?: string | null;
  favorite?: boolean;
}

/**
 * A change: `fields` replaces the list; `set_fields` sets one field's value (and kind, when
 * given) or appends it, `remove_fields` removes fields by name; `folder: null` clears it.
 */
export interface VaultItemPatch extends Partial<Omit<VaultItemInput, "fields">> {
  fields?: VaultFieldInput[];
  set_fields?: VaultFieldInput[];
  remove_fields?: string[];
}

/** A rule refused the input; `code` is stable (`bad_input`, `unknown_vault_item`, …). */
export class VaultError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

const CREATE_KEYS = ["type", "name", "fields", "urls", "notes", "tags", "folder", "favorite"];
const PATCH_KEYS = [...CREATE_KEYS, "set_fields", "remove_fields"];

const bad = (message: string) => new VaultError("bad_input", message);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const isSecret = (kind: string) =>
  (VAULT_SECRET_KINDS as readonly string[]).includes(kind) ||
  !(VAULT_FIELD_KINDS as readonly string[]).includes(kind);

/** Deep equality of JSON values, key order aside. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => jsonEqual(x, b[i]))
    );
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return (
      ka.length === Object.keys(b).length && ka.every((k) => has(b, k) && jsonEqual(a[k], b[k]))
    );
  }
  return false;
}

/** Tags trimmed, without empty ones or repeats (case-insensitive), in order. */
export function cleanVaultTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of tags.map((t) => t.trim())) {
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

/** URLs trimmed, without empty ones or exact repeats, in order. */
export function cleanVaultUrls(urls: readonly string[]): string[] {
  const out: string[] = [];
  for (const u of urls.map((u) => u.trim())) if (u && !out.includes(u)) out.push(u);
  return out;
}

function readFields(v: unknown): VaultField[] {
  if (!Array.isArray(v)) return [];
  const out: VaultField[] = [];
  for (const f of v) {
    if (!isObject(f) || typeof f.name !== "string" || typeof f.value !== "string") continue;
    out.push({ name: f.name, kind: typeof f.kind === "string" ? f.kind : "text", value: f.value });
  }
  return out;
}

function readHistory(v: unknown): VaultHistoryEntry[] {
  if (!Array.isArray(v)) return [];
  const out: VaultHistoryEntry[] = [];
  for (const h of v) {
    if (!isObject(h) || typeof h.field !== "string" || typeof h.value !== "string") continue;
    out.push({ field: h.field, value: h.value, changed_at: int(h.changed_at) ?? 0 });
  }
  return out;
}

/**
 * Read an item's stored fields, tolerating values of the wrong shape (another client's): an
 * unknown type or field kind is kept, anything malformed is dropped or defaulted.
 */
export function toVaultItem(id: string, f: Record<string, unknown>): VaultItem {
  const text = (k: string) => (typeof f[k] === "string" ? (f[k] as string) : "");
  return {
    id,
    type: typeof f.type === "string" ? f.type : "login",
    name: text("name"),
    fields: readFields(f.fields),
    urls: strings(f.urls),
    notes: text("notes"),
    tags: strings(f.tags),
    folder: typeof f.folder === "string" ? f.folder : null,
    favorite: typeof f.favorite === "boolean" ? f.favorite : false,
    history: readHistory(f.history),
    created_at: int(f.created_at) ?? 0,
    updated_at: int(f.updated_at) ?? 0,
    deleted_at: int(f.deleted_at),
  };
}

/** The listing form of an item: no field values, notes or history. */
export function summarizeVaultItem(item: VaultItem): VaultItemSummary {
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    fields: item.fields.map((f) => ({ name: f.name, kind: f.kind })),
    urls: [...item.urls],
    tags: [...item.tags],
    folder: item.folder,
    favorite: item.favorite,
    created_at: item.created_at,
    updated_at: item.updated_at,
    deleted_at: item.deleted_at,
  };
}

function checkKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(input)
    .sort()
    .find((k) => !allowed.includes(k));
  if (unknown !== undefined) throw bad(`${unknown} is not a vault item field`);
}

function checkType(v: unknown): string {
  if (typeof v === "string" && (VAULT_ITEM_TYPES as readonly string[]).includes(v)) return v;
  throw bad(`type must be one of ${VAULT_ITEM_TYPES.join(", ")}`);
}

function checkName(v: unknown): string {
  if (typeof v !== "string") throw bad("name must be a string");
  const name = v.trim();
  if (!name) throw bad("a vault item needs a name");
  return name;
}

function checkStrings(key: string, v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) {
    throw bad(`${key} must be a list of strings`);
  }
  return v as string[];
}

function checkNotes(v: unknown): string {
  if (typeof v !== "string") throw bad("notes must be a string");
  return v;
}

function checkFolder(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v === "string" && v.trim()) return v.trim();
  throw bad("folder must be a folder id or null");
}

function checkFavorite(v: unknown): boolean {
  if (typeof v !== "boolean") throw bad("favorite must be true or false");
  return v;
}

/** A field as given, its name trimmed and non-empty and its kind (when given) a known one. */
function givenField(key: string, v: unknown): { name: string; kind: string | null; value: string } {
  const shape = () =>
    bad(`${key} must be a list of {name, kind, value} objects with string values`);
  if (!isObject(v) || typeof v.name !== "string" || typeof v.value !== "string") throw shape();
  let kind: string | null = null;
  if (v.kind !== undefined && v.kind !== null) {
    if (typeof v.kind !== "string") throw shape();
    kind = v.kind;
  }
  const name = v.name.trim();
  if (!name) throw bad("a field needs a name");
  if (kind !== null && !(VAULT_FIELD_KINDS as readonly string[]).includes(kind)) {
    throw bad(`field kind must be one of ${VAULT_FIELD_KINDS.join(", ")}`);
  }
  return { name, kind, value: v.value };
}

/**
 * A field value as its kind stores it: a TOTP seed upper-cased without whitespace or padding (an
 * `otpauth://` URI only trimmed); everything else exactly as given.
 */
function fieldValue(name: string, kind: string, value: string): string {
  if (kind !== "totp") return value;
  const t = value.trim();
  if (t.slice(0, 10).replace(/[A-Z]/g, (c) => c.toLowerCase()) === "otpauth://") return t;
  const seed = t
    .replace(/\s/g, "")
    .replace(/[a-z]/g, (c) => c.toUpperCase())
    .replace(/=+$/, "");
  if (!seed || !/^[A-Z2-7]+$/.test(seed)) {
    throw bad(`the totp field "${name}" needs an otpauth:// URI or a base32 secret`);
  }
  return seed;
}

function givenFields(v: unknown): VaultField[] {
  if (!Array.isArray(v)) {
    throw bad("fields must be a list of {name, kind, value} objects with string values");
  }
  const out: VaultField[] = [];
  for (const item of v) {
    const g = givenField("fields", item);
    const kind = g.kind ?? "text";
    const value = fieldValue(g.name, kind, g.value);
    if (out.some((f) => sameName(f.name, g.name))) {
      throw bad(`two fields are named "${g.name.toLowerCase()}"`);
    }
    out.push({ name: g.name, kind, value });
  }
  return out;
}

const fieldJson = (f: VaultField) => ({ name: f.name, kind: f.kind, value: f.value });
const historyJson = (h: VaultHistoryEntry) => ({
  field: h.field,
  value: h.value,
  changed_at: h.changed_at,
});

/** The stored fields of a new item from `input` at `now`; throws {@link VaultError}. */
export function newVaultItemFields(input: unknown, now: number): Record<string, unknown> {
  if (!isObject(input)) throw bad("a vault item is a JSON object");
  checkKeys(input, CREATE_KEYS);
  const type = has(input, "type") ? checkType(input.type) : "login";
  if (!has(input, "name")) throw bad("a vault item needs a name");
  const name = checkName(input.name);
  const fields = has(input, "fields") ? givenFields(input.fields) : [];
  const urls = has(input, "urls") ? cleanVaultUrls(checkStrings("urls", input.urls)) : [];
  const notes = has(input, "notes") ? checkNotes(input.notes) : "";
  const tags = has(input, "tags") ? cleanVaultTags(checkStrings("tags", input.tags)) : [];
  const folder = has(input, "folder") ? checkFolder(input.folder) : null;
  const favorite = has(input, "favorite") ? checkFavorite(input.favorite) : false;
  return {
    type,
    name,
    fields: fields.map(fieldJson),
    urls,
    notes,
    tags,
    folder,
    favorite,
    history: [],
    created_at: now,
    updated_at: now,
  };
}

/** The field list after `set_fields` and `remove_fields`: removals first, then each set. */
function patchedFields(current: VaultField[], set: unknown, remove: unknown): VaultField[] {
  let fields = current.map((f) => ({ ...f }));
  if (remove !== undefined) {
    for (const name of checkStrings("remove_fields", remove)) {
      const before = fields.length;
      fields = fields.filter((f) => !sameName(f.name, name));
      if (fields.length === before) throw bad(`no field "${name.trim()}" to remove`);
    }
  }
  if (set !== undefined) {
    if (!Array.isArray(set)) {
      throw bad("set_fields must be a list of {name, kind, value} objects with string values");
    }
    for (const item of set) {
      const g = givenField("set_fields", item);
      const existing = fields.find((f) => sameName(f.name, g.name));
      if (existing) {
        if (g.kind !== null) existing.kind = g.kind;
        existing.value = fieldValue(existing.name, existing.kind, g.value);
      } else {
        const kind = g.kind ?? "text";
        fields.push({ name: g.name, kind, value: fieldValue(g.name, kind, g.value) });
      }
    }
  }
  return fields;
}

/**
 * The history after `before` became `after`: each secret field of `before` whose value changed or
 * that went leaves its value, newest first, then the earlier entries, at most
 * {@link VAULT_HISTORY_PER_FIELD} per field name.
 */
function nextHistory(
  history: VaultHistoryEntry[],
  before: VaultField[],
  after: VaultField[],
  now: number,
): VaultHistoryEntry[] {
  const entries: VaultHistoryEntry[] = before
    .filter((old) => isSecret(old.kind))
    .filter((old) => {
      const next = after.find((f) => sameName(f.name, old.name));
      return !next || next.value !== old.value;
    })
    .map((old) => ({ field: old.name, value: old.value, changed_at: now }));
  entries.push(...history);
  const counts = new Map<string, number>();
  return entries.filter((e) => {
    const key = e.field.trim().toLowerCase();
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n <= VAULT_HISTORY_PER_FIELD;
  });
}

/**
 * The fields a patch writes to the item stored as `current` at `now` (empty when nothing changes;
 * `updated_at` with any change); throws {@link VaultError}.
 */
export function vaultItemChanges(
  current: Record<string, unknown>,
  patch: unknown,
  now: number,
): Record<string, unknown> {
  if (!isObject(patch)) throw bad("a vault item change is a JSON object");
  checkKeys(patch, PATCH_KEYS);
  if (has(patch, "fields") && (has(patch, "set_fields") || has(patch, "remove_fields"))) {
    throw bad("give fields (the whole list) or set_fields and remove_fields, not both");
  }
  const item = toVaultItem("", current);
  const changes: Record<string, unknown> = {};
  if (has(patch, "type")) {
    const t = checkType(patch.type);
    if (t !== item.type) changes.type = t;
  }
  if (has(patch, "name")) {
    const n = checkName(patch.name);
    if (n !== item.name) changes.name = n;
  }
  let fields: VaultField[] | null = null;
  if (has(patch, "fields")) fields = givenFields(patch.fields);
  else if (has(patch, "set_fields") || has(patch, "remove_fields")) {
    fields = patchedFields(item.fields, patch.set_fields, patch.remove_fields);
  }
  if (fields) {
    const list = fields;
    const dup = list.find((f, i) => list.slice(0, i).some((g) => sameName(g.name, f.name)));
    if (dup) throw bad(`two fields are named "${dup.name.trim().toLowerCase()}"`);
    if (!jsonEqual(list, item.fields)) {
      const history = nextHistory(item.history, item.fields, list, now);
      changes.fields = list.map(fieldJson);
      if (!jsonEqual(history, item.history)) changes.history = history.map(historyJson);
    }
  }
  if (has(patch, "urls")) {
    const urls = cleanVaultUrls(checkStrings("urls", patch.urls));
    if (!jsonEqual(urls, item.urls)) changes.urls = urls;
  }
  if (has(patch, "notes")) {
    const notes = checkNotes(patch.notes);
    if (notes !== item.notes) changes.notes = notes;
  }
  if (has(patch, "tags")) {
    const tags = cleanVaultTags(checkStrings("tags", patch.tags));
    if (!jsonEqual(tags, item.tags)) changes.tags = tags;
  }
  if (has(patch, "folder")) {
    const folder = checkFolder(patch.folder);
    if (folder !== item.folder) changes.folder = folder;
  }
  if (has(patch, "favorite")) {
    const favorite = checkFavorite(patch.favorite);
    if (favorite !== item.favorite) changes.favorite = favorite;
  }
  if (Object.keys(changes).length > 0) changes.updated_at = now;
  return changes;
}

/**
 * The id `ref` names among `items`: an id, trashed or not, or a name (case-insensitive, trimmed)
 * of exactly one item outside the trash; throws `unknown_vault_item` or `ambiguous_vault_item`.
 */
export function resolveVaultItem(
  items: readonly { id: string; name: string; deleted_at: number | null }[],
  ref: string,
): string {
  const r = ref.trim();
  const byId = items.find((i) => i.id === r);
  if (byId) return byId.id;
  const named = items
    .filter((i) => i.deleted_at == null && sameName(i.name, r))
    .map((i) => i.id)
    .sort();
  if (named.length === 1) return named[0]!;
  if (named.length === 0) throw new VaultError("unknown_vault_item", `no vault item "${r}"`);
  throw new VaultError(
    "ambiguous_vault_item",
    `"${r}" names ${named.length} vault items (${named.join(", ")}); use an id`,
  );
}

/** The value of the item's field named `name` (case-insensitive), exactly as stored. */
export function vaultItemField(item: Pick<VaultItem, "name" | "fields">, name: string): string {
  const field = item.fields.find((f) => sameName(f.name, name));
  if (field) return field.value;
  const hasFields = item.fields.length
    ? `it has: ${item.fields.map((f) => f.name).join(", ")}`
    : "it has none";
  throw new VaultError(
    "unknown_vault_field",
    `vault item "${item.name}" has no field "${name.trim()}" (${hasFields})`,
  );
}
