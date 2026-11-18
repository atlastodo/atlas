## v0.1.20

There is no v0.1.19 release: that tag was pushed by mistake to v0.1.18's commit, and nothing was built or published from it.

### Fixes
- Address CodeQL warnings on the audit fixes
- Require a fresh sign-in or the credential to install a signing key
- Check an entry's writer when a later key opens it
- Stop fresh devices from re-sealing forged legacy plaintext
- Drop served deletes of the key-trust state
- Count only an entitled writer's exact copy as covering a legacy key
- Keep a shared project's blobs bound to it
- Fan a shared-project op out only to members who hold it there
- Make an op id name one op across the server
- Stop todo API tokens from recovering accounts without a recovery key
- Give every email-first passkey answer the same shape
- Put public-key lookups on the per-user invite budget
- Keep non-todo API tokens off todo's sharing, key and blob routes
- Keep sessions revoked before a deletion out of the export
- Stop a creator who left a shared project from listing its members
- Stop signup id conflicts from revealing whether an email is taken
- Wait for the sync-write lock before taking a pool connection
- Keep junk-email login failures from locking out real accounts
- Cap login and recovery emails before the failure limiter

### Maintenance
- 9 dependency updates ([full list](https://github.com/atlastodo/atlas/compare/v0.1.18...v0.1.20))
