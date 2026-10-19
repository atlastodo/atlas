-- Which suite apps (manifests/<app>.json) each account has enabled. Sync push refuses ops of a
-- kind whose app is not enabled for the account (or the instance, `ATLAS_APPS`), and pull and the
-- snapshot leave them out. `app` is a manifest id; the server checks it against the bundled
-- manifests, so there is no apps table to reference.
CREATE TABLE account_apps (
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    app TEXT NOT NULL,
    enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, app)
);

-- Every existing account has been using todo since it signed up.
INSERT INTO account_apps (user_id, app, enabled_at)
SELECT id, 'todo', created_at FROM users;

-- Todo is the suite's baseline app: every account gets it the moment it exists, whichever path
-- created the row. Other apps are enabled per account (`PUT /auth/apps/:app`).
CREATE FUNCTION account_apps_enable_todo() RETURNS trigger AS $$
BEGIN
    INSERT INTO account_apps (user_id, app) VALUES (NEW.id, 'todo')
    ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_enable_todo
AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION account_apps_enable_todo();
