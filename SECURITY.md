# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue or pull request.

[Open a private advisory](https://github.com/atlastodo/atlas-todo/security/advisories/new) through
GitHub's private vulnerability reporting.

Include a description, the affected version or commit, and steps or a proof of concept. Once a fix
is released, you are credited in the release notes and the advisory if you want to be.

### What happens next

Atlas Todo has one maintainer, who reads every report.

- **Within 7 days:** an acknowledgement in the advisory.
- **Within 14 days:** an assessment: whether it is a vulnerability, how severe (CVSS), and a plan.
- **The fix** ships in a patch release (a new Docker tag, APK and desktop tarball). The advisory
  is then published on GitHub, with a CVE requested through GitHub when it applies, and linked
  from the release notes. Self-hosters learn of it there and from GitHub's security alerts.
- **Disclosure:** please keep the details private until the fix is released, or for 90 days from
  your report, whichever comes first. If a fix needs longer, we agree on a date in the advisory.

## Supported versions

Atlas Todo is pre-1.0. Only the latest release gets security fixes. Please check that the
problem exists in the latest release (or on `main`) before you report it.

The design and the code have not had an independent security audit.

## Verifying a release

Release files (APK, AAB, desktop tarball) and the container image carry GitHub build provenance
attestations, which show they were built by this repository's release workflow from the tagged
commit:

```sh
gh attestation verify atlas-todo-X.Y.Z.apk --repo atlastodo/atlas-todo
gh attestation verify oci://ghcr.io/atlastodo/atlas-todo:X.Y.Z --repo atlastodo/atlas-todo
```

The attestation is on the GitHub Container Registry image; the Docker Hub mirror is the same
image but carries none. Each release also lists `SHA256SUMS.txt`, which the desktop app checks before it installs an
update, and the image carries an SBOM. Releases before 0.1.10 have no attestations.

## Scope

- The server (`crates/atlas-server`): authentication and sessions, key distribution, sync,
  attachments and the admin API.
- The clients: local stores, the sync client and the encryption (`packages/client-core`,
  `apps/mobile`, `apps/electron`).
- The container image and compose setup (`docker/`, `compose.yaml`).

## Threat model

Atlas Todo assumes the server may be curious. An operator, or someone who stole a database dump,
should not be able to read your tasks. It does not assume the server is fully hostile; see
[Known limitations](#known-limitations).

How the cryptography works is in [docs/architecture.md](./docs/architecture.md#end-to-end-encryption).
This page lists what it protects.

### What the server cannot see

- Every field value is encrypted on the device with AES-256-GCM before it syncs, unless the
  field is on the plaintext list below. That covers titles, notes, dates, priorities,
  recurrence, project, section and label names, comments, reminders, saved filters,
  preferences, focus sessions and habits.
- Attachments are encrypted with a fresh key per file, and file names and types are encrypted
  too.
- A field that nobody has put on the plaintext list is encrypted by default.
- Each value is authenticated together with its entity type and id, its field name and the key
  scope. The server cannot move a value to another field, task or project and have it open.
- Values are padded to a size bucket, so size does not tell `true` from `false`, or a short
  title from a slightly longer one.
- Your password and master key never leave the device. The server stores only a hash of a login
  value derived from it.
- The server has no copy of your recovery phrase.

### What the server can see

- Your email address, account dates and sessions.
- For every change: the entity type and id, the field name, the time of the edit and the size
  bucket of the value.
- Field names include those of the key trust records, which name the projects you accepted or
  shared, the members you invited and the accounts whose keys you pinned or verified. The server
  knows who shares projects with you anyway.
- Project membership: who shares which project, with which role.
- Public keys and wrapped (encrypted) keys.
- Attachment sizes and the SHA-256 of each encrypted blob.
- Bug reports, which carry diagnostics only and no task content.
- Request IP addresses, which the rate limiters hold in memory. They are not stored in the
  database.

### Fields that stay plaintext, and why

The list lives in the `plaintext_fields` of each kind in
[`manifests/todo.json`](./manifests/todo.json), the todo app manifest that the server and the
clients both bundle. Atlas Journal's manifest ([`manifests/journal.json`](./manifests/journal.json))
lists none: every journal field is encrypted, and journal data never leaves your own account's
partition (journal has no sharing).
The client encrypts by it, and the server checks that every field value it reads is on it.

| Entity         | Plaintext fields                                          | Why                                                                          |
| -------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| task           | `project_id`, `assignee_id`                               | the server copies shared-project ops to members and checks access            |
| section        | `project_id`                                              | same fan-out and access check                                                |
| comment        | `task_id`                                                 | routes the comment to the task's project members                             |
| activity       | `task_id`, `actor_id`                                     | routes the feed entry and names who made the change                          |
| attachment     | `task_id`, `blob_sha`, `thumb_sha`, `wrapped_key`, `meta` | routing and blob addressing; `wrapped_key` and `meta` are already ciphertext |
| project_member | all                                                       | written by the server itself                                                 |

All other entities (project, label, preference, saved filter, reminder, focus session, habit,
habit check-in) have no plaintext fields.

### Recovery phrase

- Signup shows a 24-word recovery phrase (BIP-39). If you forget your password, the phrase is
  the only way back. The server sends no reset emails and cannot decrypt your data.
- Lose both the password and the phrase and the data is gone.
- If you lose the phrase or think someone has seen it, create a new one in Settings while signed
  in. The old phrase stops working at once. Anyone who knows your password can do the same, so
  if you suspect that, change the password first.

### Keys the server hands out

The server distributes project keys, names each project's canonical key and lists members with
their public keys. The app does not trust that on its own. It acts only within what you did, and
keeps a record of your decisions as encrypted, synced preferences that the server cannot forge.

- A project key sealed to you is loaded only for a project whose invite you accepted.
- A key you minted when you shared a project stays that project's canonical key, whatever the
  server names.
- A public key is pinned the first time you see it, when you invite someone. The project key is
  sent only to pinned members and only to that key. A member whose key changed is shown as
  "encryption key changed" and gets nothing until you remove and re-invite them.
- Identity keys of every account are pinned on first sight. A differing key is never adopted,
  and the deliveries it signs are refused.
- Owners sign every key delivery. The app loads a delivery only if the signature verifies under
  the signer's pinned key.
- The app moves a value to another key only within one project. It never re-encrypts a personal
  value for a project, or one project's value for another, unless you share a project or move a
  task.
- When someone who held a project's key leaves it, the key is rotated and the new one goes,
  signed, to the remaining members. The app never goes back to a retired key.

Trust on first use means a server that swaps in its own keys at the moment you first see a
member would not be noticed. Safety numbers close that gap: compare the number the share dialog
shows with the member in person or on a call, then mark them verified. The mark is dropped if
their keys change. A member you have not verified is only as trustworthy as the server was when
you first saw them.

### API tokens

An API token (Settings → API tokens) holds a key that opens your account's DEK, so whoever
holds it can read and change everything you can, as plaintext, on their own machine. The server
still cannot. It stores only a hash of the token's auth value and the keys wrapped under a secret
it never receives.

- A token cannot reach the account-critical routes: password, recovery, sessions, tokens,
  deletion, export and admin.
- Revoking a token, recovering the account or scheduling its deletion drops its wrapped keys at
  once.
- Someone who copied a token's wrapped keys and its secret before the revocation keeps what they
  decrypted, as with any device that had your data.
- Treat a token like your password. See [docs/integrations.md](./docs/integrations.md).
- A token opens only the apps it was made for (todo unless you chose otherwise). It carries a
  copy of those apps' keys and no other, never the account root key, and its sessions are refused
  sync for any other app. Token sessions are refused on every route that reads or writes the root
  or the app keys.

### Account root key

Your password and your recovery phrase each unlock one account root key, a random key that the
server only ever stores wrapped. The root key in turn wraps one key per Atlas app; the todo app's
key is the data key your account always had, so nothing was re-encrypted when the root key was
introduced. Details in [docs/architecture.md](./docs/architecture.md#account-root-key).

- Enabling another app (Atlas Journal) creates that app's key and X25519 identity on your device
  and stores them wrapped under the root key. The todo key never wraps another app's key, so a
  todo API token cannot open journal data.
- Each app's client syncs only its own app's data (`x-atlas-sync-apps`). This limits what each
  app holds on a device; it is not a boundary against the server, which stores every app's
  ciphertext in one log per account.

- Accounts created before the root key get one on their next sign-in or unlock, on the device.
  The recovery phrase is not needed for that: the device seals the root key to your phrase's
  public key, which only the phrase can open. Because anyone can seal to a public key, recovery
  accepts that root only if it opens the same data key the phrase itself recovers, so a server
  cannot slip in a root key of its own.
- Accounts without a phrase-derived recovery key (very old accounts that have not confirmed their
  phrase) have no recovery copy of the root key until they confirm it. Recovering such an account
  creates a new root key over the same data key.
- Until all supported clients know the root key, the data key and your X25519 key are also still
  stored wrapped directly under your password and phrase (the pre-root-key layout). Those copies
  are deprecated and will be removed in a later release.

### Passkeys

When the server has passkeys on, a passkey can sign you in and unlock your data, next to or
instead of a password. Details in [docs/architecture.md](./docs/architecture.md#passkeys).

- A passkey unlocks through the WebAuthn PRF extension: your device derives a key from the
  passkey's PRF output and the root key is stored wrapped under it. The PRF output never leaves
  the device, so the server holds a passkey's public key and a wrapped root it cannot open.
  Passkeys without PRF are refused.
- A passkey-only account has no password at all. Its recovery phrase is the fallback, and a
  recovery sets a password. Where passkeys do not work (iOS and the desktop app today), such an
  account cannot sign in.
- Actions that need your password (changing it, a new recovery phrase, deleting the account,
  adding or removing a passkey) take a fresh passkey confirmation instead: a single-use proof that
  expires after five minutes. A session opened with an API token cannot reach any passkey route.
- Adding a passkey needs the password or another passkey, so a stolen session alone cannot add a
  way into the account.
- Recovery and a scheduled deletion remove every passkey; remove them from your password manager
  too.
- Attestation is not checked: the server does not restrict which authenticator holds a passkey.

### Upgrading from a pre-public build

Installs from before the first public release migrate automatically. The first sync of the updated
app rewrites old-format values in the current bound format and records the key trust baseline from
the keys the device holds; the next password sign-in moves a PBKDF2 account to Argon2id. Until that finishes, the server could
move an old-format value between fields under the same key, and a PBKDF2 login hash is cheaper to
brute-force. Fresh installs are not affected.

### Known limitations

- A rotation protects what is written after it. A removed member keeps the keys they had and can
  still decrypt older content they obtain later, for example from a database leak. Until an
  owner's app, which has to be online, has rotated the key, members keep writing under the old
  one.
- The server cannot read your data, but a malicious one can attack its integrity. It cannot move
  an encrypted value to another field, item or project. It can drop or replay operations,
  including an older value of the same field, delete items and change the plaintext fields.
- The key trust records are ordinary synced data. The server can withhold them or delete the
  preference that holds them. That only delays new records on an existing device, but a new
  device that never receives them loads no project keys.
- Attachments added by older versions have file keys not bound to the attachment, so the server
  can copy one onto another attachment under the same key. When you share or move the item, the
  app re-wraps the key for the new scope and it is bound from then on.
- The web app is served by the server. Whoever controls the server controls the JavaScript the
  browser runs and could steal keys from web users. The Android and desktop apps bundle their
  own code.
- Android builds with Expo Updates enabled fetch JavaScript updates from the Expo project named
  by `ATLAS_EAS_PROJECT_ID`. Builds made with `ATLAS_EAS_PROJECT_ID=none` never do.
- Metadata is visible: when you are active, how many items you have and which fields you edit.
- The app does not encrypt data on your devices. Each client keeps synced data unencrypted in its
  local database (SQLite on Android and iOS, IndexedDB in the browser and desktop app) and
  relies on the app sandbox and device encryption. Signing out deletes the database, after
  warning about unsynced changes, and deleting the account always does. The Android app opts out
  of Android backup, so that database is never copied to a cloud or adb backup.
- In the browser, session tokens are in `localStorage` and the unlocked keys are wrapped under a
  non-extractable WebCrypto key in IndexedDB. A copy of the profile yields the keys, and an XSS
  bug can unwrap them while the page is open. The desktop app wraps the keys with the OS key
  store through Electron's `safeStorage`, so a copy of the profile alone does not open them, but
  other programs running as you may. On Linux without a keyring it falls back to the browser's
  wrap. See [the architecture notes](./docs/architecture.md#key-storage-on-the-client).
- The recovery phrase on the clipboard is marked sensitive on Android and cleared after a
  minute, but clipboard managers, iOS Universal Clipboard and keyboards that ignore the flag may
  keep a copy. Writing the phrase down is safer.
- A password change re-wraps the data key and does not rotate it.
- The salt lookup names an account's KDF, so for PBKDF2 accounts it also shows that the account
  exists.

## Not vulnerabilities

- Anonymous bug reports. `POST /reports` accepts unauthenticated callers on purpose, so a crash
  before sign-in can still be reported. It takes an allow-listed diagnostics payload and is
  rate-limited per IP (`REPORT_RATE_LIMIT_*`). Set `BUG_REPORTS_ENABLED=false` to turn it off.
- Open CORS. The API uses bearer tokens, not cookies, so allowing any origin (the default when
  `CORS_ALLOWED_ORIGINS` is unset) is safe and intended.
- Placeholders in `.env.example`. The server refuses to start with an empty, short or known
  placeholder `JWT_SECRET`.

## Running your own instance

- Serve it over TLS, set a random `JWT_SECRET` (`openssl rand -hex 32`), and keep PostgreSQL off
  the public internet.
- Behind a reverse proxy, set `AUTH_RATE_LIMIT_TRUST_FORWARDED=true` so the per-IP limits see
  real client addresses. Only do this if the proxy is the only way to reach the server, because
  clients can forge `X-Forwarded-For` otherwise.
- Back up both the database and the attachment storage. Attachments are end-to-end encrypted, so
  a lost blob cannot be recovered from anywhere else.
