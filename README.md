# @krokedil/wp-playground-tools

Shared WordPress Playground dev tooling for Krokedil WooCommerce plugins: one-command bootstrap, worktree-isolated persistent sites, generated blueprints, declarative WC seeding, PR screenshots, and HTTPS via an ngrok tunnel or a local mkcert proxy.

## Install (per plugin)

```sh
pnpm add -D "@krokedil/wp-playground-tools@github:krokedil/wp-playground-tools#semver:^1"
pnpm exec krokedil-playground init
```

`init` scaffolds everything a plugin needs and is idempotent:

| File | Owned by | Notes |
|---|---|---|
| `tools/playground.mjs` | generated | bootstrap shim (Node built-ins only; installs `node_modules` when missing, then hands over to the package). Refresh with `init --update`. |
| `playground.config.mjs` | **the plugin** | the single per-plugin contract (schema below). Never overwritten. |
| `.claude/launch.json` | generated | preview entries per mode, `autoPort: true`. |
| `package.json` | merged | `playground:*` scripts, this dev dependency, `engines` + Node pin. |
| `.npmrc` / `.nvmrc` | generated | `use-node-version=20.19.0` — the Playground CLI's `--reset` breaks on Node 22+. |
| `.gitignore` / `.kernlignore` | appended | `.playground/` (generated blueprints + staged assets), `pr-screenshots/`. |

Then:

```sh
pnpm run playground:start
```

On a fresh clone/worktree that one command installs composer + pnpm deps, builds assets (when configured), composes the blueprint, provisions the site, and boots it. Warm boots preserve data; `--fresh` reprovisions.

## Commands

```
pnpm run playground:start [-- is never needed — pnpm forwards flags directly]
pnpm run playground:start --fresh          # reprovision this worktree's site
pnpm run playground:server-development     # ephemeral, dev blueprint
pnpm run playground:server-demo            # ephemeral, seeded demo store
pnpm run playground:setup                  # prerequisites only
pnpm run screenshots                       # PR screenshot collage (needs @playwright/test)
pnpm exec krokedil-playground compose      # write the generated blueprints for inspection
pnpm exec krokedil-playground init --update
```

Pass-through Playground CLI flags work as usual: `--xdebug`, `--phpmyadmin`, `--php=8.2`, `--wp=6.8`, `--port=9999`. **Do not put a literal `--` separator in pnpm scripts or invocations** — pnpm forwards a literal `--` that the playground CLI drops.

Sites are isolated per checkout by `sha256(cwd)` under `~/.wordpress-playground/sites/`, and every mode auto-picks a free port (explicit `--port` > `PORT` env > probe from the mode default), so worktrees can run previews concurrently.

## `playground.config.mjs` schema

```js
export default {
	slug: 'my-plugin',                       // REQUIRED. Mount + all container paths derive from it.
	siteName: 'My Plugin',                   // default: title-cased slug
	siteTagline: null,                       // default: "<Mode> by Krokedil"
	landingPage: '/wp-admin/',               // development-mode landing page
	basePort: 8880,                          // start; modes get +1/+2/+3 — see the port registry below
	php: '8.3',
	wp: null,                                // string for all modes, or { development, demo, e2e }; default beta/latest/beta
	composer: { markers: ['vendor/autoload.php'] },        // default when composer.json exists; add
	                                         // 'dependencies/autoload.php' for wpify-scoper plugins; null = skip
	build: { markers: ['build/index.asset.php'], command: 'build' }, // omit for plugins without a JS build
	woocommerce: true,                       // install WC + org baseline store options
	store: { country: 'SE', currency: 'SEK', timezone: 'Europe/Stockholm' },
	activate: ['my-plugin'],                 // plugins activated after install (default: [slug])
	options: { all: {…}, development: {…}, demo: {…}, e2e: {…} },   // seeded options (per-mode, `all` merges under each)
	pages: { all: […], development: […] },   // pages created on provisioning ({ title, slug, content })
	muPlugins: { development: ['tools/my-dev-helper.php'] },        // plugin-local mu-plugins staged + linked
	seedData: 'tools/seed-data.json',        // development WC fixture; default: the package's SE fixture
	demoFixture: true,                       // demo/e2e get a simple product + 3 orders
	extraSteps: { demo: [ /* raw blueprint step objects */ ] },     // escape hatch — appended verbatim
	modes: ['start', 'development', 'demo'], // e2e is opt-in
	screenshots: './tools/shots.config.mjs', // omit to disable the screenshots command
	tunnel: { provider: 'ngrok', domain: 'my-plugin.eu.ngrok.io' }, // domain optional but recommended
	https: { hosts: ['localhost'] },         // mkcert SANs for --https
};
```

Schema-creep rule: new config keys only for things **three or more plugins** need. Everything else is `extraSteps` (raw [blueprint steps](https://wordpress.github.io/wordpress-playground/blueprints/steps)).

## HTTPS

Two flags, one mechanism: the tool writes the public URL to `.playground/proxy-url.txt` and the always-staged `playground-proxy-url.php` mu-plugin filters `home`/`siteurl` to it at runtime (no DB writes — warm boots and later proxy-less boots are untouched; the file is removed on exit and defensively on every non-proxied launch). `is_ssl()` is true behind the proxy, so cookies, assets and mixed content behave.

### `--tunnel` (public URL — payment-provider callbacks/webhooks)

```sh
pnpm run playground:start --tunnel
```

Requires the `ngrok` binary and an authtoken (`NGROK_AUTHTOKEN` env or `ngrok config add-authtoken`; the tool never stores it). Webhook URLs built from `home_url()` automatically use the tunnel URL.

**Reserve a domain for webhook work** (`tunnel.domain`): a free-tier URL changes on every run, so callback registrations at the provider go stale. The tool warns loudly when tunneling without one.

### `--https` (local only — secure-context features, no tunnel account)

```sh
pnpm run playground:start --https
```

Requires [mkcert](https://github.com/FiloSottile/mkcert) (`brew install mkcert && mkcert -install`). Runs a local https reverse proxy on `basePort+400` with a locally-trusted certificate.

### ⚠ Outbound HTTP from Playground is flaky

Playground (PHP-in-WASM) intermittently times out outbound HTTP requests after ~10s. A tunnel fixes *inbound* callbacks, but plugins calling real provider sandbox APIs *outbound* will see sporadic failures unrelated to their code. For serious real-API integration testing, use a conventional environment (wp-env / Docker) — keep Playground for UI/flow work, and consider mocking with `pre_http_request` in tests.

## Port registry

Give each plugin a distinct `basePort` so concurrent plugin development doesn't rely on probing. Claim a row when you onboard a plugin:

| basePort | Plugin |
|---|---|
| 8880 | returns-and-withdrawals |
| 8890 | *(next plugin here)* |

## Logs / database

Persistent sites live at `~/.wordpress-playground/sites/<sha256(cwd)>/wp-content/`: `debug.log` (development mode enables `WP_DEBUG_LOG`), `uploads/wc-logs/*.log` (WooCommerce logger), and the SQLite database at `database/.ht.sqlite` (open with `sqlite3` or any SQLite GUI — Playground has no MySQL). Ephemeral `server` runs only stream errors to the terminal. `--phpmyadmin` installs a SQLite-adapted phpMyAdmin on any mode.

## Developing this package

```sh
pnpm install
pnpm test        # node:test — includes blueprint parity + golden tests
pnpm run lint
```

Releases: bump `version`, update `CHANGELOG.md`, tag `vX.Y.Z`, push the tag. Consumers pick the release up via `pnpm update` (the `#semver:^1` range resolves against git tags). Smoke-test `@wp-playground/cli` pin bumps before tagging — a bad pin fans out to every plugin.
