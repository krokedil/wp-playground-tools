/**
 * Blueprint composer: playground.config.mjs -> a full Playground blueprint,
 * written (with its staged runtime assets) into <plugin>/.playground/.
 *
 * Composition runs on every launch — it is a cheap JSON build — so the
 * generated blueprint and staged mu-plugins always match the checked-out
 * source. Warm boots skip the blueprint but still need the staged files: the
 * site's mu-plugin symlinks point into the mount at .playground/mu-plugins/.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { wpVersionFor } from '../config.mjs';
import { copyRuntimeReadable } from '../runtime-file.mjs';
import * as steps from './steps.mjs';

/** Package-root assets directory (mu-plugins, default seed data). */
const ASSETS_DIR = fileURLToPath(new URL('../../assets', import.meta.url));

/** Mode -> tagline + landing-page defaults. */
const MODE_DEFAULTS = {
	development: { tagline: 'Development by Krokedil', landing: null },
	demo: { tagline: 'Demo by Krokedil', landing: '/wp-admin/plugins.php' },
	e2e: { tagline: 'E2E by Krokedil', landing: '/wp-admin/plugins.php' },
};

/**
 * The staged mu-plugin basenames for a mode: the proxy-url and tunnel-guard
 * helpers always, the auto-login helper and declarative seeder for
 * development, plus the plugin's own files.
 *
 * @param {Object} config Normalized plugin config.
 * @param {string} mode   Blueprint mode.
 * @return {{ name: string, source: string }[]} Basename + absolute source path.
 */
function muPluginFiles(config, mode) {
	const files = [
		{
			name: 'playground-proxy-url.php',
			source: path.join(
				ASSETS_DIR,
				'mu-plugins',
				'playground-proxy-url.php'
			),
		},
		{
			// Every mode, not just tunnelled runs: --tunnel is a per-run flag,
			// and the guard is inert until a tunnel writes its password file.
			name: 'playground-tunnel-guard.php',
			source: path.join(
				ASSETS_DIR,
				'mu-plugins',
				'playground-tunnel-guard.php'
			),
		},
		{
			// Every mode: any of them can place an order against a provider's
			// shared test merchant, where a bare order number collides with
			// every other checkout's.
			name: 'playground-order-prefix.php',
			source: path.join(
				ASSETS_DIR,
				'mu-plugins',
				'playground-order-prefix.php'
			),
		},
	];
	if (mode === 'development') {
		// wp-login.php auto-submits as admin. The CLI's own login is disabled
		// in development (see composeBlueprint): it re-logs-in every request
		// without its marker cookie, so cookie-less clients redirect-loop.
		files.push({
			name: 'playground-dev-login.php',
			source: path.join(
				ASSETS_DIR,
				'mu-plugins',
				'playground-dev-login.php'
			),
		});
	}
	if (mode === 'development' && config.woocommerce) {
		files.push({
			name: 'playground-seeder.php',
			source: path.join(
				ASSETS_DIR,
				'mu-plugins',
				'playground-seeder.php'
			),
		});
		// The [krokedil_dev_orders] test-orders panel; inert unless a page
		// uses the shortcode (prefill wired via krokedil_pg_dev_panel_prefill).
		files.push({
			name: 'dev-orders-panel.php',
			source: path.join(ASSETS_DIR, 'mu-plugins', 'dev-orders-panel.php'),
		});
	}
	for (const rel of config.muPlugins[mode] ?? []) {
		files.push({ name: path.basename(rel), source: rel });
	}
	return files;
}

/**
 * Compose the blueprint object for a mode. Pure: no filesystem access.
 *
 * @param {Object} config Normalized plugin config.
 * @param {string} mode   'development' | 'demo' | 'e2e'.
 * @return {Object} The blueprint JSON object.
 */
export function composeBlueprint(config, mode) {
	const defaults = MODE_DEFAULTS[mode];
	if (!defaults) {
		throw new Error(
			`composeBlueprint: unknown mode "${mode}" (use development, demo or e2e).`
		);
	}
	const development = mode === 'development';

	const list = [];
	if (development || mode === 'demo') {
		list.push(steps.debugConsts(development));
	}
	list.push(steps.disableAutoUpdates());
	list.push(steps.reset(development));
	list.push(steps.removeDefaultPlugins());
	list.push(...steps.storefrontTheme());
	list.push(steps.siteIdentity(config, defaults.tagline));
	list.push(steps.flushRewrite());

	if (config.woocommerce) {
		list.push(...steps.wooCommerceBaseline(config.store));
		if (development) {
			list.push(steps.bacsGateway());
		}
		list.push(...steps.wooCommercePages());
		if (mode === 'demo') {
			list.push(...steps.demoStoreConfig(config.store));
		}
	}

	if (development) {
		list.push(...steps.debugPlugins());
	}

	list.push(...steps.activatePlugins(config.activate));

	const options = steps.pluginOptions(config.options[mode] ?? {});
	if (options) {
		list.push(options);
	}

	list.push(steps.dismissWelcomeGuides());

	for (const page of config.pages[mode] ?? []) {
		list.push(steps.createPage(page));
	}

	const muFiles = muPluginFiles(config, mode);
	list.push(
		...steps.linkMuPlugins(
			config.slug,
			muFiles.map((f) => f.name)
		)
	);

	if (development && config.woocommerce) {
		list.push(steps.seedInvocation(config.slug));
	} else if (config.woocommerce && config.demoFixture) {
		list.push(...steps.demoFixture());
	}

	list.push(...(config.extraSteps[mode] ?? []));

	return {
		$schema: 'https://playground.wordpress.net/blueprint-schema.json',
		description: `Generated by @krokedil/wp-playground-tools for ${config.slug} (${mode}).`,
		preferredVersions: {
			php: config.php,
			wp: wpVersionFor(config.wp, mode),
		},
		landingPage: defaults.landing ?? config.landingPage,
		// Development: the CLI's auto-login runs per client — any request
		// without its marker cookie gets a full admin login plus a 302 back
		// to itself, so curl probes and CI health checks loop until
		// max-redirects and every retry writes another session row.
		// playground-dev-login.php covers local login instead.
		// Demo/e2e keep it: they're browser/Playwright sessions that hold
		// cookies, and landing logged-in on plugins.php is their contract.
		login: !development,
		steps: list,
	};
}

/** How long a cached wordpress.org plugin zip stays fresh. */
const ZIP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Below this a "zip" is an error page or a truncated write, not a plugin. */
const MIN_ZIP_BYTES = 1000;

/** How long a cached "is a WP beta offered right now" answer stays fresh. */
const BETA_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Host-side download cache for wordpress.org zips (overridable for tests).
 *
 * @return {string} Absolute cache directory.
 */
function zipCacheDir() {
	return (
		process.env.KROKEDIL_PG_CACHE_DIR ||
		path.join(os.homedir(), '.config', 'krokedil-playground', 'cache')
	);
}

/**
 * Download a URL to a file with retries (Playground's in-WASM fetch is flaky;
 * the host's fetch is not).
 *
 * @param {string} url      Source URL.
 * @param {string} dest     Destination file path.
 * @param {number} attempts Total attempts.
 */
async function fetchToFile(url, dest, attempts = 3) {
	let lastError;
	for (let i = 0; i < attempts; i++) {
		if (i) {
			// Transient blips (DNS, resets) outlive back-to-back retries.
			await new Promise((r) => setTimeout(r, 500 * 2 ** (i - 1)));
		}
		try {
			const res = await fetch(url, {
				signal: AbortSignal.timeout(30000),
				redirect: 'follow',
			});
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			const buffer = Buffer.from(await res.arrayBuffer());
			if (buffer.length < MIN_ZIP_BYTES) {
				throw new Error(
					`suspiciously small download (${buffer.length} bytes)`
				);
			}
			// Write via a temp file + rename so an interrupted write can never
			// leave a truncated zip that the freshness check later accepts.
			// Plain permissions: this is the host-side cache under ~/.config,
			// not something the runtime reads — copyRuntimeReadable fixes the
			// mode of the staged copy whatever this file ends up as.
			fs.writeFileSync(`${dest}.part`, buffer);
			fs.renameSync(`${dest}.part`, dest);
			return;
		} catch (err) {
			lastError = err;
		}
	}
	throw lastError;
}

/**
 * Whether wordpress.org currently offers a beta/RC build. Between a final
 * release and the next beta cycle it offers none, and the Playground CLI's
 * 'beta' resolver then falls through to wordpress.org/wordpress-beta.zip —
 * a 404 whose body it saves and tries to unzip, failing every cold boot with
 * "Could not unzip file. Error code: 19. File size: 18 bytes." The check
 * mirrors the CLI's own resolution (autoupdate offers whose version contains
 * "beta" or "RC") and caches the answer (TTL above) next to the plugin zips.
 *
 * @return {Promise<boolean|null>} Whether a beta/RC is offered, or null when
 * the API was unreachable and no fresh cached answer exists.
 */
async function wpBetaOffered() {
	const cacheDir = zipCacheDir();
	const cached = path.join(cacheDir, 'wp-beta-check.json');
	if (
		fs.existsSync(cached) &&
		Date.now() - fs.statSync(cached).mtimeMs < BETA_CHECK_TTL_MS
	) {
		try {
			const answer = JSON.parse(
				fs.readFileSync(cached, 'utf8')
			).betaOffered;
			if (typeof answer === 'boolean') {
				return answer;
			}
		} catch {
			// Unreadable cache entry — fall through to a re-fetch.
		}
	}
	try {
		const res = await fetch(
			'https://api.wordpress.org/core/version-check/1.7/?channel=beta',
			{ signal: AbortSignal.timeout(10000), redirect: 'follow' }
		);
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}`);
		}
		const offers = (await res.json())?.offers ?? [];
		const betaOffered = offers.some(
			(o) =>
				o?.response === 'autoupdate' &&
				(String(o?.version ?? '').includes('beta') ||
					String(o?.version ?? '').includes('RC'))
		);
		fs.mkdirSync(cacheDir, { recursive: true });
		// Temp file + rename, like fetchToFile: an interrupted write must not
		// leave a truncated entry that the freshness check accepts.
		fs.writeFileSync(
			`${cached}.part`,
			JSON.stringify({ betaOffered }) + '\n'
		);
		fs.renameSync(`${cached}.part`, cached);
		return betaOffered;
	} catch {
		return null;
	}
}

/**
 * Pre-download wordpress.org plugin zips on the host and rewrite the
 * blueprint's installPlugin steps to install from the mounted copy, so the
 * Playground CLI never fetches plugins through its flaky in-WASM network
 * stack. Zips are cached (7-day TTL) and staged into .playground/plugins/.
 * A failed download leaves that step on wordpress.org as before (warned).
 *
 * @param {string} root      Plugin root.
 * @param {Object} config    Normalized plugin config.
 * @param {Object} blueprint Composed blueprint (mutated in place).
 */
async function stagePluginZips(root, config, blueprint) {
	const installSteps = blueprint.steps.filter(
		(s) =>
			s.step === 'installPlugin' &&
			s.pluginData?.resource === 'wordpress.org/plugins'
	);
	if (!installSteps.length) {
		return;
	}

	const cacheDir = zipCacheDir();
	const stagedDir = path.join(root, '.playground', 'plugins');
	fs.mkdirSync(cacheDir, { recursive: true });
	fs.mkdirSync(stagedDir, { recursive: true });

	for (const step of installSteps) {
		const slug = step.pluginData.slug;
		const cached = path.join(cacheDir, `${slug}.zip`);
		// Size floor mirrors fetchToFile: a cache entry from before writes were
		// atomic may be truncated, and installing it fails undiagnosably.
		const fresh =
			fs.existsSync(cached) &&
			Date.now() - fs.statSync(cached).mtimeMs < ZIP_TTL_MS &&
			fs.statSync(cached).size >= MIN_ZIP_BYTES;
		if (!fresh) {
			try {
				await fetchToFile(
					`https://downloads.wordpress.org/plugin/${slug}.latest-stable.zip`,
					cached
				);
			} catch (err) {
				process.stderr.write(
					`▶ playground: could not pre-download ${slug} (${err.message}) — the CLI will fetch it itself.\n`
				);
				continue;
			}
		}
		copyRuntimeReadable(cached, path.join(stagedDir, `${slug}.zip`));
		step.pluginData = {
			resource: 'vfs',
			path: `${steps.pluginContainerPath(config.slug)}/.playground/plugins/${slug}.zip`,
		};
	}
}

/**
 * Compose a mode's blueprint and stage its runtime assets under
 * <root>/.playground/. Idempotent; overwrites previous output.
 *
 * @param {string} root   Plugin root (absolute).
 * @param {Object} config Normalized plugin config.
 * @param {string} mode   Blueprint mode.
 * @return {Promise<{ blueprintPath: string }>} Path of the written blueprint file.
 */
export async function composeAndStage(root, config, mode) {
	const stagingDir = path.join(root, '.playground');
	const muDir = path.join(stagingDir, 'mu-plugins');
	fs.mkdirSync(muDir, { recursive: true });

	// Stage mu-plugins: package assets by absolute path, plugin files relative
	// to the plugin root.
	for (const file of muPluginFiles(config, mode)) {
		const source = path.isAbsolute(file.source)
			? file.source
			: path.join(root, file.source);
		if (!fs.existsSync(source)) {
			// No "playground:" prefix — the CLI's top-level handler adds it.
			throw new Error(
				`mu-plugin not found: ${source} (check config.muPlugins).`
			);
		}
		copyRuntimeReadable(source, path.join(muDir, file.name));
	}

	// Stage the seed data for the development seeder.
	if (config.woocommerce) {
		const seedSource = config.seedData
			? path.join(root, config.seedData)
			: path.join(ASSETS_DIR, 'seed-data', 'default.json');
		if (!fs.existsSync(seedSource)) {
			throw new Error(
				`seed data not found: ${seedSource} (check config.seedData).`
			);
		}
		copyRuntimeReadable(
			seedSource,
			path.join(stagingDir, 'seed-data.json')
		);
	}

	const blueprint = composeBlueprint(config, mode);
	if (blueprint.preferredVersions.wp === 'beta') {
		// See wpBetaOffered: 'beta' with no live beta cycle bricks
		// provisioning, so fall back to latest — at that point the freshly
		// released version *is* what the beta was previewing.
		const offered = await wpBetaOffered();
		if (offered === false) {
			blueprint.preferredVersions.wp = 'latest';
			process.stderr.write(
				'▶ playground: no WordPress beta/RC is offered right now — using latest instead.\n'
			);
		} else if (offered === null) {
			process.stderr.write(
				'▶ playground: could not check whether a WordPress beta exists (offline?) — keeping wp "beta".\n'
			);
		}
	}
	await stagePluginZips(root, config, blueprint);

	// Plain write: the blueprint is consumed by the host CLI process that wrote
	// it, not read back from inside the runtime, so its mode is nobody's
	// business — and it may carry private options from .env.
	const blueprintPath = path.join(stagingDir, `blueprint.${mode}.json`);
	fs.writeFileSync(blueprintPath, JSON.stringify(blueprint, null, 2) + '\n');

	return { blueprintPath };
}
