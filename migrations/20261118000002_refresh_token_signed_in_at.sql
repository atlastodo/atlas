-- When the credential sign-in that started a refresh family happened, carried to every rotated row:
-- rotated rows are purged by retention, so the family's oldest row does not say. NULL for rows
-- from before this column, which never count as a recent sign-in.
ALTER TABLE refresh_tokens ADD COLUMN signed_in_at TIMESTAMPTZ;
