/**
 * SQLite stress harness: reproduce / rule out multi-worker database
 * corruption in the Playground CLI runtime.
 *
 * Each iteration provisions the current plugin's persistent site from
 * scratch (`start --fresh`), hammers it with concurrent session-writing
 * requests (login, guest-mode logout, cron pokes, reads), shuts the server
 * down, and runs `PRAGMA integrity_check` against the site's `.ht.sqlite`
 * with the host's sqlite3 binary. A corruption regression — like the
 * "database disk image is malformed" 500s seen on @wp-playground/cli 3.1.47
 * before blueprints disabled the background auto-updater — shows up as a
 * failed integrity check or a broken post-burst probe.
 *
 * Manual tool, not part of `pnpm test` (it boots real servers and needs the
 * network on first run). Run it from a plugin root (anything with a
 * playground.config.mjs — the committed sandbox works):
 *
 *   cd sandbox && node ../scripts/stress-db.mjs [iterations] [burstSeconds]
 *
 * Note: `node scripts/…` runs on your ambient Node, not the pnpm-pinned one.
 * To match the version consumers get, invoke the pinned binary directly
 * (`pnpm exec` won't do — it resets cwd to the nearest package root):
 *
 *   "$(pnpm exec node -e 'console.log(process.execPath)')" ../scripts/stress-db.mjs
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadConfig, MODE_PORT_OFFSETS } from '../src/config.mjs';
import { computeSiteHash } from '../src/prepare.mjs';

const ROOT = process.cwd();
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const ITERATIONS = Number(process.argv[2] ?? 4);
const BURST_SECONDS = Number(process.argv[3] ?? 45);
const HAMMER_WORKERS = 12;

const config = await loadConfig(ROOT);
const base = `http://127.0.0.1:${config.basePort + MODE_PORT_OFFSETS.start}`;
const db = path.join(
	os.homedir(),
	'.wordpress-playground',
	'sites',
	computeSiteHash(ROOT),
	'wp-content',
	'database',
	'.ht.sqlite'
);

/**
 * GET a URL, following redirects, swallowing failures (the server may be
 * mid-boot or mid-crash — that's what the probe afterwards is for).
 *
 * @param {string} url Absolute URL.
 * @return {Promise<number|null>} Status code, or null on network failure.
 */
async function get(url) {
	try {
		const res = await fetch(url, {
			redirect: 'follow',
			signal: AbortSignal.timeout(10000),
		});
		await res.arrayBuffer();
		return res.status;
	} catch {
		return null;
	}
}

/**
 * One hammer worker: loop session-writing and reading requests until the
 * deadline. Every wp-login.php GET is cookie-less, so each one performs a
 * full login and writes a session row — the heaviest realistic write burst
 * a dev site sees.
 *
 * @param {number} deadline Epoch ms to stop at.
 */
async function hammer(deadline) {
	while (Date.now() < deadline) {
		await get(`${base}/wp-login.php`);
		await get(`${base}/`);
		await get(`${base}/wp-json`);
		await get(`${base}/?krokedil-guest=1`);
		await get(`${base}/wp-cron.php?doing_wp_cron`);
	}
}

/**
 * Run sqlite3 against the site database.
 *
 * @param {string} pragma Pragma statement.
 * @return {string} First line of output (or the error message).
 */
function sqlite(pragma) {
	try {
		return execFileSync('sqlite3', [db, pragma], { encoding: 'utf8' })
			.trim()
			.split('\n')[0];
	} catch (err) {
		return `sqlite3 failed: ${err.message}`;
	}
}

let broken = 0;
for (let i = 1; i <= ITERATIONS; i++) {
	process.stdout.write(
		`=== iteration ${i}/${ITERATIONS} (fresh boot + ${BURST_SECONDS}s burst) ===\n`
	);

	const { default: spawn } = await import('cross-spawn');
	const child = spawn(
		process.execPath,
		[CLI, 'start', '--fresh'],
		// Keep the CLI's output out of the report; boot failures surface via
		// the readiness probe below.
		{ cwd: ROOT, stdio: 'ignore' }
	);
	const exited = new Promise((resolve) => child.on('exit', resolve));

	let ready = false;
	for (let t = 0; t < 120 && !ready; t++) {
		await new Promise((r) => setTimeout(r, 3000));
		ready = (await get(`${base}/wp-json`)) === 200;
	}
	if (!ready) {
		process.stdout.write('!! server never became ready; skipping\n');
		child.kill('SIGKILL');
		await exited;
		broken++;
		continue;
	}

	const deadline = Date.now() + BURST_SECONDS * 1000;
	await Promise.all(
		Array.from({ length: HAMMER_WORKERS }, () => hammer(deadline))
	);

	const probe = await get(`${base}/`);
	child.kill('SIGINT');
	await Promise.race([exited, new Promise((r) => setTimeout(r, 20000))]);
	child.kill('SIGKILL');
	await exited;

	const journal = sqlite('PRAGMA journal_mode;');
	const integrity = sqlite('PRAGMA integrity_check;');
	const bad = probe !== 200 || integrity !== 'ok';
	if (bad) {
		broken++;
	}
	process.stdout.write(
		`-- post-burst probe: ${probe}  journal_mode=${journal}  integrity: ${integrity}${
			bad ? '  << BROKEN' : ''
		}\n`
	);
}

process.stdout.write(
	`=== done: ${broken}/${ITERATIONS} iterations broken ===\n`
);
process.exit(broken ? 1 : 0);
