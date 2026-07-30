/**
 * WordPress Playground dev-environment config for this plugin.
 * Consumed by @krokedil/wp-playground-tools — see its README for the full schema.
 */
export default {
	slug: '__SLUG__',

	// Where the persistent dev site lands after boot.
	// landingPage: '/wp-admin/',

	// REQUIRED before first real use: claim a free row in the org port
	// registry table (the package README) and set it here. Until you do, the
	// tool warns and falls back to 8880 — a port another plugin already
	// claims. Modes listen on basePort (start), +1 (development), +2 (demo),
	// +3 (e2e); --https proxies on the live port +400.
	// basePort: 8890,

	// Plugins without composer.json / a JS build can delete these.
	// composer: { markers: [ 'vendor/autoload.php' ] },
	// build: { markers: [ 'build/index.asset.php' ], command: 'build' },

	// Options seeded on every provisioned site (per-mode: development/demo/e2e).
	// options: { all: { my_plugin_enabled: 'yes' } },

	// Private option values (API keys) come from env vars: a gitignored .env at
	// the plugin root locally, repo secrets in CI. See "Private options" in the
	// tooling README. At the top of this file:
	//   import { envSecret } from '@krokedil/wp-playground-tools';
	// options: { all: { my_gateway_settings: { test_secret: envSecret('MY_TEST_SECRET') } } },

	// Pages created on provisioning.
	// pages: { all: [ { title: 'Checkout Test', slug: 'checkout-test', content: '<!-- wp:shortcode -->[my_shortcode]<!-- /wp:shortcode -->' } ] },

	// Plugin-local mu-plugins staged into the site (e.g. a dev-panel prefill filter).
	// muPlugins: { development: [ 'tools/dev-helper.php' ] },

	// WooCommerce seed fixture for the development site (products, tax, coupons,
	// shipping, order templates). Defaults to the package's generic SE fixture.
	// seedData: 'tools/playground-seeder-data.json',

	// PR screenshot manifest (omit to disable `screenshots`).
	// screenshots: './tools/shots.config.mjs',

	// For --tunnel: reserve a stable domain per plugin under the company ngrok
	// pay-as-you-go account (dashboard.ngrok.com/domains) and claim it in the
	// tunnel domain registry table (shared README) — stable webhook callbacks
	// depend on it. Parallel worktrees: override per run with
	// --tunnel-domain=<second-reserved-domain|none>.
	// tunnel: { provider: 'ngrok', domain: 'my-plugin.eu.ngrok.io' },

	// For --https: the mkcert SAN list. Replaces the default ['localhost'] —
	// keep 'localhost' in the list if you still browse there; the first entry
	// becomes the host in the printed https URL.
	// https: { hosts: [ 'localhost', 'my-plugin.test' ] },
};
