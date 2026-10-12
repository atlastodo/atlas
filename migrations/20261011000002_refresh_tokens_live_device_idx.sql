-- Every authenticated request checks that its device still has a live refresh family
-- (`authenticate_bearer`). Rotated and revoked rows are kept for REFRESH_TOKEN_RETENTION_DAYS, so
-- without this index the check filters all of a user's past tokens to find the live one.
CREATE INDEX refresh_tokens_live_device_idx
    ON refresh_tokens (user_id, device_id)
    WHERE revoked_at IS NULL;
