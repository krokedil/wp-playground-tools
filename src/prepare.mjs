/**
 * Bootstrap + launcher for the WordPress Playground dev environments.
 *
 * Responsibilities, in order:
 *   1. Guard the Node version (the Playground CLI's --reset path breaks on Node 22+).
 *   2. Ensure prerequisites a fresh git worktree lacks, idempotently: composer
 *      install (config.composer.markers), pnpm install (node_modules), and the
 *      plugin's JS build (config.build.markers, omitted for buildless plugins).
 *   3. For the persistent "start" mode, detect whether this worktree's site has
 *      ever been provisioned and, if not (or on --fresh/--reset), apply the dev
 *      blueprint via --reset. Warm boots run with no blueprint so data persists.
 *   4. Compose the blueprints + stage runtime assets into <plugin>/.playground/
 *      (see blueprint/compose.mjs), resolve a free port, and spawn the packaged
 *      Playground CLI dependency.
 *
 * The pre-`pnpm install` chicken-and-egg (this file lives in node_modules) is
 * owned by the per-plugin shim (src/init/templates/playground-shim.mjs), which
 * installs node_modules if missing and then imports "./cli".
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { composeAndStage } from './blueprint/compose.mjs';
import { MODE_PORT_OFFSETS } from './config.mjs';
import { resolvePort } from './port.mjs';

/** Directory (relative to the plugin root) for generated blueprints/assets. */
export const STAGING_DIR = '.playground';

// Human-readable line for each blueprint decision (see decideBlueprint).
export const REASON_MESSAGES = {
	'first-run':
		'first run for this worktree → provisioning with the development blueprint (--reset)…',
	reprovision:
		'reprovisioning this worktree (--reset + development blueprint)…',
	'pair-reset':
		'a --blueprint needs --reset (replay against live data is unsafe); adding --reset.',
	warm: 'warm boot — existing site preserved (no blueprint).',
};

// --- Pure helpers (exported for tests) -------------------------------------

/**
 * Whether a Node version string satisfies the supported >=20.19.0 <21 pin.
 *
 * @param {string} version e.g. process.versions.node ("20.19.0").
 * @return {boolean} True when within range.
 */
export function nodeSatisfiesPin(version) {
	const [major, minor] = version.split('.').map(Number);
	return major === 20 && minor >= 19;
}

/**
 * Compute the persistent-site directory key the CLI uses: sha256 of the cwd.
 *
 * @param {string} cwd Working directory the CLI is launched from.
 * @return {string} Lowercase hex sha256 digest.
 */
export function computeSiteHash(cwd) {
	return crypto.createHash('sha256').update(cwd).digest('hex');
}

/**
 * Build the mode table from a plugin config. Ports are basePort + a fixed
 * per-mode offset; the mount maps the plugin root onto its in-container slug
 * directory; blueprints are the generated ones under .playground/.
 *
 * @param {Object} config Normalized plugin config (see config.mjs).
 * @return {Object} modeName -> { port, subcommand, flags, blueprint?, persistent?, blueprintMode }.
 */
export function buildModes(config) {
	const mount = `.:/wordpress/wp-content/plugins/${config.slug}`;
	const blueprintPath = (mode) =>
		path.join(STAGING_DIR, `blueprint.${mode}.json`);

	const modes = { setup: { setupOnly: true } };
	if (config.modes.includes('start')) {
		modes.start = {
			port: config.basePort + MODE_PORT_OFFSETS.start,
			subcommand: 'start',
			// --no-auto-mount: `start` auto-mounts the cwd under its directory
			// name, which double-mounts worktrees and fatals on plugin redeclare.
			flags: ['--login', '--no-auto-mount', `--mount=${mount}`],
			blueprint: blueprintPath('development'),
			blueprintMode: 'development',
			persistent: true,
		};
	}
	for (const mode of ['development', 'demo', 'e2e']) {
		if (!config.modes.includes(mode)) {
			continue;
		}
		modes[mode] = {
			port: config.basePort + MODE_PORT_OFFSETS[mode],
			subcommand: 'server',
			flags: [`--blueprint=${blueprintPath(mode)}`, `--mount=${mount}`],
			blueprintMode: mode,
		};
	}
	return modes;
}

/**
 * Decide which --reset/--blueprint flags to inject for the persistent start
 * mode, enforcing the "a blueprint must be paired with --reset" rule. Pure:
 * the caller supplies the provisioned state and handles logging/IO.
 *
 * @param {string}   blueprint   Blueprint path to apply when provisioning.
 * @param {string[]} userArgs    Extra args the user passed through.
 * @param {boolean}  provisioned Whether this worktree's site already exists.
 * @return {{ injected: string[], provisioning: boolean, reason: string }} Decision.
 */
export function decideBlueprint(blueprint, userArgs, provisioned) {
	const wantsFresh = userArgs.includes('--fresh');
	const hasReset = userArgs.includes('--reset');
	const hasBlueprint = userArgs.some((a) => a.startsWith('--blueprint='));

	if (wantsFresh || hasReset || (!provisioned && !hasBlueprint)) {
		const injected = [];
		if (!hasReset) {
			injected.push('--reset');
		}
		if (!hasBlueprint) {
			injected.push(`--blueprint=${blueprint}`);
		}
		return {
			injected,
			provisioning: true,
			reason: provisioned ? 'reprovision' : 'first-run',
		};
	}

	if (hasBlueprint && !hasReset) {
		return {
			injected: ['--reset'],
			provisioning: true,
			reason: 'pair-reset',
		};
	}

	return { injected: [], provisioning: false, reason: 'warm' };
}

/**
 * Assemble the args passed to the Playground CLI bin (port appended later by
 * the port resolver).
 *
 * @param {Object}   mode      A mode entry (subcommand, flags).
 * @param {string[]} injected  Auto-injected reset/blueprint flags.
 * @param {string[]} forwarded User args to forward (minus our synthetic ones).
 * @return {string[]} The CLI argv (after the bin path).
 */
export function buildLaunchArgs(mode, injected, forwarded) {
	return [mode.subcommand, ...mode.flags, ...injected, ...forwarded];
}

/**
 * Resolve the packaged @wp-playground/cli bin script. A real pinned dependency
 * of this package — not `npx --yes` — so launches are offline-capable and the
 * pin is bumped in exactly one place.
 *
 * @return {string} Absolute path to the CLI's bin entry.
 */
export function resolvePlaygroundBin() {
	const require = createRequire(import.meta.url);
	const pkgPath = require.resolve('@wp-playground/cli/package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	const bin =
		typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0];
	return path.join(path.dirname(pkgPath), bin);
}

// --- IO helpers ------------------------------------------------------------

/**
 * Emit a progress line.
 *
 * @param {string} msg Message to print.
 */
export function log(msg) {
	process.stderr.write(`▶ playground: ${msg}\n`);
}

/**
 * Print an error and abort the bootstrap.
 *
 * @param {string} msg Message to print.
 */
function fail(msg) {
	process.stderr.write(`✖ playground: ${msg}\n`);
	process.exit(1);
}

/**
 * Ensure Node 20 for a provisioning (--reset) run. The Playground CLI's reset
 * uses an rmdirSync API removed in Node 22+, so only provisioning needs the pin
 * (warm boots / server / setup run on any Node). When the running Node is out
 * of range — e.g. preview_start launches us via npm, which ignores the .npmrc
 * pnpm pin — re-exec the entry script under pnpm's pinned Node 20 (.npmrc
 * use-node-version). If pnpm can't be used, abort with an actionable message.
 *
 * @param {string} root Plugin root (cwd for the re-exec).
 */
export function ensureNodeForProvisioning(root) {
	if (nodeSatisfiesPin(process.versions.node)) {
		return;
	}
	// KROKEDIL_PG_REEXEC guards against a re-exec loop if pnpm doesn't repin.
	if (process.env.KROKEDIL_PG_REEXEC !== '1') {
		const res = spawnSync(
			'pnpm',
			['exec', 'node', process.argv[1], ...process.argv.slice(2)],
			{
				cwd: root,
				stdio: 'inherit',
				env: { ...process.env, KROKEDIL_PG_REEXEC: '1' },
			}
		);
		if (!res.error) {
			process.exit(res.status ?? 0);
		}
	}
	fail(
		`Node ${process.versions.node} can't provision: the Playground CLI's ` +
			`--reset needs Node 20 (>=20.19.0 <21; it breaks on Node 22+). Run via ` +
			`pnpm, which auto-pins Node 20 (.npmrc): "pnpm run playground:start" — ` +
			`or "nvm use" first.`
	);
}

/**
 * Whether this worktree's persistent site is provisioned.
 *
 * @param {string} root Plugin root the CLI is launched from.
 * @return {boolean} True when the site's SQLite database exists.
 */
export function isProvisioned(root) {
	const db = path.join(
		os.homedir(),
		'.wordpress-playground',
		'sites',
		computeSiteHash(process.env.PWD || root),
		'wp-content',
		'database',
		'.ht.sqlite'
	);
	return fs.existsSync(db);
}

/**
 * Run a pnpm subcommand portably and return the spawn result (no hard fail).
 *
 * `pnpm run <script>` sets npm_execpath to pnpm's JS entry; run it with the
 * current Node so we don't depend on a pnpm/pnpm.cmd shim on PATH.
 *
 * @param {string}   root Plugin root.
 * @param {string[]} argv pnpm arguments (e.g. [ 'install' ]).
 * @return {Object} The spawnSync result.
 */
function pnpmRun(root, argv) {
	const execpath = process.env.npm_execpath;
	return execpath && /pnpm/.test(execpath)
		? spawnSync(process.execPath, [execpath, ...argv], {
				cwd: root,
				stdio: 'inherit',
			})
		: spawnSync('pnpm', argv, { cwd: root, stdio: 'inherit' });
}

/**
 * Run a pnpm subcommand, aborting the bootstrap on failure.
 *
 * @param {string}   root Plugin root.
 * @param {string[]} argv pnpm arguments.
 * @param {string}   what Human label used in the failure message.
 */
function pnpm(root, argv, what) {
	const res = pnpmRun(root, argv);
	if (res.error || res.status !== 0) {
		fail(`${what} failed${res.error ? `: ${res.error.message}` : ''}.`);
	}
}

/**
 * Install whatever a fresh worktree is missing. Idempotent: each step is
 * skipped when its marker already exists.
 *
 * @param {string}  root         Plugin root.
 * @param {Object}  config       Normalized plugin config.
 * @param {boolean} provisioning Whether we're about to (re)apply a blueprint;
 *                               forces a rebuild so the new site matches this branch's source.
 */
export function ensurePrereqs(root, config, provisioning) {
	const exists = (rel) => fs.existsSync(path.join(root, rel));

	if (
		config.composer &&
		config.composer.markers.some((marker) => !exists(marker))
	) {
		log('installing PHP dependencies (composer install)…');
		const res = spawnSync(
			'composer',
			['install', '--no-interaction', '--prefer-dist'],
			{ cwd: root, stdio: 'inherit' }
		);
		if (res.error || res.status !== 0) {
			fail(
				'composer install failed. Install Composer, or copy the main ' +
					`checkout's ${config.composer.markers
						.map((m) => m.split('/')[0] + '/')
						.join(' and ')} into this worktree.`
			);
		}
	}

	// No package.json means no Node dependencies to install (the sandbox
	// plugin, or a consumer with no JS tooling at all).
	if (exists('package.json') && !exists('node_modules')) {
		log('installing Node dependencies (pnpm install)…');
		// Prefer --frozen-lockfile (reproducible, matches CI, never rewrites the
		// lock). If the committed lockfile is stale or broken, fall back to a
		// normal install that repairs it, and say so rather than failing.
		const frozen = pnpmRun(root, ['install', '--frozen-lockfile']);
		if (frozen.error || frozen.status !== 0) {
			log(
				'lockfile not usable as-is; running a normal install (pnpm-lock.yaml may be updated — consider committing it)…'
			);
			pnpm(root, ['install', '--no-frozen-lockfile'], 'pnpm install');
		}
	}

	if (config.build) {
		const built = config.build.markers.every(exists);
		if (!built || provisioning) {
			const script = config.build.command ?? 'build';
			log(`building assets (pnpm run ${script})…`);
			pnpm(root, ['run', script], `pnpm run ${script}`);
		}
	}
}

/**
 * Bootstrap and launch a mode. Returns the spawned child and its resolved
 * port so callers (the CLI layer) can attach a tunnel/https proxy and control
 * process exit. For the setup mode, returns null after ensuring prerequisites.
 *
 * @param {string}   root     Plugin root (absolute).
 * @param {Object}   config   Normalized plugin config.
 * @param {string}   modeName One of buildModes(config) keys.
 * @param {string[]} userArgs Extra CLI args to forward.
 * @return {Promise<{port: number, child: Object, done: Promise<number>}|null>}
 *   Launch handle, or null for setup-only runs.
 */
export async function launch(root, config, modeName, userArgs) {
	const modes = buildModes(config);
	const mode = modes[modeName];
	if (!mode) {
		fail(
			`unknown mode "${modeName ?? ''}". Use one of: ${Object.keys(
				modes
			).join(', ')}.`
		);
	}

	let injected = [];
	let provisioning = false;
	let reason = null;
	if (mode.persistent) {
		({ injected, provisioning, reason } = decideBlueprint(
			mode.blueprint,
			userArgs,
			isProvisioned(root)
		));
	}

	// Only a provisioning (--reset) run needs Node 20; this may re-exec under
	// pnpm's pinned Node and exit, so do it before any logging or installs.
	if (provisioning) {
		ensureNodeForProvisioning(root);
	}
	if (reason) {
		log(REASON_MESSAGES[reason]);
	}

	ensurePrereqs(root, config, provisioning);

	if (mode.setupOnly) {
		log('setup complete — prerequisites are installed.');
		return null;
	}

	// (Re)generate the blueprint and stage runtime assets (mu-plugins, seed
	// data, pre-downloaded plugin zips). Warm boots need the staged mu-plugins
	// to exist inside the mount too.
	await composeAndStage(root, config, mode.blueprintMode);

	// --fresh is ours, not the CLI's; strip it before forwarding.
	const forwarded = userArgs.filter((a) => a !== '--fresh');
	const args = buildLaunchArgs(mode, injected, forwarded);

	const port = await resolvePort(mode.port, args);
	if (port !== null) {
		args.push(`--port=${port}`);
	}

	const { default: spawn } = await import('cross-spawn');
	const child = spawn(process.execPath, [resolvePlaygroundBin(), ...args], {
		cwd: root,
		stdio: 'inherit',
	});

	const done = new Promise((resolve) => {
		child.on('exit', (code, signal) => {
			// Mirror Ctrl+C etc. as 128+signum rather than a clean exit.
			resolve(
				signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 0)
			);
		});
		child.on('error', (err) => {
			process.stderr.write(String(err) + '\n');
			resolve(1);
		});
	});

	return {
		port: port ?? extractPort(args),
		child,
		done,
	};
}

/**
 * Pull the numeric port out of an explicit --port arg (manual override case).
 *
 * @param {string[]} args CLI args.
 * @return {number|null} The port, or null when absent/unparsable.
 */
function extractPort(args) {
	for (let i = 0; i < args.length; i++) {
		if (args[i].startsWith('--port=')) {
			return Number(args[i].slice('--port='.length)) || null;
		}
		if (args[i] === '--port' && args[i + 1]) {
			return Number(args[i + 1]) || null;
		}
	}
	return null;
}
