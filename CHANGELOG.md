# Changelog

## Unreleased

- Fix: `pnpm exec krokedil-playground …` was a silent no-op under pnpm — the
  bin stub passes a node_modules symlink as argv[1], so the direct-execution
  guard never matched; entry paths are now realpath-compared. (Found
  onboarding klarna-payments-for-woocommerce.)

## 1.1.0 — 2026-07-29

- Private options (API keys) via env vars: zero-dependency `.env` loading at the
  plugin root (ambient env wins; linked git worktrees fall back to the main
  checkout's `.env`) and an `envSecret()` helper for configs — missing/empty
  vars warn by name and omit the option instead of failing the boot.
- Parallel-worktree tunnels: `--tunnel-domain=<host|none>` overrides the
  committed `tunnel.domain` per run (second reserved domain, or an ephemeral
  URL); `tunnel.domain` is validated as a bare hostname; ngrok failures now
  surface the agent's own error lines plus actionable hints for the common
  `ERR_NGROK_*` codes (authtoken, session limit, domain conflicts).
- Standalone dogfooding: committed `sandbox/` plugin + config, `sandbox:*`
  scripts (http / https / ngrok / persistent start on basePort 9880) and
  `.claude/launch.json` preview entries — no consumer repo needed. The sandbox
  dashboard widget and `GET /wp-json/krokedil-sandbox/v1/ping` echo transport
  diagnostics.
- `init` refuses to run inside this package itself (it would inject a
  self-referential git dependency and rewrite the repo's own files).
- `init` maintains a marker-delimited "WP Playground" section in the
  consumer's `CLAUDE.md` (commands, where the `--tunnel`/`--https` public URL
  lives, login, log/DB paths) so Claude sessions in plugin repos know the
  workflow; everything outside the markers is preserved.
- `ensurePrereqs` skips `pnpm install` for roots without a `package.json`,
  and fails actionably when `build` is configured without one.
- Dev tooling: `CLAUDE.md`, prettier (`format`/`format:check`,
  `@wordpress/prettier-config`), `.editorconfig`, `lint:fix`, and `php -l`
  over all shipped PHP in CI.
- CI: fixed the smoke job's pnpm setup (the subdirectory checkout hid the
  `packageManager` field from `pnpm/action-setup`) — the job now actually
  boots the fixture plugin.
- `init` derives scripts and `.claude/launch.json` entries from `config.modes`,
  so opting into e2e (+ `init --update`) adds `playground:server-e2e` and its
  preview entry.
- Loud stderr warning when `basePort` is unset — the 8880 fallback collides
  with returns-and-withdrawals' claimed port. **Follow-up for rwwc:** add
  `basePort: 8880` to its `playground.config.mjs` to silence the warning.
- Docs: step-by-step onboarding guide (`docs/onboarding.md`) and a reference
  for seed data, the screenshots manifest, and env vars (`docs/reference.md`);
  `playground-seeder.php`'s header now documents the package's auto-staging
  instead of the stale rwwc-era copy/symlink instructions.

## 1.0.0 — 2026-07-29

Initial release, extracted from returns-and-withdrawals' `tools/` setup.

- One-command bootstrap + launcher (`start`, `server <mode>`, `setup`) with
  marker-keyed prerequisites (composer / pnpm / JS build), Node 20 provisioning
  guard, worktree site isolation and automatic port resolution.
- Blueprints generated from `playground.config.mjs` via a shared step library
  (WooCommerce baseline, demo store cascade, debug plugin bundle, declarative
  seeding), staged with runtime assets under `.playground/`.
- `--tunnel` (ngrok, pluggable) and `--https` (mkcert + local reverse proxy)
  via the `playground-proxy-url.php` runtime mu-plugin — no DB writes.
- PR screenshot + collage engine (Playwright) driven by a per-plugin manifest.
- `init` scaffolder for onboarding plugins (`--update` refreshes generated
  files).
- Changes vs the original in-plugin tooling: env vars renamed `RWWC_*` →
  `KROKEDIL_PG_*`; `@wp-playground/cli@3.1.29` is a packaged dependency instead
  of an inline `npx` pin; the e2e blueprint is opt-in (`modes`); blueprint page
  creation is idempotent `runPHP` instead of `wp post create`.
