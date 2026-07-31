/**
 * Loader + validator for a plugin's playground.config.mjs.
 *
 * The config is the single per-plugin contract: everything else (blueprints,
 * mounts, ports, prerequisites) derives from it. See README.md for the schema.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { applyEnvFile } from './env.mjs';

export const CONFIG_FILENAME = 'playground.config.mjs';

/** Server modes the composer knows how to build blueprints for. */
export const KNOWN_MODES = ['start', 'development', 'demo', 'e2e'];

/** Port offset per mode, relative to config.basePort. */
export const MODE_PORT_OFFSETS = {
	start: 0,
	development: 1,
	demo: 2,
	e2e: 3,
};

/** Blueprint-bearing modes (start boots the development blueprint). */
export const BLUEPRINT_MODES = ['development', 'demo', 'e2e'];

/**
 * Title-case a plugin slug ("my-plugin" -> "My Plugin") for the default siteName.
 *
 * @param {string} slug Plugin slug.
 * @return {string} Title-cased name.
 */
function titleCaseSlug(slug) {
	return slug
		.split('-')
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

/**
 * Throw a config error with a consistent, actionable prefix.
 *
 * @param {string} message What is wrong and how to fix it.
 */
function fail(message) {
	throw new Error(`playground.config.mjs: ${message}`);
}

/**
 * Validate a tunnel domain: a bare hostname (no scheme, path, port or spaces).
 *
 * Shared by config validation and the CLI's --tunnel-domain override so both
 * reject the same shapes with the same message. Throws a bare Error; callers
 * add their own context prefix (config validation wraps it via fail()).
 *
 * @param {*}      domain The raw domain value.
 * @param {string} [name] Setting name for the error message.
 * @return {string} The validated domain.
 */
export function validateTunnelDomain(domain, name = 'tunnel.domain') {
	// A leading "*." is a wildcard reservation: the tool serves one derived
	// subdomain per worktree under it, so parallel checkouts don't collide.
	const hostname =
		/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
	if (typeof domain !== 'string' || !hostname.test(domain)) {
		throw new Error(
			`"${name}" must be a bare hostname like "my-plugin.eu.ngrok.io" or a ` +
				`wildcard like "*.krokedil.ngrok.io" (no https://, path or port), ` +
				`got ${JSON.stringify(domain)}.`
		);
	}
	return domain;
}

/**
 * Normalize a per-mode setting to a { development, demo, e2e } map.
 *
 * Accepts: nothing (empty map), an array/plain value applied to every mode, or
 * an object keyed by "all" and/or mode names (the "all" entry is merged under
 * each mode; mode entries win for objects, replace for arrays).
 *
 * @param {*}      value The raw config value.
 * @param {string} name  Config key name, for error messages.
 * @param {string} kind  'array' or 'object' — the per-mode value shape.
 * @return {Object} mode -> value map.
 */
export function normalizePerMode(value, name, kind) {
	const empty = kind === 'array' ? [] : {};
	if (value === null || value === undefined) {
		return Object.fromEntries(BLUEPRINT_MODES.map((m) => [m, empty]));
	}

	// A bare array applies to every blueprint mode.
	if (Array.isArray(value)) {
		if (kind !== 'array') {
			fail(`"${name}" must be an object, got an array.`);
		}
		return Object.fromEntries(BLUEPRINT_MODES.map((m) => [m, value]));
	}

	// A primitive would fall through the key checks below as an object with no
	// keys and silently normalize to empty per-mode values.
	if (typeof value !== 'object') {
		fail(
			`"${name}" must be ${kind === 'array' ? 'an array or a per-mode object' : 'an object'}, got ${JSON.stringify(value)}.`
		);
	}

	const allowedKeys = ['all', ...BLUEPRINT_MODES];
	const unknown = Object.keys(value).filter((k) => !allowedKeys.includes(k));
	if (unknown.length) {
		fail(
			`"${name}" keys must be per-mode (${allowedKeys.join(', ')}); ` +
				`got "${unknown.join('", "')}". To apply values to every mode, nest them under "all": ` +
				`{ all: { ... } }.`
		);
	}

	const result = {};
	for (const mode of BLUEPRINT_MODES) {
		const base = value.all ?? empty;
		const specific = value[mode];
		if (kind === 'array') {
			result[mode] = specific ?? base;
		} else {
			result[mode] = { ...base, ...(specific ?? {}) };
		}
	}
	return result;
}

/**
 * Resolve the preferred WP version for a mode. `wp` may be a string (every
 * mode) or a per-mode object; the historical defaults are beta for
 * development/e2e and latest for demo.
 *
 * @param {string|Object|null} wp   The config's wp value.
 * @param {string}             mode Blueprint mode.
 * @return {string} WP version specifier.
 */
export function wpVersionFor(wp, mode) {
	const defaults = { development: 'beta', demo: 'latest', e2e: 'beta' };
	if (typeof wp === 'string') {
		return wp;
	}
	return wp?.[mode] ?? defaults[mode];
}

/**
 * Validate raw config and fill defaults. Pure — file access only for the
 * composer-marker default, which the caller can predetermine via hasComposerJson.
 *
 * @param {Object}  raw                    The default export of playground.config.mjs.
 * @param {Object}  [opts]                 Environment facts used for defaults.
 * @param {boolean} [opts.hasComposerJson] Whether the plugin has a composer.json.
 * @return {Object} The normalized config.
 */
export function normalizeConfig(raw, { hasComposerJson = false } = {}) {
	if (!raw || typeof raw !== 'object') {
		fail('the default export must be an object.');
	}
	if (!raw.slug || typeof raw.slug !== 'string') {
		fail('"slug" is required (the plugin directory/text-domain slug).');
	}
	if (!/^[a-z0-9][a-z0-9-]*$/.test(raw.slug)) {
		fail(`"slug" must be lowercase kebab-case, got "${raw.slug}".`);
	}

	const modes = raw.modes ?? ['start', 'development', 'demo'];
	if (
		!Array.isArray(modes) ||
		!modes.length ||
		modes.some((m) => typeof m !== 'string')
	) {
		fail(
			`"modes" must be a non-empty array of mode names (${KNOWN_MODES.join(', ')}).`
		);
	}
	const unknownModes = modes.filter((m) => !KNOWN_MODES.includes(m));
	if (unknownModes.length) {
		fail(
			`unknown mode(s) ${unknownModes.join(', ')} — known: ${KNOWN_MODES.join(', ')}.`
		);
	}

	const basePort = raw.basePort ?? 8880;
	if (!Number.isInteger(basePort) || basePort < 1024) {
		fail(`"basePort" must be an integer >= 1024, got ${basePort}.`);
	}

	if (raw.build && !raw.build.markers?.length) {
		fail(
			'"build.markers" must list at least one output file when "build" is set (omit "build" entirely for plugins without a JS build).'
		);
	}

	if (raw.composer && !raw.composer.markers?.length) {
		fail(
			'"composer.markers" must list at least one install marker when "composer" is set (set "composer: null" for plugins without composer).'
		);
	}

	if (raw.php !== undefined && typeof raw.php !== 'string') {
		fail(
			`"php" must be a version string like '8.3' (quote it — a bare number lands verbatim in the blueprint), got ${JSON.stringify(raw.php)}.`
		);
	}
	if (raw.wp !== undefined && raw.wp !== null) {
		let wpValues = null;
		if (typeof raw.wp === 'string') {
			wpValues = [raw.wp];
		} else if (typeof raw.wp === 'object' && !Array.isArray(raw.wp)) {
			wpValues = Object.values(raw.wp);
		}
		if (!wpValues || wpValues.some((v) => typeof v !== 'string')) {
			fail(
				'"wp" must be a version string or a per-mode map of version strings (e.g. { development: \'beta\' }).'
			);
		}
	}

	if (
		raw.activate !== undefined &&
		(!Array.isArray(raw.activate) ||
			raw.activate.some((s) => typeof s !== 'string'))
	) {
		fail(
			'"activate" must be an array of plugin slugs/paths (defaults to [slug] when omitted).'
		);
	}

	if (
		raw.screenshots !== undefined &&
		raw.screenshots !== null &&
		typeof raw.screenshots !== 'string'
	) {
		fail(
			'"screenshots" must be a path string to a shots manifest (e.g. \'./tools/shots.config.mjs\').'
		);
	}

	if (
		raw.https?.hosts !== undefined &&
		(!Array.isArray(raw.https.hosts) ||
			!raw.https.hosts.length ||
			raw.https.hosts.some((h) => typeof h !== 'string'))
	) {
		// A bare string would spread character-by-character into the mkcert
		// SAN list; an empty array would issue a certificate for no hostname.
		fail('"https.hosts" must be a non-empty array of hostnames.');
	}

	if (raw.tunnel && raw.tunnel.provider && raw.tunnel.provider !== 'ngrok') {
		fail(
			`unsupported tunnel provider "${raw.tunnel.provider}" — only "ngrok" is available today.`
		);
	}
	if (raw.tunnel?.domain !== undefined) {
		try {
			validateTunnelDomain(raw.tunnel.domain);
		} catch (err) {
			fail(err.message);
		}
	}

	const activate = raw.activate ?? [raw.slug];

	// `in`-check, not ??: an explicit `composer: null` opts out of composer
	// install even when a composer.json exists.
	let composer = null;
	if ('composer' in raw) {
		composer = raw.composer;
	} else if (hasComposerJson) {
		composer = { markers: ['vendor/autoload.php'] };
	}

	const pages = normalizePerMode(raw.pages, 'pages', 'array');
	for (const list of Object.values(pages)) {
		for (const page of list) {
			if (
				!page ||
				typeof page.title !== 'string' ||
				typeof page.slug !== 'string' ||
				typeof page.content !== 'string'
			) {
				fail(
					`"pages" entries need string "title", "slug" and "content", got ${JSON.stringify(page)}.`
				);
			}
		}
	}

	return {
		slug: raw.slug,
		siteName: raw.siteName ?? titleCaseSlug(raw.slug),
		siteTagline: raw.siteTagline ?? null, // per-mode default applied by the composer
		landingPage: raw.landingPage ?? '/wp-admin/',
		basePort,
		php: raw.php ?? '8.3',
		wp: raw.wp ?? null, // null -> per-mode defaults (see wpVersionFor)
		composer,
		build: raw.build ?? null,
		woocommerce: raw.woocommerce ?? true,
		store: {
			country: 'SE',
			currency: 'SEK',
			timezone: 'Europe/Stockholm',
			...(raw.store ?? {}),
		},
		activate,
		options: normalizePerMode(raw.options, 'options', 'object'),
		pages,
		muPlugins: normalizePerMode(raw.muPlugins, 'muPlugins', 'array'),
		seedData: raw.seedData ?? null, // development-mode fixture; null -> package default
		demoFixture: raw.demoFixture ?? raw.woocommerce ?? true,
		extraSteps: normalizePerMode(raw.extraSteps, 'extraSteps', 'array'),
		modes,
		screenshots: raw.screenshots ?? null,
		tunnel: raw.tunnel ?? null,
		https: { hosts: ['localhost'], ...(raw.https ?? {}) },
	};
}

/**
 * Load and normalize <root>/playground.config.mjs.
 *
 * @param {string} root                 Plugin root directory (absolute).
 * @param {Object} [options]            Options.
 * @param {string} [options.globalFile] Central env file (test injection —
 *                                      forwarded to applyEnvFile).
 * @return {Promise<Object>} The normalized config.
 */
export async function loadConfig(root, { globalFile } = {}) {
	const file = path.join(root, CONFIG_FILENAME);
	if (!fs.existsSync(file)) {
		fail(
			`not found at ${file}. Run "krokedil-playground init" to scaffold one.`
		);
	}
	// Private options: the config module reads secrets from process.env, so
	// .env must be merged before the import evaluates it.
	// An undefined globalFile falls through to applyEnvFile's own default.
	applyEnvFile(root, { globalFile });
	// Cache-bust: the config may be rewritten between loads in one process
	// (init --update, tests) and ESM caches modules by URL.
	const mod = await import(
		`${pathToFileURL(file).href}?mtime=${fs.statSync(file).mtimeMs}`
	);
	if ((mod.default?.basePort ?? null) === null) {
		process.stderr.write(
			'playground-config: "basePort" is not set — falling back to 8880, which other plugins may already claim. ' +
				'Claim a row in the port registry table (package README) and set basePort in playground.config.mjs.\n'
		);
	}
	return normalizeConfig(mod.default, {
		hasComposerJson: fs.existsSync(path.join(root, 'composer.json')),
	});
}
