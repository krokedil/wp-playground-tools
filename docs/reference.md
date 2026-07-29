# Reference

Lookup material for consumers: seed-data shape, screenshots manifest, environment variables, and what development mode adds on top of your config. Onboarding walkthrough: [onboarding.md](onboarding.md).

## Seed data JSON

Development mode seeds WooCommerce data declaratively via the packaged `playground-seeder.php` mu-plugin. The fixture is the file configured as `seedData` in `playground.config.mjs` (default: the package's generic SE fixture, [`assets/seed-data/default.json`](../assets/seed-data/default.json) — also the best starting point to copy).

Every seed function is idempotent: existing entities are matched (by SKU, code, name, slug, country+class+rate, …) and skipped, so reprovisioning never duplicates data. **Exception:** `orders` creates one order per entry on every provisioning run.

Top-level keys (all optional):

| Key | Shape | Matched by |
|---|---|---|
| `tax_classes` | array of class names | name |
| `tax_rates` | `{ country, rate, class, name, … }` | country + class slug + rate |
| `product_attributes` | `{ name, slug, type, … }` (global attribute taxonomies) | slug |
| `products` | product specs; `type: 'simple'` (default) or `'variable'` with nested `attributes[]` + `variations[]` | SKU (variations too) |
| `coupons` | `{ code, amount, discount_type, … }` | code |
| `shipping_zones` | `{ name, methods[] }` | zone by name, method by `method_id` |
| `order_defaults` | base order template (`customer_id`, `items`, `billing`, `payment_method`, …) merged under each `orders[]` entry; also applied as user-1 billing meta | — |
| `orders` | per-order overrides (`status`, `items`, …) | **not deduplicated** |

The full field-level shape is documented in the header of [`assets/mu-plugins/playground-seeder.php`](../assets/mu-plugins/playground-seeder.php).

## Screenshots manifest

`config.screenshots` points at an ES module (conventionally `tools/shots.config.mjs`) with a default export:

```js
export default {
	title: 'My Plugin', // collage heading (default: "UI preview")
	viewport: { width: 1366, height: 900 }, // default for all shots
	seedPagePrefix: 'pr-screenshot', // naming for auto-created block pages
	afterLabel: 'my-feature', // default "after" column label
	shots: [
		{
			name: 'checkout-block', // REQUIRED — also the PNG filename
			label: 'Checkout block', // collage row label (default: name)
			type: 'frontend-block', // REQUIRED — see types below
			block: 'my-plugin/checkout', // block name for *-block types
			waitFor: '.my-plugin-ready', // optional selector to await
			clip: ['.entry-content'], // selector(s) to clip to (first visible wins)
			viewport: { width: 375, height: 812 }, // per-shot override
		},
	],
};
```

Shot types:

| `type` | What it captures | Type-specific fields |
|---|---|---|
| `frontend-block` | a published page containing just `block`, viewed on the frontend | `block`, `waitFor`, `clip` (default `['.entry-content', 'main', '#primary']`) |
| `editor-block` | the same block inside the Gutenberg editor (waits for ServerSideRender) | `block` |
| `admin` | any wp-admin URL | `path` (e.g. `/wp-admin/admin.php?page=…`), `click` / `clickText`, `waitFor`, `clip` (default `['.wrap', 'body']`) |

Pages for `*-block` shots are created via the REST API and cached per block; runs are keyed by `<branch>-<shortsha>` so they never overwrite each other. Requirements: `@playwright/test` in the plugin's devDependencies plus a one-time `pnpm exec playwright install chromium`, and a running site to shoot against (default: the demo server on `basePort+2`; the tool probes a few ports up from there).

Useful flags: `--only a,b`, `--no-collage`, `--port N`, `--host H`, and before/after collages via `--collage --after <ref> [--before <ref>]` — see the header of [`src/screenshots/capture.mjs`](../src/screenshots/capture.mjs).

## Environment variables

A gitignored `.env` at the plugin root is loaded before the config is evaluated (ambient env wins; linked worktrees fall back to the main checkout's `.env`) — see [README — Private options](../README.md#private-options-api-keys). Variables the tool itself reads:

| Variable | Effect | Default |
|---|---|---|
| `PORT` | used verbatim as the server port — no free-port probing (this is how `.claude/launch.json` `autoPort` drives the tool) | probe from the mode default |
| `NGROK_AUTHTOKEN` | ngrok credential for `--tunnel` (alternative to `ngrok config add-authtoken`) | — |
| `KROKEDIL_PG_SCREENSHOT_PORT` / `KROKEDIL_PG_SCREENSHOT_HOST` | where `screenshots` looks for the running site | probe from `basePort+2` / `127.0.0.1` |
| `KROKEDIL_PG_WP_USER` / `KROKEDIL_PG_WP_PASS` | wp-admin login used by `screenshots` | `admin` / `password` |
| `KROKEDIL_PG_KEEP_SHOTS` / `KROKEDIL_PG_KEEP_COLLAGES` | how many raw-shot dirs / collages to keep | 6 / 30 |
| `KROKEDIL_PG_CACHE_DIR` | override the plugin-zip download cache location | `~/.config/krokedil-playground/cache` |
| `KROKEDIL_PG_REEXEC` | internal guard for the Node-version re-exec — don't set it | — |

## Defaults and development-mode extras

Things the tool sets up that aren't in your config:

- **Admin login**: `admin` / `password` (the Playground CLI default).
- **Debug plugin bundle** (development mode): `query-monitor`, `show-hidden-post-meta`, `transients-manager`, `wp-mail-logging` are installed from wordpress.org and activated.
- **Test-orders panel** (development mode, WooCommerce): a `dev-orders-panel.php` mu-plugin is staged; it's inert unless a page uses the `[krokedil_dev_orders]` shortcode. Prefill its fields from your plugin via the `krokedil_pg_dev_panel_prefill` filter (e.g. from a plugin-local mu-plugin in `config.muPlugins`).
- **Proxy URL mu-plugin** (all modes): `playground-proxy-url.php` filters `home`/`siteurl` to the tunnel/https URL at runtime — no DB writes.
- **`WP_DEBUG_LOG`** is enabled in development mode; see [README — Logs / database](../README.md#logs--database) for where everything lands.
