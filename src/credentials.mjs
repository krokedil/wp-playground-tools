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
 * Statically extract the env-var names a config reads via envSecret().
 *
 * Text scan only — envSecret('NAME') / envSecret("NAME") / envSecret(`NAME`)
 * with a plain literal. Calls with computed arguments (variables, template
 * interpolation) are counted as skipped so the caller can say so.
 *
 * @param {string} source The playground.config.mjs source text.
 * @return {{names: string[], skipped: number}} Deduplicated names in source
 *                                              order, and the skipped count.
 */
export function scanEnvSecretNames(source) {
	const names = new Set();
	let skipped = 0;
	for (const match of source.matchAll(
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
 * Append commented stubs for unknown names to an env file, under a heading.
 *
 * A name is known when any line — set, commented stub, or `export`-prefixed —
 * already carries `NAME=`. Existing lines are never modified, so re-runs are
 * idempotent and filled-in values are never touched. The file (and its
 * directory) is created when missing.
 *
 * @param {string[]} names             Names to ensure stubs for.
 * @param {string}   file              Env file path (absolute).
 * @param {Object}   [options]         Options.
 * @param {string}   [options.heading] Section heading written above new stubs.
 * @return {{created: boolean, stubbed: string[]}} Whether the file was
 *                                                 created, and the appended names.
 */
export function ensureCredentialStubs(names, file, { heading } = {}) {
	const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
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
	const source = fs.readFileSync(configPath, 'utf8');
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
