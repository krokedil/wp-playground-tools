# Onboarding a plugin

Step-by-step guide for adopting `@krokedil/wp-playground-tools` in a plugin repo. For schema and command details see the [README](../README.md); for seed-data / screenshots / env-var reference see [reference.md](reference.md).

## 0. Prerequisites

- **pnpm >= 9.13 or npm**, matching the plugin, and git. The tool picks the manager the same way Krokedil CI does: from `packageManager` (or `devEngines.packageManager`) in package.json — pnpm iff declared, npm otherwise (lockfiles are ignored). For pnpm plugins Node is handled for you: `init` pins `use-node-version=22.23.2` in `.npmrc`, so pnpm downloads and uses the right Node automatically. npm plugins get `.nvmrc` only — any Node >=20.19 works (`.nvmrc` pins 22 LTS for nvm users).
- The plugin's main PHP file carries a `Plugin Name:` header at the repo root — `init` infers the slug from it (falls back to the directory name).
- The install spec `#semver:^1` resolves against this repo's `vX.Y.Z` git tags; new releases are picked up with `pnpm update`.

## 1. Install and scaffold

```sh
pnpm add -D "@krokedil/wp-playground-tools@github:krokedil/wp-playground-tools#semver:^1"
pnpm exec krokedil-playground init
pnpm install
```

`pnpm add` resolves the `#semver:^1` range (you get the newest `v1.x.y` tag) but saves the dependency in `package.json` **without** it — a bare git URL that would track the default branch instead of releases. `init` corrects the saved spec back to `#semver:^1`, and the trailing `pnpm install` realigns the lockfile with it (skipping it fails `--frozen-lockfile` installs later).

For an npm plugin (npm keeps the `#semver:` range on save, so no trailing install is needed):

```sh
npm i -D "@krokedil/wp-playground-tools@github:krokedil/wp-playground-tools#semver:^1"
npm exec krokedil-playground init
```

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
- **Secrets** (API keys, merchant IDs) never go in the config — read them from env vars via `envSecret()`. Name them `<ABBR>_<OPTION>`, where `<ABBR>` is the plugin's abbreviation uppercased — the same identifier behind `<ABBR>_LOCAL_DIR`, and the one you claimed in the port registry in step 2 (`kp` → `KP_TEST_MERCHANT_ID_SE`). Never invent a local prefix: the central env file is shared by every plugin, and these same names become the plugin's GitHub secrets — if the plugin has no abbreviation yet, get one assigned in the internal CI plugin registry. Locally the values live in the central `~/.config/krokedil-playground/.env` (shared by all plugins; a per-repo gitignored `.env` overrides it) — `pnpm exec krokedil-playground credentials` stubs the names your config reads into it. Also add the names to [`credentials.env.example`](../credentials.env.example) in this repo via PR, so the whole fleet's credentials stay discoverable in one place. See [README — Private options](../README.md#private-options-api-keys).

A full-featured, real-world example (wpify-scoper markers, per-mode pages, custom seed data, screenshots, all four modes) is the returns-and-withdrawals fixture: [`tests/fixtures/rwwc.config.mjs` on GitHub](https://github.com/krokedil/wp-playground-tools/blob/main/tests/fixtures/rwwc.config.mjs) (`tests/` isn't shipped in the installed package, so the link points at the repo).

## 4. First boot

```sh
pnpm install
pnpm run playground:start
```

(npm plugins: `npm install && npm run playground:start`, and forward any extra flags after a `--` separator — `npm run playground:start -- --fresh`.) That installs composer + Node deps, builds assets (when configured), composes the blueprint, provisions a persistent site, and boots it. If you have no GitHub token configured for composer, private `krokedil/*` packages each print `Could not authenticate against github.com … Now trying to download from source` — that's composer's expected fallback to git clone, not a failure (the bootstrap prints a heads-up saying so); `composer config -g github-oauth.github.com <token>` silences it and makes installs faster. Visiting wp-admin logs you in as `admin` automatically (the login form auto-submits in development mode, also after a `--fresh` reprovision); the credentials are `admin` / `password` whenever you do need them — after logging out, in demo/e2e modes, or to sign in as a different user via `wp-login.php?action=login`. To test the site as a logged-out visitor, add `?krokedil-guest=1` to any URL (or click **Browse as guest** in the admin bar) — that logs you out and stops auto-login for 12 hours in that browser, so front-end login links can't quietly sign you back in; `?krokedil-guest=0` undoes it. Browsing via a `--tunnel` URL is the exception: auto-login is local-only, and because that URL is public the tunnel guard refuses `password` there and requires the run's tunnel password instead (printed with the public URL, or your own `KROKEDIL_PG_TUNNEL_PASS`) — see the [README](../README.md#tunnel-logins-need-the-run-password). The site is isolated per checkout (keyed by `sha256(cwd)`), so worktrees don't share state; warm boots preserve data and `--fresh` reprovisions. Logs and the SQLite database live under `~/.wordpress-playground/sites/<hash>/wp-content/` — see [README](../README.md#logs--database).

Don't be alarmed by order notes saying `Email "…" failed to send: Could not instantiate mail function.` — Playground can't send mail at all. Attempted emails (with full content) are captured by the pre-activated wp-mail-logging plugin under **Tools → Email Log**; see the [README caveat](../README.md#-emails-never-send--read-them-in-tools--email-log).

## 5. Optional pieces

- **Seed data** — development mode seeds a generic SE WooCommerce fixture (products, tax, coupons, shipping, order templates). To seed plugin-specific data, point `seedData` at a JSON file in your repo; the shape is documented in [reference.md](reference.md#seed-data-json).
- **PR screenshots** — set `screenshots: './tools/shots.config.mjs'`, add `@playwright/test` to the plugin's devDependencies, and run `pnpm exec playwright install chromium` once. Manifest shape in [reference.md](reference.md#screenshots-manifest).
- **Transports** — plain http covers admin and most backend work; the two flags below are per-run additions, not a per-plugin commitment, so pick the cheapest one the task needs — even a payment plugin only needs `--tunnel` for inbound-callback work. Decision table in the [README](../README.md#transports-http---https---tunnel).
- **`--https`** (local secure context — checkout flows, `is_ssl()`-dependent behavior) — `brew install mkcert && mkcert -install`.
- **`--tunnel`** (public URL for payment-provider callbacks) — install the `ngrok` binary, set an authtoken (`NGROK_AUTHTOKEN` or `ngrok config add-authtoken`), and set `tunnel: { provider: 'ngrok', domain: '*.krokedil.ngrok.io' }` — the company wildcard, which gives this plugin (and each of its worktrees) its own stable host with nothing to reserve. Details in the [README](../README.md#--tunnel-public-url--payment-provider-callbackswebhooks).
- **e2e mode** — add `'e2e'` to `modes`, then run `pnpm exec krokedil-playground init --update` to get the `playground:server-e2e` script and launch entry.

## 6. Keeping up to date

New releases are picked up with `pnpm update` (the `#semver:^1` range follows git tags). After updating — or after changing `modes` or `basePort` — run:

```sh
pnpm exec krokedil-playground init --update
```

It re-stamps the generated files (shim, launch entries, scripts, Node pin) without touching your `playground.config.mjs`.

**Migrating an npm plugin scaffolded before package-manager detection**: older `init` versions stamped `packageManager: "pnpm@…"` and `engines.pnpm` onto every package.json, which flips the plugin's CI build from npm to pnpm. If that happened to an npm plugin, delete those two fields by hand (`init --update` never removes user fields) and run `npm exec krokedil-playground init --update` to refresh the shim and launch entries.
