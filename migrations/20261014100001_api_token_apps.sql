-- API tokens scoped to apps. `apps` lists the suite apps a token carries keys for, and so the only
-- apps its sessions may sync; every token made before this was a todo token. The todo key (the
-- DEK) and identity stay in `wrapped_dek` / `wrapped_private_key` (NULL for a token without todo);
-- every other app's key and X25519 identity, wrapped under the token's wrapping key, live in
-- `app_keys` as {"<app>": {"wrapped_key": …, "wrapped_private_key": …}}. Revoking nulls them with
-- the todo wraps.
ALTER TABLE api_tokens
    ADD COLUMN apps TEXT[] NOT NULL DEFAULT '{todo}',
    ADD COLUMN app_keys JSONB;

ALTER TABLE api_tokens
    ADD CONSTRAINT api_tokens_apps_nonempty CHECK (cardinality(apps) > 0);
