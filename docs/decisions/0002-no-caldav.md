# 0002: No CalDAV

## Decision

The server does not offer CalDAV (or any other standard task protocol). Calendar and task apps
cannot sync with it directly.

## Why

CalDAV clients read and write plaintext iCalendar on the server. Atlas Todo's server holds only
ciphertext and no keys, so it has nothing to serve. Offering CalDAV would mean either decrypting on
the server, which gives up the main property of the project, or a separate CalDAV bridge that runs
where the keys are (on a device) and talks to local apps. The second is possible later but is a
client feature, not a server one.

## Costs

- No sync with Thunderbird, DAVx⁵, Apple Reminders and similar.
- Getting data in and out goes through the app: a JSON export and restore, and importers
  (TickTick today).
