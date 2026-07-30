# @krokedil/wp-playground-tools

Shared WordPress Playground dev tooling for Krokedil WooCommerce plugins: one-command bootstrap, worktree-isolated persistent sites, generated blueprints, declarative WC seeding, PR screenshots, and HTTPS via an ngrok tunnel or a local mkcert proxy.

Onboarding a new plugin? Follow the step-by-step guide in [docs/onboarding.md](docs/onboarding.md). Seed-data / screenshots / env-var reference: [docs/reference.md](docs/reference.md).

## Install (per plugin)

```sh
pnpm add -D "@krokedil/wp-playground-tools@github:krokedil/wp-playground-tools#semver:^1"
pnpm exec krokedil-playground init
pnpm install
```

> **Why the trailing `pnpm install`:** `pnpm add` resolves the `#semver:^1` range (installing the newest `v1.x.y` tag) but saves the dependency in `package.json` *without* the range — a bare git URL that would track the default branch. `init` corrects the saved spec back to `#semver:^1`; the `pnpm install` realigns the lockfile with it. Skipping it leaves a lockfile/manifest mismatch that fails `--frozen-lockfile` installs.

npm-managed plugins use npm the same way (`npm i -D …` and `npm exec krokedil-playground init` — npm supports the `#semver:` git spec too, and keeps it on save). The tool picks the plugin's package manager exactly like Krokedil CI: from `packageManager` (or `devEngines.packageManager`) in package.json — **pnpm iff declared, npm otherwise**; lockfile presence is intentionally ignored. That drives every install/build the tool runs (`pnpm install --frozen-lockfile` vs `npm ci`, with a lockfile-repairing fallback) and what `init` scaffolds.

`init` scaffolds everything a plugin needs and is idempotent:

| File | Owned by | Notes |
|---|---|---|
| `tools/playground.mjs` | generated | bootstrap shim (Node built-ins only; installs `node_modules` when missing, then hands over to the package). Refresh with `init --update`. |
| `playground.config.mjs` | **the plugin** | the single per-plugin contract (schema below). Never overwritten. |
| `.claude/launch.json` | generated | preview entries per mode, `autoPort: true`. |
| `CLAUDE.md` | merged | a marker-delimited "WP Playground" section for Claude (commands, where the `--tunnel`/`--https` public URL lives, login, log/DB paths). Everything outside the markers is untouched. |
| `package.json` | merged | `playground:*` scripts, this dev dependency, `engines` + Node floor. `packageManager: pnpm@…` is stamped **only when init creates the file** — an existing package.json without the field is an npm plugin by the CI's detection rule, and stamping pnpm would flip its CI build. |
| `.npmrc` / `.nvmrc` | generated | Pin Node 22 LTS: `.npmrc` sets `use-node-version=22.23.2` (pnpm downloads/uses it for every run); `.nvmrc` holds the bare version for nvm. `.npmrc` is written for pnpm plugins only (npm ignores the setting; npm plugins get `.nvmrc`). |
| `.gitignore` / `.kernlignore` | appended | `.playground/` (generated blueprints + staged assets), `pr-screenshots/`. |

Then:

```sh
pnpm run playground:start
```

On a fresh clone/worktree that one command installs composer + Node deps (pnpm or npm, per the detection above), builds assets (when configured), composes the blueprint, provisions the site, and boots it. Warm boots preserve data; `--fresh` reprovisions.

Admin credentials are the Playground CLI defaults, `admin` / `password`. In development mode you rarely type them: a staged mu-plugin auto-submits the wp-login form as `admin` (including after `--fresh` wipes sessions), while guest storefront browsing and logging in as another user keep working. Auto-login only answers local requests — browsing via a `--tunnel` URL shows the normal login form, and there the default password is refused in favour of a [per-run tunnel password](#tunnel-logins-need-the-run-password), so the public URL never hands out admin sessions. See [docs/reference.md](docs/reference.md#defaults-and-development-mode-extras).

**Testing as a logged-out visitor** (development mode): add `?krokedil-guest=1` to any local URL, or click **Browse as guest** in the admin bar. That logs you out and keeps you out for 12 hours — necessary because WordPress renders front-end login links as plain `wp-login.php?redirect_to=…` GETs, which auto-login treats as "log me in", so one click on a comment form or the Meta widget would otherwise end the test and drop you in wp-admin. `?krokedil-guest=0` restores normal auto-login. It applies to the browser that asked (a second profile stays admin), and entering it clears the cart along with the session — what you want before a guest checkout run.

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
pnpm exec krokedil-playground credentials  # check envSecret() names; stub missing ones in ~/.config/krokedil-playground/.env
pnpm exec krokedil-playground init --update
```

Pass-through Playground CLI flags work as usual: `--xdebug`, `--phpmyadmin`, `--php=8.2`, `--wp=6.8`, `--port=9999`. **Do not put a literal `--` separator in pnpm scripts or invocations** — pnpm forwards a literal `--` that the playground CLI drops. (npm is the opposite: npm plugins **must** use the separator, e.g. `npm run playground:start -- --fresh`.)

Sites are isolated per checkout by `sha256(cwd)` under `~/.wordpress-playground/sites/`, and every mode auto-picks a free port (explicit `--port` > `PORT` env > probe from the mode default), so worktrees can run previews concurrently.

## `playground.config.mjs` schema

```js
export default {
	slug: 'my-plugin',                       // REQUIRED. Mount + all container paths derive from it.
	siteName: 'My Plugin',                   // default: title-cased slug
	siteTagline: null,                       // default: "<Mode> by Krokedil"
	landingPage: '/wp-admin/',               // development-mode landing page (demo/e2e always land on plugins.php)
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
	https: { hosts: ['localhost'] },         // mkcert SANs for --https (replaces the default; first entry is the URL host)
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

**Locally — the central file**: keep the values in `~/.config/krokedil-playground/.env`, one file shared by every plugin checkout and worktree (`NAME=value`; quotes, multi-line quoted values and `export` prefixes work). Seed it from the committed [`credentials.env.example`](credentials.env.example), or run `pnpm exec krokedil-playground credentials` in a plugin repo — it scans that plugin's config for `envSecret()` names and appends commented stubs for anything the file lacks (`init` does the same during onboarding). The tool loads the file before evaluating the config and never stores or prints values — warnings name variables only.

**Per-repo overrides**: a gitignored `.env` at the plugin root works exactly as before and overrides the central file for that checkout. Precedence: ambient env (shell exports, CI secrets) > plugin `.env` > main checkout `.env` (from linked git worktrees — untracked files don't transfer into them) > central file.

**CI**: store the values as GitHub repo secrets and map them onto the step that runs the playground:

```yaml
- run: pnpm run playground:server-development
  env:
    KLARNA_TEST_MERCHANT_ID: ${{ secrets.KLARNA_TEST_MERCHANT_ID }}
    KLARNA_TEST_SHARED_SECRET: ${{ secrets.KLARNA_TEST_SHARED_SECRET }}
```

A missing or empty variable (GitHub renders absent/fork-PR secrets as empty strings) prints one warning naming it, the option key is omitted, and the site boots unconfigured — provisioning never fails over a missing secret. Per-mode keys (test vs. prod) use the existing per-mode `options` shape.

⚠ Resolved values land in `.playground/blueprint.<mode>.json` (gitignored + kernlignored) and in the persistent site's SQLite database — use **sandbox/test credentials only**, never production keys. The persistent `start` site only re-reads secrets on provisioning: after changing one, run `start --fresh` (`server` modes reprovision every run).

## Transports (http, `--https`, `--tunnel`)

The transport is a **per-run flag, not per-plugin config**: the same plugin — and the same persistent site — runs plain, behind local https, or behind a public tunnel, chosen at each invocation and combinable with any mode (`playground:start --https`, `playground:server-development --tunnel`, …). `playground.config.mjs` only parameterizes them (`tunnel.domain`, `https.hosts`); it never forces one. Even a payment plugin that needs `--tunnel` for webhook work doesn't need it all day — pick the cheapest transport the task at hand needs:

| Working on | Run with | Why |
|---|---|---|
| Admin UI, settings pages, templates, most backend logic | *(no flag — plain http)* | Fastest, zero prerequisites, auto-login works |
| Checkout/purchase flow, `is_ssl()`-dependent behavior, gateway scripts/iframes that require https, secure-context browser APIs | `--https` | Real TLS locally (mkcert); auto-login still works; nothing public, no ngrok account |
| Provider webhooks/callbacks, redirects back from hosted payment pages, testing from a phone/other device | `--tunnel` | The outside world must reach the site; costs a password-gated login (auto-login is local-only) and reserved-domain hygiene. Inbound only — see the [outbound caveat](#-outbound-http-from-playground-is-flaky) |

Both proxy flags share one mechanism: the tool writes the public URL to `.playground/proxy-url.txt` and the always-staged `playground-proxy-url.php` mu-plugin filters `home`/`siteurl` to it at runtime (no DB writes — warm boots and later proxy-less boots are untouched; the file is removed on exit and defensively on every non-proxied launch). `is_ssl()` is true behind the proxy, so cookies, assets and mixed content behave — and switching transport between runs leaves no residue in the site.

One proxied run per worktree at a time: **every** launch clears `proxy-url.txt` (and the tunnel password) for that worktree, so starting a second mode while a `--tunnel`/`--https` run is live snaps the first site's URLs back to localhost and, for tunnels, locks its wp-admin (the guard fails closed, never open). Use a second worktree for that.

### `--tunnel` (public URL — payment-provider callbacks/webhooks)

```sh
pnpm run playground:start --tunnel
```

Requires the `ngrok` binary and an authtoken (`NGROK_AUTHTOKEN` — best set once in the central `~/.config/krokedil-playground/.env` — or `ngrok config add-authtoken`; the tool never stores it — ngrok holds it). **Use your personal authtoken under the Krokedil pay-as-you-go account** (dashboard.ngrok.com → Your Authtoken), not a free personal account: free accounts allow only 1 simultaneous agent session, which breaks running several tunnels at once, and can't serve reserved domains. Webhook URLs built from `home_url()` automatically use the tunnel URL.

**Reserve a domain for webhook work** (`tunnel.domain`): an ephemeral URL changes on every run, so callback registrations at the provider go stale. The tool warns loudly when tunneling without one. Reserve the domain at dashboard.ngrok.com/domains under the company account and claim it in the [tunnel domain registry](#tunnel-domain-registry).

**Parallel worktrees**: sites, ports and tunnels are per-worktree automatically (each worktree gets its own persistent site and auto-shifts to a free port). The one shared thing is the committed `tunnel.domain` — a second simultaneous tunnel on the same plugin needs `--tunnel-domain=<second-reserved-domain>` (stable webhooks; claim it in the registry) or `--tunnel-domain=none` (quick ephemeral URL). The flag implies `--tunnel`.

#### Tunnel logins need the run password

A tunnel URL is reachable by anyone who has it, and Playground's admin credentials are the documented default — so a plain `--tunnel` would leave `admin` / `password` one form submission away from the dashboard of a site holding your provider test keys. While a tunnel runs, the always-staged `playground-tunnel-guard.php` mu-plugin therefore refuses the default password for requests that didn't come from your machine, and accepts only that run's tunnel password (any user, wp-login and XML-RPC alike). Local logins, the development auto-login and PR screenshots are untouched, and the storefront, REST routes and webhook callbacks stay public — gating those is the whole reason for the tunnel.

The password is printed with the public URL. Set `KROKEDIL_PG_TUNNEL_PASS` (best in the central `~/.config/krokedil-playground/.env` — see [Private options](#private-options-api-keys) — or a shell profile / the plugin's gitignored `.env`) to use one password you already know across every Krokedil playground instead; it is then required but never echoed. Without it, each run generates a random one. The mechanism mirrors the proxy URL: `.playground/tunnel-password.txt`, removed on exit and before every launch, so a non-tunnelled site is never gated.

A site provisioned before this guard existed has no symlink to it, so `--tunnel` on such a warm `start` site refuses to launch and asks for one `--fresh` run. Guarded or not, a playground is a dev site — keep production keys and real customer data out (see [Private options](#private-options-api-keys)).

### `--https` (local only — secure-context features, no tunnel account)

```sh
pnpm run playground:start --https
```

Requires [mkcert](https://github.com/FiloSottile/mkcert) (`brew install mkcert && mkcert -install`). Runs a local https reverse proxy on `basePort+400` with a locally-trusted certificate.

### ⚠ Outbound HTTP from Playground is flaky

Playground (PHP-in-WASM) intermittently times out outbound HTTP requests after ~10s. A tunnel fixes *inbound* callbacks, but plugins calling real provider sandbox APIs *outbound* will see sporadic failures unrelated to their code. For serious real-API integration testing, use a conventional environment (wp-env / Docker) — keep Playground for UI/flow work, and consider mocking with `pre_http_request` in tests.

### ⚠ Emails never send — read them in Tools → Email Log

Playground's PHP-in-WASM has no mail transport (no sendmail binary or MTA), so PHP's `mail()` — and with it every `wp_mail()` call — fails. On a WooCommerce site this surfaces as order notes like `Email "Processing order" failed to send: Could not instantiate mail function.` — that's the platform, not the plugin under development. The development blueprint pre-activates [WP Mail Logging](https://wordpress.org/plugins/wp-mail-logging/), which records every attempted email (recipient, subject, full body) even though the send fails: **Tools → Email Log** (`/wp-admin/tools.php?page=wpml_plugin_log`).

## Port registry

Give each plugin a distinct `basePort` so concurrent plugin development doesn't rely on probing. Claim a row when you onboard a plugin:

| basePort | Plugin |
|---|---|
| 8880 | returns-and-withdrawals |
| 8890 | klarna-payments-for-woocommerce |
| 8900 | qliro-for-woocommerce |
| 8910 | *(next plugin here)* |
| 9880 | *(reserved: this repo's `sandbox/` dogfooding plugin)* |

8880 is also the tool's fallback when `basePort` is unset (returns-and-withdrawals claims it explicitly) — never rely on the fallback; the tool warns on every run until `basePort` is set.

## Tunnel domain registry

Reserve tunnel domains under the company ngrok pay-as-you-go account (dashboard.ngrok.com/domains) and claim a row per domain. Plugins under active parallel development may claim more than one (the extra ones are used via `--tunnel-domain=`):

| tunnel.domain | Plugin |
|---|---|
| *(none reserved yet — claim the first row when you reserve a domain)* | |

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
