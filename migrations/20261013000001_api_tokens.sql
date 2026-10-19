-- Personal API tokens for integrations (n8n, scripts). The token string never reaches the server:
-- the client derives an auth value from its secret (HKDF, "atlas-pat-auth-v1") and the server
-- stores only that value's hex SHA-256, like invite codes. The client also wraps a copy of the
-- account's DEK and X25519 private key under a second key derived from the secret
-- ("atlas-pat-wrap-v1"), which `POST /auth/api-token/session` hands back to the token holder.
-- Revoking nulls the wraps, so a token string that leaks later no longer reaches the keys.
CREATE TABLE api_tokens (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    auth_hash TEXT NOT NULL UNIQUE,
    wrapped_dek JSONB,
    wrapped_private_key JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX api_tokens_live_user_idx ON api_tokens (user_id) WHERE revoked_at IS NULL;
