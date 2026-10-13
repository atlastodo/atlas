# @atlastodo/cli

The `atlas` command for [Atlas Todo](https://github.com/atlastodo/atlas-todo), for scripts and
automation tools such as n8n. It signs in with a personal API token from **Settings → API
tokens** and decrypts your account on the machine it runs on, so your data stays end-to-end
encrypted.

```sh
export ATLAS_URL=https://app.atlastodo.dev ATLAS_TOKEN=atlas_pat_… ATLAS_TZ=Europe/Copenhagen
npx @atlastodo/cli tasks list --filter "today | overdue"
npx @atlastodo/cli tasks quick "Pay rent tomorrow #Home p1"
npx @atlastodo/cli changes --since 1234
```

Run `atlas --help` for every command. The full guide, with n8n recipes, is
[docs/integrations.md](https://github.com/atlastodo/atlas-todo/blob/main/docs/integrations.md).

License: AGPL-3.0-only.
