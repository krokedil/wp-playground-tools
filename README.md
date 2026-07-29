# @krokedil/wp-playground-tools

Shared WordPress Playground dev tooling for Krokedil WooCommerce plugins: one-command bootstrap, worktree-isolated persistent sites, generated blueprints, declarative WC seeding, PR screenshots, and HTTPS via an ngrok tunnel or a local mkcert proxy.

Onboarding a new plugin? Follow the step-by-step guide in [docs/onboarding.md](docs/onboarding.md). Seed-data / screenshots / env-var reference: [docs/reference.md](docs/reference.md).

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
| `CLAUDE.md` | merged | a marker-delimited "WP Playground" section for Claude (commands, where the `--tunnel`/`--https` public URL lives, login, log/DB paths). Everything outside the markers is untouched. |
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
pnpm run playground:server-e2e             # ephemeral, e2e fixture — needs 'e2e' in modes + init --update
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
	options: { all: {…}, development: {…}, demo: {…}, e2e: {…} },   // seeded options (per-mode, `all` merges under each; secrets via envSecret() — see below)
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

## Private options (API keys)

Non-public option values (API keys, merchant IDs, shared secrets) never go in `playground.config.mjs` — they come from env vars, read in the config via `envSecret()`:

```js
import { envSecret } from '@krokedil/wp-playground-tools';

export default {
	// …
	options: {
		all: {
			woocommerce_klarna_settings: {
				enabled: 'yes',
				testmode: 'yes',
				test_merchant_id: envSecret('KLARNA_TEST_MERCHANT_ID'),
				test_shared_secret: envSecret('KLARNA_TEST_SHARED_SECRET'),
			},
		},
	},
};
```

**Locally**: put the values in a gitignored `.env` at the plugin root (`NAME=value`; quotes, multi-line quoted values and `export` prefixes work). The tool loads it before evaluating the config. Already-set environment always wins over the file, and the tool never stores or prints values — warnings name variables only. Keep a committed `.env.example` with blank values so the needed names are discoverable.

**Git worktrees**: untracked files don't transfer into worktrees, so the main checkout's `.env` is found and used automatically from any linked worktree. Add a worktree-local `.env` only to override specific values (precedence: ambient env > worktree `.env` > main checkout `.env`).

**CI**: store the values as GitHub repo secrets and map them onto the step that runs the playground:

```yaml
- run: pnpm run playground:server-development
  env:
    KLARNA_TEST_MERCHANT_ID: ${{ secrets.KLARNA_TEST_MERCHANT_ID }}
    KLARNA_TEST_SHARED_SECRET: ${{ secrets.KLARNA_TEST_SHARED_SECRET }}
```

A missing or empty variable (GitHub renders absent/fork-PR secrets as empty strings) prints one warning naming it, the option key is omitted, and the site boots unconfigured — provisioning never fails over a missing secret. Per-mode keys (test vs. prod) use the existing per-mode `options` shape.

⚠ Resolved values land in `.playground/blueprint.<mode>.json` (gitignored + kernlignored) and in the persistent site's SQLite database — use **sandbox/test credentials only**, never production keys. The persistent `start` site only re-reads secrets on provisioning: after changing one, run `start --fresh` (`server` modes reprovision every run).

## HTTPS

Two flags, one mechanism: the tool writes the public URL to `.playground/proxy-url.txt` and the always-staged `playground-proxy-url.php` mu-plugin filters `home`/`siteurl` to it at runtime (no DB writes — warm boots and later proxy-less boots are untouched; the file is removed on exit and defensively on every non-proxied launch). `is_ssl()` is true behind the proxy, so cookies, assets and mixed content behave.

### `--tunnel` (public URL — payment-provider callbacks/webhooks)

```sh
pnpm run playground:start --tunnel
```

Requires the `ngrok` binary and an authtoken (`NGROK_AUTHTOKEN` env or `ngrok config add-authtoken`; the tool never stores it — ngrok holds it). **Use your personal authtoken under the Krokedil pay-as-you-go account** (dashboard.ngrok.com → Your Authtoken), not a free personal account: free accounts allow only 1 simultaneous agent session, which breaks running several tunnels at once, and can't serve reserved domains. Webhook URLs built from `home_url()` automatically use the tunnel URL.

**Reserve a domain for webhook work** (`tunnel.domain`): an ephemeral URL changes on every run, so callback registrations at the provider go stale. The tool warns loudly when tunneling without one. Reserve the domain at dashboard.ngrok.com/domains under the company account and claim it in the [tunnel domain registry](#tunnel-domain-registry).

**Parallel worktrees**: sites, ports and tunnels are per-worktree automatically (each worktree gets its own persistent site and auto-shifts to a free port). The one shared thing is the committed `tunnel.domain` — a second simultaneous tunnel on the same plugin needs `--tunnel-domain=<second-reserved-domain>` (stable webhooks; claim it in the registry) or `--tunnel-domain=none` (quick ephemeral URL). The flag implies `--tunnel`.

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
| 9880 | *(reserved: this repo's `sandbox/` dogfooding plugin)* |

8880 is also the tool's fallback when `basePort` is unset (returns-and-withdrawals claims it explicitly) — never rely on the fallback; the tool warns on every run until `basePort` is set.

## Tunnel domain registry

Reserve tunnel domains under the company ngrok pay-as-you-go account (dashboard.ngrok.com/domains) and claim a row per domain. Plugins under active parallel development may claim more than one (the extra ones are used via `--tunnel-domain=`):

| tunnel.domain | Plugin |
|---|---|
| *(first domain here)* | |

## Logs / database

Persistent sites live at `~/.wordpress-playground/sites/<sha256(cwd)>/wp-content/`: `debug.log` (development mode enables `WP_DEBUG_LOG`), `uploads/wc-logs/*.log` (WooCommerce logger), and the SQLite database at `database/.ht.sqlite` (open with `sqlite3` or any SQLite GUI — Playground has no MySQL). Ephemeral `server` runs only stream errors to the terminal. `--phpmyadmin` installs a SQLite-adapted phpMyAdmin on any mode.

## Developing this package

```sh
pnpm install
pnpm test        # node:test — includes blueprint parity + golden tests
pnpm run lint
```

Dogfood against the committed `sandbox/` plugin — no consumer repo needed:

```sh
pnpm run sandbox:http    # ephemeral development server on :9881
pnpm run sandbox:https   # + mkcert reverse proxy on https://localhost:10281
pnpm run sandbox:ngrok   # + ngrok tunnel (public URL printed)
pnpm run sandbox:start   # persistent worktree-isolated site on :9880
```

The sandbox's dashboard widget and `GET /wp-json/krokedil-sandbox/v1/ping` echo `home_url()`, `is_ssl()` and the forwarded headers, so each transport is verifiable at a glance. `.claude/launch.json` carries preview entries for the three server variants.

### Releases

Merging and releasing are decoupled: consumers only ever see git tags (`#semver:^1` never resolves against `main`), so any number of PRs can accumulate before a release.

1. **Every PR** adds its changelog bullets under `## Unreleased` in `CHANGELOG.md` — no version bump in feature PRs (the release type isn't known until the batch is complete, and bumps conflict between parallel PRs).
2. **To release**, one commit on `main`: rename `Unreleased` to `## X.Y.Z — <date>` (major/minor/patch based on what actually accumulated), bump `version` in `package.json` to match, then:

   ```sh
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

   Optionally `gh release create vX.Y.Z` with the changelog section as notes.
3. Consumers pick it up via `pnpm update` (the `^1` range resolves against tags; a major bump requires consumers to update their dependency spec deliberately).

Smoke-test `@wp-playground/cli` pin bumps before tagging — a bad pin fans out to every plugin.
