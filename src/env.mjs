/**
 * Private-option (secret) support: zero-dependency .env loading and safe
 * env-var lookup for playground.config.mjs.
 *
 * Values are never stored or printed — warnings name variables only (the
 * NGROK_AUTHTOKEN precedent). See "Private options" in README.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Env names must be shell-safe identifiers; parseEnv on Node 20 can glue a
 * malformed line into the next line's key, so anything else is dropped.
 */
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names that collide with Object.prototype machinery. Assigning __proto__ on
 * a plain object mutates the prototype link instead of creating a property
 * (and parseEnv only filters it out on some Node versions), so these are
 * rejected outright — nobody names a real env var after them.
 */
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/** Secrets already warned about, so each name warns once per process. */
const warnedNames = new Set();

/**
 * Print a playground-prefixed warning line.
 *
 * @param {string} msg The message (never include env values).
 */
function warn(msg) {
	process.stderr.write(`▶ playground: ${msg}\n`);
}

/**
 * Resolve the main checkout root when `root` is a linked git worktree.
 *
 * In a linked worktree, <root>/.git is a plain file containing
 * "gitdir: <path>/.git/worktrees/<name>". Untracked files (like .env) never
 * transfer into worktrees, so the main checkout's .env is used as a fallback.
 *
 * @param {string} root Plugin root directory (absolute).
 * @return {string|null} Main checkout root, or null when not a linked worktree.
 */
function mainCheckoutRoot(root) {
	const gitPath = path.join(root, '.git');
	let content;
	try {
		if (!fs.statSync(gitPath).isFile()) {
			return null;
		}
		content = fs.readFileSync(gitPath, 'utf8');
	} catch {
		return null;
	}
	const match = content.match(/^gitdir:\s*(.+)\s*$/m);
	if (!match) {
		return null;
	}
	// <main>/.git/worktrees/<name> → the main checkout is <main>.
	const gitdir = path.resolve(root, match[1].trim());
	const worktreesDir = path.dirname(gitdir);
	if (path.basename(worktreesDir) !== 'worktrees') {
		return null;
	}
	const mainRoot = path.dirname(path.dirname(worktreesDir));
	return mainRoot === root ? null : mainRoot;
}

/**
 * Load .env values into `env` without overriding anything already set.
 *
 * Files applied in priority order: <root>/.env, then the main checkout's .env
 * when root is a linked git worktree. First value set for a name wins, so the
 * net precedence is: ambient env (CI secrets, shell exports) > worktree .env
 * > main-checkout .env. Missing files are silently fine (the CI case).
 *
 * @param {string} root          Plugin root directory (absolute).
 * @param {Object} [options]     Options.
 * @param {Object} [options.env] Target env map (default process.env).
 * @return {{loaded: boolean, applied: string[]}} Whether any file was read,
 *                                                and the names actually set.
 */
export function applyEnvFile(root, { env = process.env } = {}) {
	const candidates = [path.join(root, '.env')];
	const mainRoot = mainCheckoutRoot(root);
	if (mainRoot) {
		candidates.push(path.join(mainRoot, '.env'));
	}

	let loaded = false;
	const applied = [];
	for (const file of candidates) {
		if (!fs.existsSync(file)) {
			continue;
		}
		let content;
		try {
			content = fs.readFileSync(file, 'utf8');
		} catch (err) {
			// A present-but-unreadable .env would otherwise boot a silently
			// unconfigured site — surface it.
			throw new Error(`could not read ${file}: ${err.message}`);
		}
		loaded = true;
		// A BOM would otherwise stick to the first key.
		const parsed = parseEnv(content.replace(/^\uFEFF/, ''));
		let malformed = false;
		for (const [name, value] of Object.entries(parsed)) {
			if (!VALID_NAME.test(name)) {
				// Never echo the line — a malformed line may itself be a
				// pasted secret.
				malformed = true;
				continue;
			}
			if (RESERVED_NAMES.has(name)) {
				// The name isn't secret content, so it's safe to print.
				warn(`skipping reserved variable name "${name}" in .env`);
				continue;
			}
			// Own properties only: `in` would treat names shadowing
			// Object.prototype members (toString, …) as already set.
			if (Object.hasOwn(env, name)) {
				continue;
			}
			env[name] = value;
			applied.push(name);
		}
		if (malformed) {
			warn(
				`${file} has a malformed line (entries must be NAME=value); ` +
					'some variables may be ignored.'
			);
		}
	}
	if (applied.length) {
		warn(`loaded ${applied.length} value(s) from .env`);
	}
	return { loaded, applied };
}

/**
 * Read a private option value (API key etc.) from the environment.
 *
 * Returns undefined for unset AND empty values — GitHub Actions renders
 * missing/fork-PR secrets as '' — so JSON.stringify drops the option key and
 * the site boots unconfigured instead of half-configured. Warns once per name
 * per process, naming the variable only.
 *
 * @param {string} name          Env variable name.
 * @param {Object} [options]     Options.
 * @param {Object} [options.env] Env map to read (default process.env).
 * @return {string|undefined} The value, or undefined when unset/empty.
 */
export function envSecret(name, { env = process.env } = {}) {
	// Own properties only — env.constructor etc. must read as unset.
	const value = Object.hasOwn(env, name) ? env[name] : undefined;
	if (value !== undefined && value !== '') {
		return value;
	}
	if (!warnedNames.has(name)) {
		warnedNames.add(name);
		warn(`${name} is not set — the corresponding option will be omitted.`);
	}
	return undefined;
}
