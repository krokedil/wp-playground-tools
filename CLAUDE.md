# @krokedil/wp-playground-tools

Shared WordPress Playground dev tooling, consumed by Krokedil plugin repos as a git dependency (`github:krokedil/wp-playground-tools#semver:^1`). JS-first ESM (Node built-ins + `@wp-playground/cli` + `cross-spawn`); the runtime PHP lives in `assets/mu-plugins/`.

## Commands

```sh
pnpm install
pnpm test                # node:test — includes golden blueprint parity (tests/fixtures/rwwc-*.json)
pnpm run lint            # eslint, @wordpress preset (flat config); lint:fix to autofix
pnpm run format          # prettier (@wordpress/prettier-config); format:check in CI
```

## Standalone dev (dogfooding sandbox)

Every command treats `process.cwd()` as "the plugin" and requires `<cwd>/playground.config.mjs`. The committed `sandbox/` directory (mini plugin + config) lets the tool run against this repo directly:

```sh
pnpm run sandbox:http    # ephemeral development server on :9881
pnpm run sandbox:https   # + mkcert reverse proxy on https://localhost:10281 (needs `mkcert -install` once)
pnpm run sandbox:ngrok   # + ngrok tunnel (needs the ngrok binary + authtoken; URL printed and in sandbox/.playground/proxy-url.txt)
pnpm run sandbox:start   # persistent, worktree-isolated site on :9880
```

`.claude/launch.json` has preview entries for the three server variants. The sandbox plugin's dashboard widget and `GET /wp-json/krokedil-sandbox/v1/ping` echo `home_url()`, `is_ssl()` and forwarded headers — the quick check that each transport works. Never run `krokedil-playground init` inside this repo (it is guarded); `init` is for consumers.

## Architecture (src/)

`cli.mjs` (entry: subcommands, proxy lifecycle) → `config.mjs` (load + validate `playground.config.mjs`) → `prepare.mjs` (prerequisites, mode table, provisioning decision, spawns `@wp-playground/cli`) → `blueprint/compose.mjs` + `blueprint/steps.mjs` (generate blueprints into `.playground/`) → `proxy/tunnel.mjs` (dispatch) + `proxy/ngrok.mjs` + `proxy/https-local.mjs`. `init/scaffold.mjs` scaffolds consumer repos. `assets/mu-plugins/` are staged into `.playground/` and symlinked into the site.

## Invariants / gotchas

- **Node pin `>=20.19 <21`** (`.nvmrc`, `.npmrc`): the Playground CLI's `--reset` breaks on Node 22+. `prepare.mjs` re-execs via pnpm for provisioning runs.
- **Ports**: mode port = `basePort` + `{start: 0, development: 1, demo: 2, e2e: 3}`; the local https listener is the http port **+400**. Port precedence: explicit `--port` > `PORT` env > probe. The sandbox owns basePort 9880 (see the README port registry).
- **Proxy mechanism**: the public URL is written to `.playground/proxy-url.txt`; the always-staged `playground-proxy-url.php` mu-plugin filters `home`/`siteurl` at runtime — no DB writes, and the file is cleared on every non-proxied launch.
- **Site persistence**: sites are keyed by `sha256(cwd)` under `~/.wordpress-playground/sites/` — worktrees get isolated sites automatically.
- **Schema-creep rule**: new `playground.config.mjs` keys only when 3+ plugins need them; everything else goes through `extraSteps`.
- Tests are pure/offline: blueprint composition is a pure function (`composeBlueprint`), and golden fixtures pin consumer parity — update them deliberately, never regenerate blindly.

## Releases

Bump `version`, update `CHANGELOG.md`, tag `vX.Y.Z`, push the tag — consumers resolve via `#semver:^1`. Smoke-test `@wp-playground/cli` pin bumps before tagging (a bad pin fans out to every plugin).
