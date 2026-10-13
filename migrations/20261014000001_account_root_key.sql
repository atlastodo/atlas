-- The account root key: a random 32-byte key above the per-app keys. The unlock slots wrap the
-- root (the password-derived MEK here, the recovery phrase in `recovery_encrypted_root_key`, later
-- passkeys); the root wraps one key per app in `account_app_keys`. The existing DEK is the `todo`
-- app's key unchanged, so nothing is re-encrypted.
--
-- `recovery_encrypted_root_key` takes one of two forms (see docs/architecture.md): wrapped under
-- the phrase-derived recovery key (`{v, iv, ct}`, written whenever the client holds the phrase), or
-- sealed to `recovery_public_key` (`{v, epk, iv, ct}`, written when an existing account migrates
-- at sign-in, where the phrase is not at hand).
--
-- Accounts created before this migration have neither; the client migrates them on the next
-- password sign-in or unlock (`POST /auth/root-key`). The legacy `encrypted_dek`,
-- `encrypted_private_key` and recovery wraps stay written alongside for older clients.
--
-- `root_key_created_at` says whether the account has a root key at all; the slots are nullable
-- because none of them is the root's existence: a later passkey slot (its own table, one row per
-- credential) may stand in for the password slot on a passkey-only account.
ALTER TABLE users
    ADD COLUMN root_key_created_at TIMESTAMPTZ,
    ADD COLUMN encrypted_root_key JSONB,
    ADD COLUMN recovery_encrypted_root_key JSONB;

-- One key per (account, app), wrapped under the root key. `wrapped_private_key` is the app's
-- X25519 identity wrapped under the app key (for `todo`, the account's existing keypair).
CREATE TABLE account_app_keys (
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    app TEXT NOT NULL CHECK (app ~ '^[a-z][a-z0-9_-]{0,31}$'),
    wrapped_key JSONB NOT NULL,
    wrapped_private_key JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, app)
);
