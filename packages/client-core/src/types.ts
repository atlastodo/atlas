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
  recovery_encrypted_dek?: { iv: string; ct: string };
  recovery_encrypted_private_key?: { iv: string; ct: string };
  /** 2 = phrase-derived recovery key, 1 = account private key (no recovery key yet). */
  recovery_key_version?: number;
  challenge?: RecoveryChallenge;
}

export interface ReplaceRecoveryKeyPayload {
  current_password: string;
  recovery_public_key: string;
  recovery_encrypted_dek: { iv: string; ct: string };
  recovery_encrypted_private_key: { iv: string; ct: string };
}

export interface RegisterRecoveryKeyPayload {
  current_password: string;
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
}

export interface ChangePasswordPayload {
  current_password: string;
  new_password: string;
  encrypted_dek: { iv: string; ct: string };
  encrypted_private_key: { iv: string; ct: string };
  recovery_encrypted_dek?: { iv: string; ct: string };
  recovery_encrypted_private_key?: { iv: string; ct: string };
  kdf_version?: number;
  kdf_params?: Record<string, number>;
  /** Same password, newer KDF: other sessions are kept. */
  kdf_upgrade?: boolean;
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
  encrypted_dek?: { iv: string; ct: string };
  encrypted_private_key?: { iv: string; ct: string };
  signing_public_key?: string;
  encrypted_signing_key?: { iv: string; ct: string };
  is_e2ee?: boolean;
  /** Absent from a server predating per-account KDFs (version 1). */
  kdf_version?: number;
  kdf_params?: Record<string, number>;
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
  created_at: number;
  last_used_at?: number;
}

/** `POST /auth/api-tokens`: a token the client generated, with its keys wrapped for it. */
export interface CreateApiTokenPayload {
  id: string;
  name: string;
  auth: string;
  wrapped_dek: { v: 1; iv: string; ct: string };
  wrapped_private_key: { v: 1; iv: string; ct: string };
}

/** `POST /auth/api-token/session`: an access token (no refresh token) and the token's wraps. */
export interface ApiTokenSessionResponse {
  access_token: string;
  expires_in: number;
  token_id: string;
  user_id: string;
  wrapped_dek: { v: 1; iv: string; ct: string };
  wrapped_private_key: { v: 1; iv: string; ct: string };
  public_key?: string;
  signing_public_key?: string;
  encrypted_signing_key?: { v: 1; iv: string; ct: string };
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
  /** Fields may be envelopes readable only with `sealed_key`. */
  project: { name: unknown; icon: unknown; color: unknown; kind: unknown };
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
  | "attachment";

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
