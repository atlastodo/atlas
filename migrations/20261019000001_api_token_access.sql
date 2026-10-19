-- API tokens that expire, and tokens that only read. An app's manifest may ask for both
-- (`api_tokens` in manifests/<app>.json: Atlas Vault requires an expiry at most 365 days out and
-- makes tokens read-only unless their creator opts in to writes); the server checks the policy
-- when a token is made. `expires_at` NULL never expires. Past `expires_at`, the token opens no
-- session and its open sessions are refused on their next request. A token without `can_write`
-- reaches only the read routes (GET, and the sync WebSocket ticket). Every token made before this
-- could write and never expires.
ALTER TABLE api_tokens
    ADD COLUMN expires_at TIMESTAMPTZ,
    ADD COLUMN can_write BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE api_tokens
    ADD CONSTRAINT api_tokens_expiry_after_creation CHECK (expires_at IS NULL OR expires_at > created_at);
