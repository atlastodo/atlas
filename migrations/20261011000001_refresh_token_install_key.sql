-- A refresh-token family can carry the hash of the client's install key: an identifier that
-- survives uninstalling and reinstalling the app on the same device (Android ID, an iOS keychain
-- value). Signing in with a key signs out the user's older families holding the same one, so a
-- reinstall replaces its row in Settings -> Devices & sessions instead of adding another.
ALTER TABLE refresh_tokens ADD COLUMN install_key_hash TEXT;
CREATE INDEX refresh_tokens_install_key_idx
    ON refresh_tokens (user_id, install_key_hash)
    WHERE install_key_hash IS NOT NULL AND revoked_at IS NULL;
