<!-- Base branch: `dev`, not `main`. If GitHub opened this against `main`, change the base above. -->

## What and why

<!-- What does this change, and why? Link the issue it addresses: "Fixes #123". PRs target `dev`, where
GitHub ignores that keyword, so also put "Fixes #123" in the commit message body: the issue then closes
when the commit reaches `main` with the next stable release. -->

## How it was tested

<!-- Commands you ran and what you checked by hand. -->

## Checklist

- [ ] The PR targets `dev`.
- [ ] The PR title follows Conventional Commits (`feat:`, `fix(server):`, …).
- [ ] A commit that fixes an issue says `Fixes #N` in its message body.
- [ ] `lint` and `test:all` pass in `devenv shell` (or the matching per-package commands).
- [ ] New behaviour is covered by tests, or I explained above why not.
- [ ] No version was hand-edited (releases use `version:bump`).
- [ ] No secrets or personal data are included.
