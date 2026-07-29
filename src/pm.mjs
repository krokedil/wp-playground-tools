/**
 * Node package-manager detection, mirroring Krokedil CI.
 *
 * The manager comes from package.json's explicit declaration —
 * `packageManager` first, then `devEngines.packageManager` — and lockfile
 * presence is intentionally ignored: orphan/stale lockfiles are common, and
 * the declaration is the correct signal of intent (matches Corepack
 * semantics). pnpm is selected only when the declaration names pnpm; any
 * other value — yarn, npm, or no declaration at all — means npm.
 *
 * IMPORTANT: the semantics must stay byte-compatible with krokedil-wp-ci
 * (scripts/lib/build-plugin.js and the centrally-build-plugin composite
 * action) so local dev and CI always agree on a plugin's manager. The init
 * shim template (src/init/templates/playground-shim.mjs) carries an inline
 * copy of the detection — it runs pre-install and cannot import this module;
 * keep the two in sync.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Install commands per manager: strict first (reproducible, matches CI,
 * never rewrites the lock), permissive fallback that repairs a stale or
 * missing lockfile for local dev.
 */
export const PM_COMMANDS = {
	pnpm: {
		install: ['install', '--frozen-lockfile'],
		installFallback: ['install', '--no-frozen-lockfile'],
		lockfile: 'pnpm-lock.yaml',
	},
	npm: {
		install: ['ci'],
		installFallback: ['install'],
		lockfile: 'package-lock.json',
	},
};

/**
 * Read the package-manager declaration from a parsed package.json:
 * `packageManager` first, then `devEngines.packageManager`, which may be a
 * string ("pnpm@9.15.9") or an object ({ name: "pnpm", ... }) — only the
 * name matters for picking the manager.
 *
 * @param {Object} pkg Parsed package.json contents.
 * @return {string} The raw declaration ("pnpm@9.15.9", "yarn@4.0.0"), or "" when nothing is declared.
 */
export function readPackageManagerField(pkg) {
	if (typeof pkg.packageManager === 'string') {
		return pkg.packageManager;
	}
	const devPm = pkg.devEngines && pkg.devEngines.packageManager;
	if (typeof devPm === 'string') {
		return devPm;
	}
	if (devPm && typeof devPm === 'object' && typeof devPm.name === 'string') {
		return devPm.name;
	}
	return '';
}

/**
 * Detect a plugin's Node package manager from its package.json declaration.
 *
 * @param {string} root Plugin root.
 * @return {string} 'pnpm' when declared, otherwise 'npm' (including when
 *                  package.json is missing or malformed — npm produces a
 *                  clearer error than we could here).
 */
export function detectPackageManager(root) {
	let pkg;
	try {
		pkg = JSON.parse(
			fs.readFileSync(path.join(root, 'package.json'), 'utf8')
		);
	} catch {
		return 'npm';
	}
	return /^pnpm([@/]|$)/.test(readPackageManagerField(pkg)) ? 'pnpm' : 'npm';
}

/**
 * Whether npm_execpath points at the given manager's JS entry, so it can be
 * re-run as `node <execpath>` without depending on a PATH shim. npm must
 * match on the exact basename — every pnpm execpath contains "npm" as a
 * substring.
 *
 * @param {string}           manager  'pnpm' or 'npm'.
 * @param {string|undefined} execpath process.env.npm_execpath.
 * @return {boolean} True when the execpath belongs to the manager.
 */
export function execpathMatches(manager, execpath) {
	if (!execpath) {
		return false;
	}
	return manager === 'pnpm'
		? /pnpm/.test(execpath)
		: path.basename(execpath) === 'npm-cli.js';
}
