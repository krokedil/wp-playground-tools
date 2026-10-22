/**
 * PHP security-advisory gate for publicly exposed sites.
 *
 * The Playground CLI bundles PHP as per-branch wasm builds
 * (@php-wasm/node-X-Y), frozen at whatever point release upstream compiled.
 * A `--tunnel` run exposes that PHP to the internet, so before opening one we
 * check the bundled build against the minimum releases that contain known
 * pre-auth RCE fixes (currently PHP2Shell, CVE-2026-109618/109619: fixed
 * upstream 2026-10-21; branches ≤ 8.1 are EOL and never got a fix).
 *
 * The check reads the installed build rather than hard-coding "vulnerable
 * until @wp-playground/cli X": a pin bump to a release with patched builds
 * passes automatically, and a bump that silently ships old builds does not.
 * It fails closed — an unresolvable build refuses the tunnel too.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { buildModes, decideBlueprint, isProvisioned } from './prepare.mjs';

/**
 * Minimum safe point release per PHP branch for public exposure.
 *
 * A branch missing here is EOL upstream and never received the fix; it is
 * never safe to tunnel. Update this map when the next PHP security release
 * with a pre-auth remote vector lands.
 */
export const FIXED_PHP_BUILDS = {
	8.5: '8.5.12',
	8.4: '8.4.27',
	8.3: '8.3.36',
	8.2: '8.2.35',
};

/** What the gate guards against; used in refusal messages. */
const ADVISORY = 'PHP2Shell (CVE-2026-109618/109619)';

/** The Playground CLI's own default branch for runs without a blueprint. */
const CLI_DEFAULT_PHP = '8.3';

/** Env var that lets a dev knowingly tunnel a vulnerable build. */
export const ALLOW_VULNERABLE_PHP_ENV = 'KROKEDIL_PG_ALLOW_VULNERABLE_PHP';

/**
 * Compare two dotted numeric versions ("8.3.32" vs "8.3.36").
 *
 * @param {string} a Left version.
 * @param {string} b Right version.
 * @return {number} Negative when a < b, 0 when equal, positive when a > b.
 */
export function comparePhpVersions(a, b) {
	const pa = String(a).split('.').map(Number);
	const pb = String(b).split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff) {
			return diff;
		}
	}
	return 0;
}

/**
 * The exact PHP point release bundled for a branch, read from the installed
 * `@php-wasm/node-X-Y` package (its jspi/ and asyncify/ build dirs are named
 * after the release, e.g. 8_3_32).
 *
 * Resolution chains createRequire through the dependency tree (this package
 * → `@wp-playground/cli` → `@php-wasm/node` → the branch package) so it
 * survives pnpm's strict layout in consumer repos. The two build variants
 * have shipped different releases before, so the minimum wins — the site
 * could boot either.
 *
 * @param {string} branch PHP branch, e.g. '8.3'.
 * @return {string|null} The bundled release ('8.3.32'), or null when it
 *   cannot be determined.
 */
export function installedPhpBuild(branch) {
	if (!/^\d+\.\d+$/.test(branch)) {
		return null;
	}
	try {
		const resolveFrom = (from, specifier) => {
			const req = createRequire(from);
			try {
				return req.resolve(`${specifier}/package.json`);
			} catch {
				// Packages with an exports map may not expose package.json;
				// fall back to the main entry, which lives in the package dir.
				return req.resolve(specifier);
			}
		};
		const cli = resolveFrom(import.meta.url, '@wp-playground/cli');
		const node = resolveFrom(cli, '@php-wasm/node');
		const pkg = resolveFrom(
			node,
			`@php-wasm/node-${branch.replace('.', '-')}`
		);
		const pkgDir = path.dirname(pkg);

		let min = null;
		for (const variant of ['jspi', 'asyncify']) {
			const dir = path.join(pkgDir, variant);
			if (!fs.existsSync(dir)) {
				continue;
			}
			for (const entry of fs.readdirSync(dir)) {
				const m = entry.match(/^(\d+)_(\d+)_(\d+)$/);
				if (!m) {
					continue;
				}
				const release = `${m[1]}.${m[2]}.${m[3]}`;
				if (!release.startsWith(`${branch}.`)) {
					continue;
				}
				if (!min || comparePhpVersions(release, min) < 0) {
					min = release;
				}
			}
		}
		return min;
	} catch {
		return null;
	}
}

/**
 * The PHP branch a launch will actually run.
 *
 * Blueprint runs (server modes, and a provisioning start) take the composed
 * blueprint's preferredVersions.php — which is config.php, and which the
 * Playground CLI applies over any --php flag (the blueprint's
 * preferredVersions is spread last). A warm start has no blueprint, so the
 * CLI uses --php or its own default. A user-supplied --blueprint= could pin
 * anything; config.php is the best available answer there.
 *
 * @param {Object}   config      Normalized plugin config.
 * @param {Object}   mode        Mode entry from buildModes().
 * @param {string[]} args        Args forwarded to the Playground CLI.
 * @param {boolean}  provisioned Whether the persistent site already exists.
 * @return {string} The effective PHP branch, e.g. '8.3'.
 */
export function effectivePhpBranch(config, mode, args, provisioned) {
	const blueprintRun =
		mode.subcommand === 'server' ||
		decideBlueprint(mode.blueprint, args, provisioned).provisioning;
	if (blueprintRun) {
		return config.php;
	}
	const phpArg = args.find((a) => a.startsWith('--php='));
	return phpArg ? phpArg.slice('--php='.length) : CLI_DEFAULT_PHP;
}

/**
 * Why a site can't be tunnelled on its PHP build, if it can't.
 *
 * Returns a refusal message when the bundled PHP for the effective branch
 * predates the known pre-auth RCE fixes (or can't be determined — fail
 * closed), and null when the build is safe. The caller decides what an
 * override looks like; see ALLOW_VULNERABLE_PHP_ENV.
 *
 * Exported for tests; `facts` injects the installed-build and site-state
 * probes so verdicts are testable without real packages or sites.
 *
 * @param {string}   root     Plugin root.
 * @param {Object}   config   Normalized plugin config.
 * @param {string}   modeName Mode about to launch.
 * @param {string[]} args     Args forwarded to launch().
 * @param {Object}   [facts]  { installedPhpBuild, isProvisioned } overrides.
 * @return {string|null} An error message, or null when the build is safe.
 */
export function vulnerablePhpBlocker(
	root,
	config,
	modeName,
	args,
	facts = { installedPhpBuild, isProvisioned }
) {
	const mode = buildModes(config)[modeName];
	if (!mode || mode.setupOnly) {
		return null;
	}
	const provisioned = mode.persistent ? facts.isProvisioned(root) : false;
	const branch = effectivePhpBranch(config, mode, args, provisioned);

	const remedy =
		`Wait for a @wp-playground/cli release with patched builds, or set ` +
		`${ALLOW_VULNERABLE_PHP_ENV}=1 to knowingly expose it anyway.`;

	const fixed = FIXED_PHP_BUILDS[branch];
	if (!fixed) {
		return (
			`PHP ${branch} is end-of-life and never received the ${ADVISORY} ` +
			`fix, so tunnelling it risks pre-auth remote code execution. ` +
			`Set php to a supported branch (${Object.keys(FIXED_PHP_BUILDS).join(', ')}) ` +
			`in playground.config.mjs, or set ${ALLOW_VULNERABLE_PHP_ENV}=1 ` +
			`to knowingly expose it anyway.`
		);
	}

	const build = facts.installedPhpBuild(branch);
	if (!build) {
		return (
			`could not determine the bundled PHP build for branch ${branch}, ` +
			`so it must be assumed vulnerable to ${ADVISORY}. ${remedy}`
		);
	}

	if (comparePhpVersions(build, fixed) < 0) {
		return (
			`the bundled PHP ${build} predates the ${ADVISORY} fix ` +
			`(${fixed}), so tunnelling it risks pre-auth remote code ` +
			`execution. ${remedy}`
		);
	}

	return null;
}
