/** Entity and wire types Timestamps are Unix ms. */

export type Priority = 1 | 2 | 3 | 4;

export type ProjectKind = "project" | "folder";
/** How a project opens when the URL does not say: its task list or its board. */
export type ProjectView = "list" | "board";

export interface Task {
  id: string;
  project_id: string | null;
  section_id: string | null;
  parent_id: string | null;
  title: string;
  notes: string;
  priority: Priority;
  start_at: number | null;
  due_at: number | null;
  is_completed: boolean;
  completed_at: number | null;
  archived_at: number | null;
  deleted_at: number | null;
  recurrence: string | null;
  assignee_id: string | null;
  estimate_min: number | null;
  label_ids: string[];
  sort_order: number;
  created_at: number;
  updated_at: number;
  /** Some field is undecryptable ciphertext; typed fields hold placeholders, so don't edit a locked task. */
  locked?: boolean;
}

export interface Project {
  id: string;
  owner_id: string;
  name: string;
  color: string;
  icon: string;
  sort_order: number;
  is_favorite: boolean;
  parent_id: string | null;
  kind: ProjectKind;
  default_view: ProjectView;
  archived_at: number | null;
  deleted_at: number | null;
}

export interface Section {
  id: string;
  project_id: string;
  name: string;
  sort_order: number;
  deleted_at: number | null;
  archived_at: number | null;
}

export interface Label {
  id: string;
  owner_id: string;
  name: string;
  color: string;
}

export interface AuthUser {
  id: string;
  email: string;
  display_name: string;
  /** UI hint only (the server re-checks); read through `isAdmin()`. */
  is_admin?: boolean;
  /** `false` asks the user to confirm the phrase; absent means unknown until `/auth/me`. */
  has_recovery_key?: boolean;
  /** `false` for an account without a password (passkey-only); absent from older servers. */
  has_password?: boolean;
}

export type EncryptedFieldPayload =
  { __enc: 2; kid: string; iv: string; ct: string } | { __enc: 1; iv: string; ct: string };

/** Encrypted attachment `meta`; `__aenc` (not `__enc`) keeps `fromEncryptedWire` from handling it. */
export interface AttachmentMetaPayload {
  __aenc: 1;
  iv: string;
  ct: string;
}

export interface AttachmentMeta {
  filename: string;
  mime: string;
  plain_sha: string;
  dims?: { width: number; height: number };
}

export interface SaltResponse {
  salt: string | null;
  is_e2ee: boolean;
  /** Absent from a server predating per-account KDFs (version 1). */
  kdf_version?: number;
  kdf_params?: Record<string, number>;
}

export interface UserPublicKeyResponse {
  user_id: string;
  email: string;
  public_key: string | null;
  signing_public_key?: string | null;
}

export interface SigningKeyResponse {
  signing_public_key: string | null;
  encrypted_signing_key: { iv: string; ct: string } | null;
}

/** `wrapped` is the caller's own copy under their DEK, `sealed` an owner's delivery; `key_id` `""` predates fingerprinting. */
export interface ProjectKeyRow {
  project_id: string;
  key_id: string;
  kind: "wrapped" | "sealed";
  encrypted_pek: unknown;
  /** Delivery signature and signer; null on own copies and pre-signing deliveries. */
  signature?: string | null;
  signed_by?: string | null;
  signer_public_key?: string | null;
  signer_signing_key?: string | null;
}

/** Retired key ids stay readable but are no longer writable. */
export interface ProjectKeysResponse {
  keys: ProjectKeyRow[];
  canonical: Record<string, string>;
  retired?: Record<string, string[]>;
}

export interface PendingKeyRotation {
  project_id: string;
  request: number;
}

/** `GET /project-keys/missing`; `public_key` is null for an account without one. */
export interface MissingProjectKey {
  project_id: string;
  user_id: string;
  public_key: string | null;
  key_id: string;
}

/** Single-use proof of possession: a nonce sealed to the account's public key. */
export interface RecoveryChallenge {
  token: string;
  sealed: import("./crypto").SealedKey;
}

export interface RecoveryKeysResponse {
  salt?: string;
  /** Deprecated legacy wraps (DEK and private key under the phrase); still the DEK's source. */
  recovery_encrypted_dek?: { iv: string; ct: string };
  recovery_encrypted_private_key?: { iv: string; ct: string };
  /** 2 = phrase-derived recovery key, 1 = account private key (no recovery key yet). */
  recovery_key_version?: number;
  challenge?: RecoveryChallenge;
  /** Absent from a server predating root keys. Dummies when the account has none. */
  user_id?: string;
  recovery_encrypted_root_key?: import("./crypto").RootKeyWrap & { epk?: string };
  todo_app_key?: import("./crypto").RootKeyWrap;
}

export interface ReplaceRecoveryKeyPayload {
  /** The current auth hash, or instead `reauth_token` (a passkey proof, `passkeyReauth`). */
  current_password?: string;
  reauth_token?: string;
  recovery_public_key: string;
  recovery_encrypted_dek: { iv: string; ct: string };
  recovery_encrypted_private_key: { iv: string; ct: string };
  /** The root key under the new phrase; without it the server empties the recovery slot. */
  recovery_encrypted_root_key?: import("./crypto").RootKeyWrap;
}

/** An app's key under the account root key, and the app's identity under the app key. */
export interface AppKeyRow {
  app: string;
  wrapped_key: import("./crypto").RootKeyWrap;
  wrapped_private_key?: import("./crypto").RootKeyWrap;
}

/** `GET /auth/root-key`. */
export interface RootKeyResponse {
  has_root_key: boolean;
  encrypted_root_key: import("./crypto").RootKeyWrap | null;
  has_recovery_root_key: boolean;
  recovery_public_key: string | null;
  app_keys: AppKeyRow[];
}

/** `POST /auth/root-key`: migrate an account created before root keys (set once). */
export interface MigrateRootKeyPayload {
  /** The current auth hash, or instead `reauth_token` (a passkey proof, `passkeyReauth`). */
  current_password?: string;
  reauth_token?: string;
  encrypted_root_key: import("./crypto").RootKeyWrap;
  recovery_encrypted_root_key?: import("./crypto").SealedRootKeyWrap;
  /** The recovery public key the slot was sealed to. */
  recovery_public_key?: string;
  app_keys: AppKeyRow[];
}

/** `PUT /auth/root-key/recovery`: fill an empty recovery slot. */
export interface PutRecoveryRootKeyPayload {
  /** The current auth hash, or instead `reauth_token` (a passkey proof, `passkeyReauth`). */
  current_password?: string;
  reauth_token?: string;
  recovery_public_key: string;
  recovery_encrypted_root_key: import("./crypto").RootKeyWrap;
}

export interface RegisterRecoveryKeyPayload {
  /** The current auth hash, or instead `reauth_token` (a passkey proof, `passkeyReauth`). */
  current_password?: string;
  reauth_token?: string;
  recovery_public_key: string;
}

/** The salt and keypair are immutable and not sent. */
export interface RecoverAccountPayload {
  email: string;
  challenge_token: string;
  challenge_response: string;
  new_auth_hash: string;
  encrypted_dek: { iv: string; ct: string };
  encrypted_private_key: { iv: string; ct: string };
  kdf_version?: number;
  kdf_params?: Record<string, number>;
  /** The recovered (or, with `app_keys`, new) root key under the new MEK. */
  encrypted_root_key?: import("./crypto").RootKeyWrap;
  /** The root key under the phrase: the recovery slot in its authenticated form. */
  recovery_encrypted_root_key?: import("./crypto").RootKeyWrap;
  /** A new root's app keys, when the old root had no recovery slot to come back from. */
  app_keys?: AppKeyRow[];
}

export interface ChangePasswordPayload {
  /** The current auth hash, or instead `reauth_token` (a passkey proof, `passkeyReauth`). */
  current_password?: string;
  reauth_token?: string;
  new_password: string;
  encrypted_dek: { iv: string; ct: string };
  encrypted_private_key: { iv: string; ct: string };
  recovery_encrypted_dek?: { iv: string; ct: string };
  recovery_encrypted_private_key?: { iv: string; ct: string };
  kdf_version?: number;
  kdf_params?: Record<string, number>;
  /** Same password, newer KDF: other sessions are kept. */
  kdf_upgrade?: boolean;
  /** The root key re-wrapped under the new MEK; without it the server drops the root. */
  encrypted_root_key?: import("./crypto").RootKeyWrap;
}

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  device_id: string;
  device_name?: string | null;
  user: AuthUser;
  salt?: string;
  public_key?: string;
  /**
   * Deprecated: the DEK and private key directly under the MEK, from before the root key. Still
   * sent for older clients; this one opens `encrypted_root_key` first and falls back to these.
   */
  encrypted_dek?: { iv: string; ct: string };
  encrypted_private_key?: { iv: string; ct: string };
  signing_public_key?: string;
  encrypted_signing_key?: { iv: string; ct: string };
  is_e2ee?: boolean;
  /** Absent from a server predating per-account KDFs (version 1). */
  kdf_version?: number;
  kdf_params?: Record<string, number>;
  /** Absent (all of them) from a server predating root keys. */
  has_root_key?: boolean;
  /** The root key's password slot (under the MEK). */
  encrypted_root_key?: import("./crypto").RootKeyWrap;
  app_keys?: AppKeyRow[];
  recovery_public_key?: string;
  has_recovery_root_key?: boolean;
  /** On a passkey sign-in or signup: the root key under that passkey's slot. */
  passkey?: PasskeySlotView;
}

export type MemberRole = "owner" | "editor" | "commenter";

/** One signed-in device; `current` marks the caller. */
export interface SessionView {
  device_id: string;
  device_name?: string | null;
  created_at: number;
  last_used_at: number;
  expires_at: number;
  current: boolean;
}

/** A personal API token as listed: never its secret (unix millis). */
export interface ApiTokenView {
  id: string;
  name: string;
  /** The apps the token carries keys for and may sync (absent from servers predating app scopes: todo). */
  apps?: string[];
  created_at: number;
  last_used_at?: number;
  /** When the token stops working; absent when it never does. An expired token stays listed until revoked. */
  expires_at?: number;
  /** Whether its sessions may write (absent from servers predating read-only tokens: they may). */
  write?: boolean;
}

/** One non-todo app's key and X25519 identity wrapped for an API token (`wrapAppKeysForApiToken`). */
export interface ApiTokenAppKeyWraps {
  wrapped_key: { v: 1; iv: string; ct: string };
  wrapped_private_key: { v: 1; iv: string; ct: string };
}

/**
 * `POST /auth/api-tokens`: a token the client generated, with its keys wrapped for it. `apps`
 * defaults to `["todo"]`; the todo wraps are sent exactly when it lists todo, and `app_keys` has
 * one entry per other app (needs the `app_scoped_api_tokens` capability).
 */
export interface CreateApiTokenPayload {
  id: string;
  name: string;
  auth: string;
  apps?: string[];
  wrapped_dek?: { v: 1; iv: string; ct: string };
  wrapped_private_key?: { v: 1; iv: string; ct: string };
  app_keys?: Record<string, ApiTokenAppKeyWraps>;
  /**
   * When the token stops working (unix ms). The apps' policy ({@link tokenPolicyFor}) may require
   * one and cap how far out it is: a vault token needs one at most 365 days ahead (needs the
   * `api_token_policies` capability).
   */
  expires_at?: number;
  /** Whether its sessions may write; the policy's default when absent (a vault token is read-only). */
  write?: boolean;
}

/** `POST /auth/api-token/session`: an access token (no refresh token) and the token's wraps. */
export interface ApiTokenSessionResponse {
  access_token: string;
  expires_in: number;
  token_id: string;
  user_id: string;
  /** The apps the session may sync (absent from servers predating app scopes: todo). */
  apps?: string[];
  /** The todo key and identity; absent for a token without todo. */
  wrapped_dek?: { v: 1; iv: string; ct: string };
  wrapped_private_key?: { v: 1; iv: string; ct: string };
  app_keys?: Record<string, ApiTokenAppKeyWraps>;
  public_key?: string;
  signing_public_key?: string;
  encrypted_signing_key?: { v: 1; iv: string; ct: string };
  /** When the token expires (unix ms); `expires_in` ends no later. Absent when it never does. */
  expires_at?: number;
  /** Whether the session may write; a read-only one gets 403 `api_token_read_only` on writes. */
  write?: boolean;
}

export interface MemberView {
  user_id: string;
  email: string;
  display_name: string;
  role: MemberRole;
  state: "pending" | "active";
  invited_by: string | null;
  deletion_scheduled?: boolean;
  has_key: boolean;
  public_key?: string | null;
  signing_public_key?: string | null;
}

export interface InviteView {
  project_id: string;
  role: MemberRole;
  invited_at: number;
  inviter: { user_id: string; email: string; display_name: string } | null;
  /**
   * The project's fields as the inviter's rows written before sync protocol 7 hold them, each an
   * envelope readable only with `sealed_key`, or null. Null once those rows are migrated: see
   * `preview`.
   */
  project: { name: unknown; icon: unknown; color: unknown; kind: unknown };
  /** What the inviter sealed under the project key for the invitee (`openInvitePreview`). */
  preview?: import("./crypto").SealedInvitePreview | null;
  sealed_key: { key_id: string; encrypted_pek: unknown } | null;
}

/** Internal camelCase form; `ApiClient` converts to and from the snake_case wire format. */
export type Operation = {
  id: string;
  entity: EntityKind;
  entityId: string;
  ts: import("./hlc").Hlc;
} & ({ op: "set"; field: string; value: unknown } | { op: "delete" });

export type EntityKind =
  | "task"
  | "project"
  | "section"
  | "label"
  | "comment"
  | "preference"
  | "saved_filter"
  | "reminder"
  | "project_member"
  | "activity"
  | "focus_session"
  | "habit"
  | "habit_checkin"
  /** Metadata only; ciphertext travels via `/attachments/blobs/:sha256`. */
  | "attachment"
  /**
   * Atlas Journal's kinds (`manifests/journal.json`), namespaced `<app>.<kind>` like every app's
   * after todo. Personal and fully encrypted: no plaintext field, no project scope. A journal
   * client syncs them in a journal-scoped session (`ApiClientOptions.apps`).
   */
  | JournalEntityKind
  /** Atlas Vault (`manifests/vault.json`): personal, every field encrypted. */
  | "vault.item"
  | "vault.folder"
  | "vault.preference";

/** Atlas Journal's entity kinds: `journal.entry` (one entry) and `journal.preference` (a setting). */
export type JournalEntityKind = "journal.entry" | "journal.preference";

export interface CreateTaskInput {
  title: string;
  notes?: string;
  priority?: Priority;
  project_id?: string | null;
  section_id?: string | null;
  parent_id?: string | null;
  start_at?: number | null;
  due_at?: number | null;
  recurrence?: string | null;
  assignee_id?: string | null;
  estimate_min?: number | null;
  label_ids?: string[];
  sort_order?: number;
}

export type BugReportKind = "crash" | "manual";

/** A closed union, never free text, so user content cannot leak into the trail. */
export type BreadcrumbCode =
  | "nav"
  | "task.open"
  | "task.create"
  | "task.toggle"
  | "task.update"
  | "task.delete"
  | "project.open"
  | "filter.open"
  | "settings.change"
  | "sync.ok"
  | "sync.error"
  | "app.foreground"
  | "app.background";

export interface BugReportBreadcrumb {
  at: number;
  code: BreadcrumbCode;
  ref?: string;
}

export interface BugReportDiagnostics {
  syncStatus: string | null;
  lastSyncAt: number | null;
  pending: number;
  quarantined: number;
  lastErrorKind: "network" | "http" | "storage" | null;
  lastErrorStatus: number | null;
  lastErrorMessage: string | null;
  online: boolean | null;
}

export interface BugReportPayload {
  id: string;
  kind: BugReportKind;
  message: string;
  stack?: string;
  description?: string;
  appVersion: string;
  platform: string;
  osVersion?: string;
  route?: string;
  deviceId?: string;
  diagnostics: BugReportDiagnostics;
  breadcrumbs: BugReportBreadcrumb[];
  occurredAt: number;
}

export interface BugReportSummary {
  id: string;
  user_id: string | null;
  user_email: string | null;
  kind: BugReportKind;
  message: string;
  app_version: string;
  platform: string;
  os_version: string | null;
  route: string | null;
  occurred_at_ms: number;
  created_at_ms: number;
  resolved_at_ms: number | null;
}

export interface BugReportView extends BugReportSummary {
  stack: string | null;
  description: string | null;
  device_id: string | null;
  diagnostics: Partial<BugReportDiagnostics> & Record<string, unknown>;
  breadcrumbs: BugReportBreadcrumb[];
}

export interface AdminUserView {
  id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
  disabled: boolean;
  deletion_scheduled: boolean;
  /** Days until the scheduled deletion is purged; null when none is scheduled. */
  deletion_days_remaining: number | null;
  created_at_ms: number;
  last_login_at_ms: number | null;
  managed_by_env?: boolean;
}

/** `code` is returned only by the creating call (null in the list). */
export interface AdminInviteView {
  id: string;
  code: string | null;
  created_at_ms: number;
  expires_at_ms: number;
  used_at_ms: number | null;
  used_by_email: string | null;
  revoked_at_ms: number | null;
}

export interface AdminSettingsView {
  signup_enabled: boolean;
}

export interface AdminAuditEntry {
  id: number;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  target_user_id: string | null;
  target_email: string | null;
  details: Record<string, unknown>;
  created_at_ms: number;
}

// --- Passkeys: WebAuthn Level 3 JSON, binary fields as unpadded base64url --------------------

export interface PasskeyDescriptor {
  type: "public-key";
  id: string;
  transports?: string[];
}

/** The PRF extension's inputs, as the server names them. */
export interface PasskeyPrfInputs {
  eval?: { first: string; second?: string };
  evalByCredential?: Record<string, { first: string; second?: string }>;
}

/** `PublicKeyCredentialCreationOptionsJSON`. */
export interface PasskeyCreationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  timeout?: number;
  excludeCredentials?: PasskeyDescriptor[];
  authenticatorSelection?: {
    residentKey?: string;
    requireResidentKey?: boolean;
    userVerification?: string;
    authenticatorAttachment?: string;
  };
  attestation?: string;
  extensions?: { credProps?: boolean; prf?: PasskeyPrfInputs };
}

/** `PublicKeyCredentialRequestOptionsJSON`. */
export interface PasskeyRequestOptions {
  challenge: string;
  rpId: string;
  timeout?: number;
  userVerification?: string;
  allowCredentials?: PasskeyDescriptor[];
  extensions?: { prf?: PasskeyPrfInputs };
}

/** `RegistrationResponseJSON`. */
export interface PasskeyRegistrationResponse {
  id: string;
  rawId: string;
  type: "public-key";
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
  authenticatorAttachment?: string | null;
  clientExtensionResults: Record<string, unknown>;
}

/** `AuthenticationResponseJSON`. */
export interface PasskeyAssertionResponse {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string | null;
  };
  authenticatorAttachment?: string | null;
  clientExtensionResults: Record<string, unknown>;
}

/** A passkey's root slot, from a passkey sign-in, signup or re-authentication. */
export interface PasskeySlotView {
  id: string;
  credential_id: string;
  encrypted_root_key: import("./crypto").RootKeyWrap;
}

/** A passkey as `GET /auth/passkeys` lists it (unix millis). */
export interface PasskeyView {
  id: string;
  credential_id: string;
  name: string;
  transports: string[];
  backup_eligible: boolean;
  backed_up: boolean;
  created_at: number;
  last_used_at?: number;
}

/** `POST /auth/passkeys/reauth`: a single-use proof for `reauth_token`, and the passkey's slot. */
export interface PasskeyReauthResponse {
  reauth_token: string;
  expires_in: number;
  passkey: PasskeySlotView;
}

/** The passkey of a passkey signup, or of `POST /auth/passkeys` (with a proof). */
export interface PasskeyRegistrationPayload {
  credential: PasskeyRegistrationResponse;
  name?: string;
  encrypted_root_key: import("./crypto").RootKeyWrap;
  current_password?: string;
  reauth_token?: string;
}

/** A current password or a passkey re-authentication proof, for the account-critical routes. */
export type AccountProof = { current_password: string } | { reauth_token: string };
