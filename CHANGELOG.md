# Changelog

## Unreleased

- Registry bookkeeping for onboarding instabox-for-woocommerce: `basePort`
  8950 claimed in the port registry with abbreviation `instabox`, and the
  plugin's `INSTABOX_API_KEY` / `INSTABOX_API_SECRET` /
  `INSTABOX_CUSTOMER_NUMBER` names documented in `credentials.env.example`.
  The example `basePort` in the scaffolded config and the README schema block
  move to 8960, the registry's next free row at the time.

## 1.4.0 — 2026-09-02

- `init` now appends the whole committed scaffold to `.kernlignore`
  (`tools/playground.mjs`, `CLAUDE.md`, `.nvmrc`, `.claude` + `.claude/**/*`),
  not just `.playground`/`playground.config.mjs`/`.env` — Kernl packages
  release ZIPs by that file, so on Kernl-distributed plugins the scaffold
  would otherwise ship in the plugin ZIP (Copilot review on
  partial-delivery-for-woocommerce PR 43). Already-onboarded plugins get the
  entries by rerunning `init --update` (or `init`); `ensureLines` only adds
  what is missing.
- Bootstrap shim v3: the install-failure message no longer says "install
  \<manager\> and retry" when the manager is present and the install itself
  failed (network, auth, integrity, peer deps). A spawn error (manager not on
  PATH / not executable) now bails immediately with an "install \<manager\>"
  hint — retrying a missing binary was pointless — while a non-zero exit
  reports the exit code and points at the install output above, which already
  says why. A signal-terminated install (OOM kill, external kill) is likewise
  reported as such instead of falling through as "exit null", and is not
  retried. Consumers pick the new shim up with `init --update`. (Copilot
  review on klarna-payments-for-woocommerce PR 589.)
- A `wp` of `beta` (the development/e2e default) now falls back to `latest`
  when wordpress.org offers no beta/RC build — the window between a final
  release and the next beta cycle. The Playground CLI resolves `beta` by
  scanning the version-check offers and, finding none, falls through to
  `wordpress.org/wordpress-beta.zip`: a 404 whose 18-byte body it saves and
  tries to unzip, so every cold development boot died with "Could not unzip
  file. Error code: 19. File size: 18 bytes." (first seen when WP 7.1 shipped
  on 2026-08-19 and the 7.1 betas disappeared; it took the CI smoke job with
  it). The check asks the same version-check API the CLI uses, caches the
  answer for 6 hours next to the plugin-zip cache, and keeps `beta` with a
  warning when the API is unreachable. An explicit `wp` version is never
  second-guessed.
- Registry bookkeeping for onboarding paytrail-for-woocommerce: `basePort` 8920
  claimed in the port registry with abbreviation `paytrail`, and the plugin's
  `PAYTRAIL_TEST_MERCHANT_ID` / `PAYTRAIL_TEST_SECRET_KEY` names documented in
  `credentials.env.example`.
- Registry bookkeeping for onboarding partial-delivery-for-woocommerce:
  `basePort` 8930 claimed in the port registry with abbreviation `wpd` (no
  credentials — the plugin talks to no external API). The example `basePort`
  in the scaffolded config and the README schema block move to 8940, the
  registry's next free row at the time.
- Registry bookkeeping for onboarding cargonizer-connect: `basePort` 8940
  claimed in the port registry with abbreviation `cargonizer`, and the plugin's
  `CARGONIZER_TEST_API_KEY` / `CARGONIZER_TEST_SENDER_ID` /
  `CARGONIZER_TEST_PROFILE_ID` names documented in `credentials.env.example`.
  The example `basePort` in the scaffolded config and the README schema block
  move on to 8950, the registry's new free row.

## 1.3.0 — 2026-07-31

- Order numbers on a playground site are now prefixed with the checkout's
  **site id** (`c345befa-38`), the first 8 characters of the same `sha256(cwd)`
  digest that keys the persistent site and the wildcard tunnel host. Gateways
  send the order number to the provider as the order's merchant reference
  (Qliro's `MerchantReference`, Klarna's `merchant_reference1`) and every fresh
  site starts at 1, so two checkouts sharing a provider's test merchant
  collided the moment both placed an order — the provider rejected the second
  (`Order with reference '38' already exists`) and the purchase failed. Since
  the prefix is the tunnel host's id, a reference in a provider's portal now
  names the site that produced it. A `--fresh` renumbers the site from 1 and
  would re-send references it already used, so each reprovision advances a
  counter (`c345befa-2-38`); warm boots never move the token, because some
  gateways compare a stored reference against the order number later.

  Mechanically: a new always-staged `playground-order-prefix.php` mu-plugin
  filters `woocommerce_order_number` at priority 5 — below plugins that build
  their own numbers from the parent's, such as returns-and-withdrawals at
  10000 — reading `.playground/site-id.txt`, and is inert without it. Display
  only; order IDs are untouched, so lookups by ID are unaffected. Existing
  persistent sites link the new mu-plugin on their next `--fresh`.

  `krokedil-playground site-id` prints this checkout's id (no config needed, so
  it answers before a first boot too); `site-id <id>` resolves one back to the
  checkout that produced it — accepting the prefix exactly as it reads off an
  order. Every launch upserts `~/.config/krokedil-playground/sites.json` with
  the checkout's path, slug and the branch **as of that boot**: an id names a
  path, and a path outlives the branch checked out in it, so recording it at
  boot is the only way to answer "which branch placed this order" later. The
  registry is a convenience — an unwritable `$HOME` or CI runner never fails a
  launch over it.

- Documented the credential-variable naming rule: `<ABBR>_<OPTION>`, where
  `<ABBR>` is the plugin's abbreviation in Krokedil CI's plugin registry,
  uppercased — the same identifier behind `<ABBR>_LOCAL_DIR` and the plugin's
  GitHub secret names. The convention was already what `credentials.env.example`
  followed (`KP_`, `QLIRO_`, `KCO_`) and what CI expects, but nothing said so,
  and the README's `envSecret()` examples taught invented names
  (`KLARNA_TEST_MERCHANT_ID`) that would have collided in the shared central env
  file and never matched a repo secret. The rule now lives in the README's
  private-options section, the onboarding guide, and the header of
  `credentials.env.example`; the port registry gained an `Abbr` column, so a
  plugin claims its port and its credential prefix in one PR.

- `tunnel.domain` accepts a **wildcard** (`*.krokedil.ngrok.io`, reserved once
  for the company account), and each checkout derives its own host under it:
  `<slug>-<8 hex of sha256(cwd)>` — the same digest that keys the persistent
  site. Parallel worktrees can now tunnel simultaneously with no flags and no
  bookkeeping, and each URL is *stable* for its worktree, so provider callback
  registrations keep working. This replaces "reserve a domain per plugin": the
  README's tunnel domain registry is now only for plugins that need a fixed
  hostname because a provider portal stores it.

  The old advice could not work. Omitting the domain does **not** yield a
  random URL — ngrok binds the account's single default domain, so a second
  worktree collided with `ERR_NGROK_334` and the error hint recommended
  `--tunnel-domain=none`, which lands in the same place. (Random URLs are a
  paid-plan feature, `--url 'https://'`, and silently fall back when the
  account lacks the entitlement.) The hint and the docs now say so.

- `pnpm run lint` and `pnpm run format:check` now ignore `.claude/worktrees/`,
  so keeping git worktrees inside the checkout no longer drowns the real
  output. A nested worktree is a whole copy of this repo, and ignore patterns
  are relative to the ignore file — `src/init/templates/` matched only the
  top-level copy, so every worktree re-reported the deliberately unformatted
  shipped templates (six worktrees ≈ 130 eslint errors and 5 prettier
  warnings, none of them from this repo's own files). CI never saw it, since a
  clean checkout has no nested worktrees.

- The section heading that `credentials` writes into the central env file now
  always comes from the config's real `slug`, never from one inside a comment.
  The scaffolded config ships a commented `pages:` example carrying
  `slug: 'checkout-test'`, and only its position kept that out of the shared
  file: the real `slug` sits earlier, and the first match wins. Each scan now
  strips comments for itself — `scanEnvSecretNames()` internally for the
  names, and `credentials` a separate copy for the slug.

## 1.2.3 — 2026-07-30

- The `envSecret()` scan behind `credentials` (and behind `init`) now strips
  line and block comments before looking for names, so commented-out examples
  no longer count as configuration. Every fresh onboard used to hit this: the
  scaffolded config's commented `envSecret('MY_TEST_SECRET')` example was
  scanned as a real call, so `init` reported it missing and appended a bogus
  `MY_TEST_SECRET` stub — under that plugin's own heading — to
  `~/.config/krokedil-playground/.env`, the file shared by every plugin
  checkout, to be deleted by hand afterwards. The strip is a quote-aware walk,
  so `'https://…'` and `// see 'X'` are each read the right way round.

- Registry bookkeeping for onboarding qliro-for-woocommerce and
  klarna-checkout-for-woocommerce: `basePort` 8900 and 8910 claimed in the port
  registry, and the plugins' `QLIRO_TEST_API_KEY` / `QLIRO_TEST_API_SECRET` and
  `KCO_TEST_MERCHANT_ID_EU` / `KCO_TEST_SHARED_SECRET_EU` names documented in
  `credentials.env.example`.
- The example `basePort` in the scaffolded config *and* in the README's schema
  block now both point at the registry's free row (8920), and a test pins them
  there. Claiming a port used to leave the examples pointing at it: 8890 was
  klarna-payments' row (fixed in 1.2.0, see below), and 8900 then 8910 became
  qliro's and klarna-checkout's. The README schema example was the worse of the
  two — it was 8880, returns-and-withdrawals' row, and copying it *sets*
  `basePort`, so the "unset basePort" warning never fired and the collision was
  silent. The test parses the registry table, so the next claim fails CI until
  both examples and the "next plugin here" row move together.
- The `credentials.env.example` blocks no longer assert that a gateway's "Test
  mode" is on by default: this repo can't test another repo's runtime defaults,
  so the claim could rot silently. Both the qliro and klarna-checkout entries now
  just say the credentials are used when Test mode is on.

## 1.2.2 — 2026-07-30

- Generated blueprints now disable WordPress's background automatic updater
  (`AUTOMATIC_UPDATER_DISABLED`, written into the site's `wp-config.php` so
  warm boots keep it). Playground sites are throwaway and version-pinned, so
  a background core/plugin/translation update never helps — and it actively
  breaks the CLI's multi-worker runtime: the updater's file churn in one PHP
  worker desyncs the other workers' views of the shared site filesystem
  (observed: minutes of every-request fatals over a `.maintenance` file that
  no longer exists), and its write burst lands on the same SQLite database
  the other workers are serving. Existing persistent sites pick this up on
  their next `--fresh`. A manual stress harness ships as
  `scripts/stress-db.mjs` (fresh boot → concurrent login/logout write burst
  → `PRAGMA integrity_check`) to catch regressions of this class.

- Development mode no longer enables the Playground CLI's own auto-login
  (`start` now passes `--no-login` — the CLI defaults it to on — and the
  development blueprint sets `login: false`). That auto-login is per client:
  every request without its marker cookie gets a full admin login plus a 302
  back to itself, so cookie-less clients — curl probes, health checks, CI
  smoke tests — looped until max-redirects while writing a new session row
  on every pass (needless concurrent SQLite writes on a multi-worker
  server). The staged `playground-dev-login.php` mu-plugin is now the only
  login magic locally: visiting wp-admin still signs you in as `admin`,
  `?krokedil-guest=1/0` still works, and demo/e2e blueprints keep
  `login: true` (browser sessions that hold cookies, landing logged-in on
  plugins.php). Cookie-less `curl -L` of `/` and `/wp-json` now returns 200.

## 1.2.1 — 2026-07-30

- The central credentials file (`~/.config/krokedil-playground/.env`) is now
  chmodded owner-only (0600) on every `credentials`/`init` run that finds or
  writes it — `writeFileSync`'s mode is masked by the caller's umask, so
  without an explicit chmod the file holding API keys could be created
  world-readable on multi-user machines. A permissive file created by 1.2.0
  is tightened even when there are no new stubs to append, and
  `credentials.env.example` now tells copiers to `chmod 600` their copy.

## 1.2.0 — 2026-07-30

**Upgrade notes** — `#semver:^1` consumers get all of this on a plain `pnpm update`:

- `--tunnel` on a warm persistent site provisioned before the tunnel admin
  guard existed now **refuses to launch** and asks for one `--fresh` run —
  which resets that worktree's site data. Plan the reprovision before you need
  the tunnel.
- npm-based plugins stamped by an older `init` must hand-delete the stamped
  `packageManager` + `engines.pnpm` from `package.json` (see
  `docs/onboarding.md`), then run `init --update` to pick up the new shim.

- Central credentials file: `~/.config/krokedil-playground/.env` is now loaded
  as the lowest-priority env source, so one local file holds the `envSecret()`
  credentials (and `NGROK_AUTHTOKEN` / `KROKEDIL_PG_TUNNEL_PASS`) for every
  plugin checkout and worktree. Precedence: ambient env > plugin `.env` > main
  checkout `.env` > central file; the "loaded N value(s)" message now names
  the source file. A new `krokedil-playground credentials` subcommand (also
  run by `init`) statically scans `playground.config.mjs` for `envSecret()`
  names, reports which are set, and appends commented stubs for missing ones
  to the central file. The committed `credentials.env.example` documents the
  fleet's credential names — onboarding a plugin now includes adding its names
  there via PR.
- Repo-internal workflow polish (nothing consumer-visible): opened PRs get an
  automatic Copilot review request, CI runs superseded by a newer push to the
  same PR are cancelled, a PR template reminds about the changelog convention,
  and a release-guard workflow fails a `vX.Y.Z` tag push whose version doesn't
  match `package.json` and the changelog heading.
- Docs: transport decision guide. The README's HTTPS section is now
  "Transports" and opens with a which-transport-for-which-work table (plain
  http for admin/backend work, `--https` for checkout/secure-context flows,
  `--tunnel` only for inbound callbacks), stressing that the transport is a
  per-run flag orthogonal to modes — even a payment plugin doesn't need the
  tunnel all day. The same guidance landed in the scaffolded CLAUDE.md section
  and docs/onboarding.md, and the config template gained the previously
  undocumented `https: { hosts: […] }` example. Consumers pick it up with
  `init --update`.
- `--tunnel` runs now gate wp-admin behind a per-run password. A tunnel URL is
  reachable by anyone who has it, and the admin credentials are the documented
  Playground default — verified against a live ngrok tunnel, `admin` /
  `password` logged straight into the dashboard of a site holding provider test
  keys. The always-staged `playground-tunnel-guard.php` mu-plugin now refuses
  the default password for requests that didn't come from the developer's
  machine (loopback Host and REMOTE_ADDR, same trust rule as the dev
  auto-login) and accepts only the run's tunnel password, printed with the
  public URL or taken from `KROKEDIL_PG_TUNNEL_PASS` for a login that is the
  same on every playground. It also sets Playground's auto-login marker for
  those requests: that auto-login authenticates on a cookie with no password
  check, and while it isn't armed in the modes this tool runs today
  (@wp-playground/cli 3.1.x), a future CLI must not be able to hand admin
  sessions to the public URL. The password lives in
  `.playground/tunnel-password.txt` (removed on exit and before every launch),
  so non-tunnelled sites, local logins, the dev auto-login and `screenshots`
  are untouched, and the storefront, REST routes and webhook callbacks stay
  public. `--tunnel` on a warm persistent site provisioned before the guard
  existed now refuses to launch and asks for one `--fresh` run rather than
  publishing an ungated site.
  The gate is keyed on the request coming from off this machine, not on the
  password file existing, and no remote login is possible when that file is
  missing or unreadable — every way it can go missing (a restrictive umask, a
  crash, a second launch in the same worktree clearing it while the first run's
  tunnel is still up) would otherwise leave the default password working on a
  public URL. Both runtime contract files are chmodded after writing for the
  same reason: `writeFileSync`'s mode is masked by the caller's umask, so
  `umask 077` produced files the Playground runtime reads as unreadable — the
  guard then found no password, and `proxy-url.txt` left the site on localhost
  URLs. A failure while publishing the URL now also takes the proxy back down
  instead of leaving a stray ngrok agent holding the reserved domain.
- Development mode gained a guest toggle for logged-out testing:
  `?krokedil-guest=1` on any local URL (or **Browse as guest** in the admin bar)
  logs out and sets a 12-hour cookie that stands both the dev auto-login and
  Playground's own auto-login down; `?krokedil-guest=0` restores them. Logging
  out was not enough on its own — WordPress renders front-end login links as
  plain `wp-login.php?redirect_to=…` GETs, which the auto-login below treats as
  "log me in", so a click on a comment form or the Meta widget silently ended
  the test and redirected into wp-admin. The toggle is per browser (a second
  profile stays admin), ignored for non-local requests (over a tunnel the
  tunnel guard owns login behavior), and clears the WooCommerce cart along with
  the session. No customer account is seeded: this covers logged-out testing,
  not logged-in-customer testing.
- Fix: the explicit chmod on the two runtime contract files now covers
  everything staged into `.playground/` — the mu-plugins, the seeder's
  `seed-data.json` and the pre-downloaded plugin zips — through one shared
  `src/runtime-file.mjs`, which also gives the staging directories themselves
  mode 0755 so a runtime on another uid can traverse into them at all. Files
  needed it for a second reason besides the umask: `copyFileSync` inherits the
  *source* file's mode, so a checkout whose files are 0600 staged owner-only
  mu-plugins no matter how permissive the developer's umask was. The generated
  blueprint keeps default permissions — the host CLI reads it, not the site,
  and it can carry private options from `.env` — as does the host-side zip
  download cache under `~/.config`, which is not read from inside the runtime.
- Development mode now stages a `playground-dev-login.php` mu-plugin that
  auto-submits any plain GET of wp-login.php as `admin`. The Playground CLI's
  own auto-login is single-shot per client — a curl health check or tool probe
  consumes it, leaving the developer's first real visit on the login form, and
  `--fresh` wiped sessions entirely (observed onboarding
  klarna-payments-for-woocommerce). Guest browsing, credential POSTs, logouts
  and `wp-login.php?action=login` are untouched; demo/e2e modes keep the
  upstream behavior. Auto-login is local-only (loopback Host and REMOTE_ADDR
  required), so a `--tunnel` URL always shows the normal login form instead
  of handing admin sessions to anyone holding it. Docs now also state the
  `admin` / `password` defaults.
- The bootstrap now prints a one-line heads-up before `composer install`
  when no GitHub token is configured: the per-package "Could not
  authenticate against github.com" warnings for private packages are
  composer's expected git-clone fallback, not failures, and
  `composer config -g github-oauth.github.com <token>` silences them.
  (Observed onboarding klarna-payments-for-woocommerce.)
- Docs: new "Emails never send" section — Playground's PHP-in-WASM has no mail
  transport, so every `wp_mail()` fails (on WooCommerce sites as order notes
  like `Email "Processing order" failed to send`); that's the platform, not
  the plugin under development. The development blueprint pre-activates WP
  Mail Logging, which records every attempted email under Tools → Email Log.
- Bump `@wp-playground/cli` 3.1.29 → 3.1.47: upstream fixed the `--reset`
  crash on Node 22+ ([wordpress-playground#3695](https://github.com/WordPress/wordpress-playground/pull/3695),
  shipped in 3.1.36), so the Node `<21` ceiling is gone.
- Node handling: `engines.node` relaxed to `>=20.19.0` (here and in scaffolded
  consumers); the `.nvmrc`/`.npmrc` pin moves from 20.19.0 (EOL) to 22.23.2
  (22 LTS). `init --update` rewrites an existing `use-node-version` pin and
  drops the stale "breaks on Node 22+" comment; the provisioning-time Node
  guard now only enforces the floor.
- Fix: `init` now restores the `#semver:^1` range on the dev dependency spec
  when `pnpm add` saved it as a bare branch-tracking git URL (pnpm normalizes
  the spec on save — all versions, 9 through 11). Deliberate `#committish`
  pins are left untouched. Install docs now end with a `pnpm install` to
  realign the lockfile. (Found onboarding klarna-payments-for-woocommerce.)
- Fix: widen the optional `@playwright/test` peer range `>=1.50.0` → `>=1.48.0`.
  `@wordpress/scripts` (via `@wordpress/e2e-test-utils-playwright`, peer
  `^1.48.1`) resolves `@playwright/test` 1.49.0 in consumer trees, so every
  `pnpm install` warned "unmet peer @playwright/test@>=1.50.0: found 1.49.0" —
  pnpm's `optional` flag silences a *missing* peer, not a version mismatch.
  The capture code uses nothing newer than Playwright 1.27 APIs (`getByText`),
  so 1.48+ is fully supported. (Observed in klarna-payments-for-woocommerce.)
- Fix: `init` rewrote the consumer's whole `package.json` (and a pre-existing
  `.claude/launch.json`) with tab indentation; the existing indentation is now
  detected and preserved (tabs remain the default for new files). `init` also
  fails loudly on an existing-but-empty `package.json`/`launch.json` instead
  of dying in `JSON.parse`. (Observed onboarding
  klarna-payments-for-woocommerce.)
- Package-manager detection, mirroring Krokedil CI: the Node manager is read
  from package.json's `packageManager` (fallback `devEngines.packageManager`,
  string or object form) — pnpm iff declared, npm otherwise; lockfile presence
  is intentionally ignored (`src/pm.mjs`, kept byte-compatible with
  krokedil-wp-ci's `build-plugin.js`). Installs and builds run with the
  detected manager: `pnpm install --frozen-lockfile` / `npm ci`, each with a
  lockfile-repairing fallback, and `<pm> run <build>`.
- Fix: `init` no longer stamps `packageManager: "pnpm@…"` / `engines.pnpm`
  onto an existing package.json without a declaration — absence of the field
  is what makes the centralized CI build with npm, so the stamp silently
  flipped npm plugins' CI to pnpm (where `--frozen-lockfile` fails with no
  pnpm-lock.yaml). Fresh scaffolds (init creates the package.json) still
  default to pnpm. `.npmrc use-node-version` is now written for pnpm plugins
  only, launch entries and the CLAUDE.md section use the detected manager
  (including npm's mandatory `--` flag separator).
- Bootstrap shim v2: self-detects the manager with the same rule (inline —
  it runs pre-install) and installs via `npm ci`/`npm install` on npm
  plugins. Existing consumers pick it up with `init --update`; npm plugins
  stamped by older inits must also delete the stamped `packageManager` +
  `engines.pnpm` by hand (see docs/onboarding.md).
- Provisioning on too-old Node (< 20.19) only attempts the `pnpm exec node`
  repin for pnpm-managed plugins (or when already running under pnpm);
  npm plugins get an `nvm use` message instead.
- Fix: persistent-site detection hashed `$PWD` while the Playground CLI hashes
  its resolved cwd, so launching through a symlinked path (or from a tool that
  doesn't set `$PWD`) inspected the wrong site — a warm site read as "first
  run" and was **reset**, and the tunnel-guard pre-flight checked a site the
  CLI never boots. Both now key on the resolved working directory; a site that
  was only ever reached via a symlinked path re-provisions once as its
  identity moves.
- Fix: screenshot pruning clamps `KROKEDIL_PG_KEEP_SHOTS` /
  `KROKEDIL_PG_KEEP_COLLAGES` to positive integers — a non-numeric or zero
  value made the "keep newest N" cut select **everything** for deletion.
- Errors now surface as one `✖ playground: <message>` line instead of a raw
  Node stack trace (the first thing a consumer with a config typo used to
  see); `KROKEDIL_PG_DEBUG=1` restores the stack.
- CLI: `--help`/`-h` (full command + flag reference on stdout) and
  `--version`; `server` validates its mode against the plugin's configured
  modes instead of failing later with `setup`/`start` listed as suggestions
  (a start-only plugin is told to opt into blueprint modes rather than shown
  an empty list); `compose` on a `modes: ['start']` plugin composes the
  development blueprint (what `start` boots) instead of silently writing
  nothing.
- Config validation: malformed `composer.markers`, `modes`, `activate`,
  `https.hosts`, `pages` entries, `php`, `wp` and `screenshots` now fail at
  load with actionable messages instead of unrelated TypeErrors deep in the
  launch (a string `https.hosts` used to spread character-by-character into
  the mkcert SANs), and the per-mode keys (`options`, `pages`, `muPlugins`,
  `extraSteps`) reject primitives instead of normalizing them to empty. An
  explicit `composer: null` now opts out of composer install even when a
  `composer.json` exists, as documented.
- Fix: Ctrl+C during ngrok/mkcert startup (a window of up to ~20 s) killed the
  launcher but orphaned the Playground child — and sometimes a live ngrok
  agent holding the reserved domain; signals are now mirrored into the child
  before the proxy starts.
- Fix: the wordpress.org zip cache writes atomically (temp file + rename) with
  backoff between download retries, and truncated cache entries from an
  interrupted write are re-downloaded instead of installed.
- Removed the never-used `runWithFreePort` from the public API
  (`@krokedil/wp-playground-tools` exports); no consumer references it.
- `init`: the scaffolded config's example `basePort` moves 8890 → 8900 —
  8890 is klarna-payments-for-woocommerce's claimed registry row, so
  uncommenting the example verbatim silently took its ports. The template also
  documents `modes` (e2e opt-in + `init --update`).

## 1.1.1 — 2026-07-29

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
