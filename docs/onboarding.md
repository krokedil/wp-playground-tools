# Onboarding a plugin

Step-by-step guide for adopting `@krokedil/wp-playground-tools` in a plugin repo. For schema and command details see the [README](../README.md); for seed-data / screenshots / env-var reference see [reference.md](reference.md).

## 0. Prerequisites

- **pnpm >= 9.13** and git. Node is handled for you: `init` pins `use-node-version=20.19.0` in `.npmrc`, so pnpm downloads and uses the right Node automatically.
- The plugin's main PHP file carries a `Plugin Name:` header at the repo root — `init` infers the slug from it (falls back to the directory name).
- The install spec `#semver:^1` resolves against this repo's `vX.Y.Z` git tags; new releases are picked up with `pnpm update`.

## 1. Install and scaffold

```sh
pnpm add -D "@krokedil/wp-playground-tools@github:krokedil/wp-playground-tools#semver:^1"
pnpm exec krokedil-playground init
pnpm install
```

`pnpm add` resolves the `#semver:^1` range (you get the newest `v1.x.y` tag) but saves the dependency in `package.json` **without** it — a bare git URL that would track the default branch instead of releases. `init` corrects the saved spec back to `#semver:^1`, and the trailing `pnpm install` realigns the lockfile with it (skipping it fails `--frozen-lockfile` installs later).

`init` is idempotent and writes/merges the files listed in the [README install section](../README.md#install-per-plugin): the `tools/playground.mjs` shim, a starter `playground.config.mjs` (yours to edit — never overwritten), `package.json` scripts, `.claude/launch.json` preview entries, a marker-delimited "WP Playground" section in the plugin's `CLAUDE.md`, the Node pin, and ignore entries.

## 2. Claim a base port

Every mode listens on a port derived from `basePort`: `start` on `basePort`, `development` +1, `demo` +2, `e2e` +3, and `--https` proxies on the live port +400. So each plugin needs its own base to keep concurrent plugin development predictable.

1. Claim the next free row in the [port registry table](../README.md#port-registry) (edit the README in a small PR).
2. Set `basePort` in `playground.config.mjs`.

Until `basePort` is set, the tool warns on every run and falls back to `8880` — a port another plugin already claims. Ports still *work* when they collide (a prober picks the next free one), but predictable ports are what make bookmarks, launch entries, and "the demo store is on 8882" hold true.

## 3. Fill in `playground.config.mjs`

The generated config is a commented skeleton; the full schema lives in the [README](../README.md#playgroundconfigmjs-schema). Checklist:

- **`slug`** — verify the inferred value; every mount path derives from it.
- **`composer`** — defaults to `{ markers: ['vendor/autoload.php'] }` when `composer.json` exists. wpify-scoper plugins must add `'dependencies/autoload.php'` to the markers. Set `composer: null` for plugins without composer.
- **`build`** — point `markers` at your build output (e.g. `build/index.asset.php`) and `command` at the package script; omit entirely for plugins without a JS build.
- **`activate`** — plugins activated after install; defaults to `[slug]`. Add WooCommerce extensions you depend on.
- **`options` / `pages`** — settings and pages your plugin needs on a fresh site, per mode (`all` merges under each).
- **Secrets** (API keys, merchant IDs) never go in the config — read them from env vars via `envSecret()` with a gitignored `.env` locally; see [README — Private options](../README.md#private-options-api-keys).

A full-featured, real-world example (wpify-scoper markers, per-mode pages, custom seed data, screenshots, all four modes) is the returns-and-withdrawals fixture: [`tests/fixtures/rwwc.config.mjs`](../tests/fixtures/rwwc.config.mjs).

## 4. First boot

```sh
pnpm install
pnpm run playground:start
```

That installs composer + pnpm deps, builds assets (when configured), composes the blueprint, provisions a persistent site, and boots it. Log in with `admin` / `password`. The site is isolated per checkout (keyed by `sha256(cwd)`), so worktrees don't share state; warm boots preserve data and `--fresh` reprovisions. Logs and the SQLite database live under `~/.wordpress-playground/sites/<hash>/wp-content/` — see [README](../README.md#logs--database).

## 5. Optional pieces

- **Seed data** — development mode seeds a generic SE WooCommerce fixture (products, tax, coupons, shipping, order templates). To seed plugin-specific data, point `seedData` at a JSON file in your repo; the shape is documented in [reference.md](reference.md#seed-data-json).
- **PR screenshots** — set `screenshots: './tools/shots.config.mjs'`, add `@playwright/test` to the plugin's devDependencies, and run `pnpm exec playwright install chromium` once. Manifest shape in [reference.md](reference.md#screenshots-manifest).
- **`--tunnel`** (public URL for payment-provider callbacks) — install the `ngrok` binary, set an authtoken (`NGROK_AUTHTOKEN` or `ngrok config add-authtoken`), reserve a domain for `tunnel.domain` under the company ngrok account, and claim it in the README's tunnel domain registry so callback registrations don't go stale. Details in the [README](../README.md#--tunnel-public-url--payment-provider-callbackswebhooks).
- **`--https`** (local secure context) — `brew install mkcert && mkcert -install`.
- **e2e mode** — add `'e2e'` to `modes`, then run `pnpm exec krokedil-playground init --update` to get the `playground:server-e2e` script and launch entry.

## 6. Keeping up to date

New releases are picked up with `pnpm update` (the `#semver:^1` range follows git tags). After updating — or after changing `modes` or `basePort` — run:

```sh
pnpm exec krokedil-playground init --update
```

It re-stamps the generated files (shim, launch entries, scripts, Node pin) without touching your `playground.config.mjs`.
