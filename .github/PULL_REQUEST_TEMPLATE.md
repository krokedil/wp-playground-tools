<!-- What does this change, and why? A consumer-facing summary beats a file list. -->

## Checklist

- [ ] Changelog bullet added under `## Unreleased` in `CHANGELOG.md` (skip only for repo-internal changes consumers never see)
- [ ] `version` in `package.json` **not** bumped — that happens in the release commit
- [ ] Golden blueprint fixtures (`tests/fixtures/rwwc-*.json`) updated deliberately, not regenerated blindly (if touched)
