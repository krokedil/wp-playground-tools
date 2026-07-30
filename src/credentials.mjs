/**
 * Credential discovery for the central per-user env file.
 *
 * `krokedil-playground credentials` (also run by `init`) statically scans the
 * plugin's playground.config.mjs for envSecret('NAME') calls and appends
 * commented stubs for names missing from ~/.config/krokedil-playground/.env,
 * so one file holds the credentials for every plugin checkout. The config is
 * never executed here, and values are never read or printed — only names.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { CONFIG_FILENAME } from './config.mjs';
import { VALID_NAME, applyEnvFile, globalEnvFile } from './env.mjs';

/**
 * Per-user tool credentials worth a stub in the central file: both are
 * personal (not per-plugin) --tunnel settings — see the README's tunnel
 * section — so they are stubbed for every plugin under one shared heading.
 */
const TOOL_CREDENTIALS = ['NGROK_AUTHTOKEN', 'KROKEDIL_PG_TUNNEL_PASS'];
const TOOL_HEADING = 'krokedil-playground tooling (--tunnel)';

/**
 * Print a playground-prefixed status line.
 *
 * @param {string} msg The message (never include env values).
 */
function log(msg) {
	process.stderr.write(`▶ playground: ${msg}\n`);
}

/**
 * A home-relative display form of a path (the central file in messages).
 *
 * @param {string} file Absolute path.
 * @return {string} The path with the home directory shown as ~.
 */
function displayPath(file) {
	const home = os.homedir();
	return file.startsWith(home + path.sep)
		? '~' + file.slice(home.length)
		: file;
}

/**
 * Blank out line and block comments, keeping the code (and newlines) intact.
 *
 * The scans below are text scans, so commented-out examples would otherwise
 * count as real calls — the scaffolded config ships one (`envSecret(
 * 'MY_TEST_SECRET' )`), and every commented example would leak a bogus stub
 * into the shared central file. A small state walk rather than a regex,
 * because quotes and comment markers nest both ways: `// see 'X'` is a
 * comment, `'https://…'` is a string. Regex literals are not tracked (a
 * config has no use for one, and division never precedes `/` or `*`).
 *
 * @param {string} source JavaScript source text.
 * @return {string} The source with comment bodies removed.
 */
export function stripComments(source) {
	let out = '';
	let i = 0;
	while (i < source.length) {
		const char = source[i];
		const next = source[i + 1];
		if (char === '/' && next === '/') {
			const end = source.indexOf('\n', i);
			i = end === -1 ? source.length : end;
			continue;
		}
		if (char === '/' && next === '*') {
			const end = source.indexOf('*/', i + 2);
			const body = source.slice(i, end === -1 ? source.length : end + 2);
			// Keep the newlines so line numbers and line-based scans survive.
			out += body.replace(/[^\n]/g, '');
			i = end === -1 ? source.length : end + 2;
			continue;
		}
		if (char === "'" || char === '"' || char === '`') {
			out += char;
			i++;
			while (i < source.length) {
				const inner = source[i];
				out += inner;
				i++;
				if (inner === '\\') {
					// An escape consumes the next character, quote included.
					if (i < source.length) {
						out += source[i];
						i++;
					}
					continue;
				}
				// A bare newline ends an unterminated '/" string: the source
				// is broken anyway, and stopping keeps the walk in step.
				if (inner === char || (char !== '`' && inner === '\n')) {
					break;
				}
			}
			continue;
		}
		out += char;
		i++;
	}
	return out;
}

/**
 * Statically extract the env-var names a config reads via envSecret().
 *
 * Text scan only — envSecret('NAME') / envSecret("NAME") / envSecret(`NAME`)
 * with a plain literal, in code and never in a comment. Calls with computed
 * arguments (variables, template interpolation) are counted as skipped so the
 * caller can say so.
 *
 * @param {string} source The playground.config.mjs source text.
 * @return {{names: string[], skipped: number}} Deduplicated names in source
 *                                              order, and the skipped count.
 */
export function scanEnvSecretNames(source) {
	const names = new Set();
	let skipped = 0;
	for (const match of stripComments(source).matchAll(
		/\benvSecret\s*\(\s*(?:(['"`])((?:(?!\1)[^\\\n${}])*)\1)?/g
	)) {
		const name = match[2];
		if (name !== undefined && VALID_NAME.test(name)) {
			names.add(name);
		} else {
			skipped++;
		}
	}
	return { names: [...names], skipped };
}

/**
 * Best-effort chmod to owner-only — the file holds credentials.
 *
 * An explicit chmod because writeFileSync's mode option is masked by the
 * caller's umask (see src/runtime-file.mjs), and because it also tightens a
 * file created permissive by an earlier version. Best-effort: chmod is a
 * near-noop on Windows and may fail on exotic filesystems, and the stubs are
 * more important than the mode.
 *
 * @param {string} file Env file path (absolute).
 */
function chmodOwnerOnly(file) {
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// Permissions stay the caller's.
	}
}

/**
 * Append commented stubs for unknown names to an env file, under a heading.
 *
 * A name is known when any line — set, commented stub, or `export`-prefixed —
 * already carries `NAME=`. Existing lines are never modified, so re-runs are
 * idempotent and filled-in values are never touched. The file (and its
 * directory) is created when missing, and chmodded owner-only (0600) on every
 * call that finds or writes it — it holds credentials. Both inputs are
 * sanitized before they touch the shared file: non-identifier names are
 * dropped, and the heading is collapsed to a single line (a newline in either
 * would inject env lines).
 *
 * @param {string[]} names             Names to ensure stubs for.
 * @param {string}   file              Env file path (absolute).
 * @param {Object}   [options]         Options.
 * @param {string}   [options.heading] Section heading written above new stubs.
 * @return {{created: boolean, stubbed: string[]}} Whether the file was
 *                                                 created, and the appended names.
 */
export function ensureCredentialStubs(names, file, { heading } = {}) {
	names = names.filter((name) => VALID_NAME.test(name));
	heading = heading?.replace(/\p{Cc}+/gu, ' ').trim();
	const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
	if (existing !== null) {
		// Tighten a pre-existing permissive file (e.g. created before the
		// chmod existed) even when there turns out to be nothing to append.
		chmodOwnerOnly(file);
	}
	const known = new Set();
	for (const line of (existing ?? '').split('\n')) {
		const match = line.match(
			/^\s*(?:#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/
		);
		if (match) {
			known.add(match[1]);
		}
	}
	const missing = names.filter((name) => !known.has(name));
	if (!missing.length) {
		return { created: false, stubbed: [] };
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	let body = existing ?? '';
	if (body && !body.endsWith('\n')) {
		body += '\n';
	}
	if (body) {
		body += '\n';
	}
	if (heading) {
		body += `# --- ${heading} ---\n`;
	}
	body += missing.map((name) => `# ${name}=`).join('\n') + '\n';
	fs.writeFileSync(file, body);
	chmodOwnerOnly(file);
	return { created: existing === null, stubbed: missing };
}

/**
 * The `credentials` subcommand: scan, stub, and report.
 *
 * Reports which names are already satisfied (from ambient env or any .env
 * source, same resolution as a launch) and which still need a value in the
 * central file. Never fails a run over a missing credential — mirroring
 * envSecret()'s non-fatal contract.
 *
 * @param {string} root                 Plugin root (cwd).
 * @param {Object} [options]            Options.
 * @param {Object} [options.env]        Ambient env (test injection).
 * @param {string} [options.globalFile] Central file path (test injection).
 * @return {{satisfied: string[], unset: string[], stubbed: string[]}|null}
 *   The report, or null when there is no config here.
 */
export function runCredentials(
	root,
	{ env = process.env, globalFile = globalEnvFile() } = {}
) {
	const configPath = path.join(root, CONFIG_FILENAME);
	if (!fs.existsSync(configPath)) {
		process.stderr.write(
			`✖ playground: no ${CONFIG_FILENAME} here — run from a plugin root (krokedil-playground init scaffolds one).\n`
		);
		process.exitCode = 1;
		return null;
	}
	// Commented-out examples are not configuration: scan the code only, or the
	// scaffolded config's own envSecret() example lands in the central file.
	const source = stripComments(fs.readFileSync(configPath, 'utf8'));
	const { names, skipped } = scanEnvSecretNames(source);
	if (skipped) {
		log(
			`${skipped} envSecret() call(s) use a computed name and can't be scanned — add those to the central file by hand.`
		);
	}

	// Same resolution as a launch (ambient > .env chain), against a copy so
	// the probe never mutates the real process.env.
	const resolved = { ...env };
	applyEnvFile(root, { env: resolved, globalFile });
	const isSet = (name) =>
		Object.hasOwn(resolved, name) && resolved[name] !== '';

	const slug =
		source.match(/\bslug\s*:\s*(['"`])([^'"`\n]+)\1/)?.[2] ??
		path.basename(root);
	const plugin = ensureCredentialStubs(names, globalFile, { heading: slug });
	const tooling = ensureCredentialStubs(TOOL_CREDENTIALS, globalFile, {
		heading: TOOL_HEADING,
	});

	const label = displayPath(globalFile);
	const satisfied = names.filter(isSet);
	const unset = names.filter((name) => !isSet(name));
	const stubbed = [...plugin.stubbed, ...tooling.stubbed];

	if (!names.length) {
		log(`no envSecret() names in ${CONFIG_FILENAME} — nothing to check.`);
	}
	for (const name of satisfied) {
		log(`✓ ${name} is set`);
	}
	for (const name of unset) {
		log(`✗ ${name} is not set — fill it in ${label}`);
	}
	if (stubbed.length) {
		log(`stubbed ${stubbed.length} new name(s) into ${label}`);
	}
	return { satisfied, unset, stubbed };
}
