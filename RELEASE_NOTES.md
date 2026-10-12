## v0.1.10

### Upgrade notes
- Compose now publishes the server on `127.0.0.1:8080` only. If clients reach port 8080 directly rather than through a reverse proxy on the same host, set `PORT_BIND=8080` in `.env` before upgrading.
- Clients older than this release read two new recurrence forms as invalid: a yearly rule due on Feb 29 (`BYMONTHDAY=29`), and a rule whose current occurrence sits in a DST gap (`BYHOUR`/`BYMINUTE`, dropped again at the next one). Update every client that shares such tasks.

### Features
- Import from Todoist (project CSV or backup zip)
- Ask for the account password before exporting data
- Keep rejected changes listed across restarts
- Configurable listen address (BIND_ADDR)
- Request ids in logs, a configurable pool, and poison-safe locks
- Open the admin panel as a Settings section
- Parse dates and repeats in every UI language
- Add German, Spanish, French, Italian, Dutch, Polish and Portuguese

### Fixes
- Don't let a malformed ZIP64 backup hang the Todoist import (fflate 0.8.3)
- Re-stamp queued edits after a clock-skew refusal
- Keep the grace-period export working, and limit IPv6 by /64
- Translate the task detail's date pills
- Opt out of Android backup
- Lock failed logins per address, and rate-limit invites
- End a revoked session's access token on its next request
- Publish the server on localhost only by default
- Keep leap days and DST-gap times instead of drifting
- Bound HLC counters so a pushed op cannot overflow the server clock
- Refuse self-updates whose checksum cannot be verified
- Replace a reinstalled app's old session instead of listing it

### Changes
- Re-render only the task rows that changed

### Documentation
- Socket handshake errors, close codes 1011 and 1013, 429s
- A sync protocol reference and the first design decision records
- A no-Nix setup, where PRs go, and first contributions
- Lead the README with the pitch, its limits and how it compares

### Maintenance
- 10 dependency updates, 11 maintenance commits (CI, build, tests) ([full list](https://github.com/atlastodo/atlas-todo/compare/v0.1.9...v0.1.10))
