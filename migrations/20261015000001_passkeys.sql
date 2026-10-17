-- Passkeys: WebAuthn credentials that sign in and, through the PRF extension, unlock the account
-- root key. Each passkey is an unlock slot next to the password and recovery slots: the client
-- derives a 32-byte key from the passkey's PRF output (HKDF-SHA256, salt = the raw credential id,
-- info "atlas-passkey-slot-v1") and wraps the root under it (`encrypted_root_key`, slot
-- "passkey:<credential id>"). The PRF output never reaches the server.
--
-- An account may have no password at all (signed up with a passkey, or removed it later while a
-- passkey remains), so the credential hash becomes nullable. Such an account still has a salt, a
-- recovery key and its phrase; recovery sets a password.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE passkeys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- base64url (unpadded) of the raw credential id, as WebAuthn JSON carries it.
    credential_id TEXT NOT NULL UNIQUE,
    -- The credential as webauthn-rs stores it (`Passkey`: public key, algorithm, counter, flags).
    credential JSONB NOT NULL,
    -- Copies of what the list shows, kept in step with `credential` at each sign-in.
    sign_count BIGINT NOT NULL DEFAULT 0,
    transports TEXT[] NOT NULL DEFAULT '{}',
    backup_eligible BOOLEAN NOT NULL DEFAULT FALSE,
    backed_up BOOLEAN NOT NULL DEFAULT FALSE,
    -- The PRF extension's input (base64url) the slot key derives from. Every passkey uses the
    -- same constant today (a discoverable sign-in cannot know which passkey answers); stored so a
    -- later scheme can differ per credential.
    prf_salt TEXT NOT NULL,
    name TEXT NOT NULL,
    encrypted_root_key JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);

CREATE INDEX passkeys_user_idx ON passkeys (user_id);

-- Outstanding WebAuthn ceremonies: each challenge is answered once (DELETE … RETURNING) before it
-- expires. `user_id` is the account a ceremony is for (the client-chosen id of a signup), NULL for
-- a discoverable sign-in.
CREATE TABLE webauthn_challenges (
    challenge TEXT PRIMARY KEY,
    purpose TEXT NOT NULL CHECK (purpose IN ('signup', 'register', 'login', 'reauth')),
    user_id UUID,
    -- The ceremony state webauthn-rs verifies the answer against.
    state JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX webauthn_challenges_expires_idx ON webauthn_challenges (expires_at);

-- A fresh passkey assertion, exchanged for a short-lived single-use proof that stands in for the
-- current password on the account-critical routes. Only the token's SHA-256 is stored.
CREATE TABLE passkey_reauth_proofs (
    token_hash TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
);
