# Changelog

## 1.0.0 — unreleased

Initial release, extracted from returns-and-withdrawals' `tools/` setup.

- One-command bootstrap + launcher (`start`, `server <mode>`, `setup`) with
  marker-keyed prerequisites (composer / pnpm / JS build), Node 20 provisioning
  guard, worktree site isolation and automatic port resolution.
- Blueprints generated from `playground.config.mjs` via a shared step library
  (WooCommerce baseline, demo store cascade, debug plugin bundle, declarative
  seeding), staged with runtime assets under `.playground/`.
- `--tunnel` (ngrok, pluggable) and `--https` (mkcert + local reverse proxy)
  via the `playground-proxy-url.php` runtime mu-plugin — no DB writes.
- Parallel-worktree tunnels: `--tunnel-domain=<host|none>` overrides the
  committed `tunnel.domain` per run (second reserved domain, or an ephemeral
  URL); `tunnel.domain` is validated as a bare hostname; ngrok failures now
  surface the agent's own error lines plus actionable hints for the common
  `ERR_NGROK_*` codes (authtoken, session limit, domain conflicts).
- PR screenshot + collage engine (Playwright) driven by a per-plugin manifest.
- `init` scaffolder for onboarding plugins (`--update` refreshes generated files).
- Changes vs the original in-plugin tooling: env vars renamed `RWWC_*` →
  `KROKEDIL_PG_*`; `@wp-playground/cli@3.1.29` is a packaged dependency instead
  of an inline `npx` pin; the e2e blueprint is opt-in (`modes`); blueprint page
  creation is idempotent `runPHP` instead of `wp post create`.
