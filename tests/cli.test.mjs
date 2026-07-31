/**
 * Tests for the CLI dispatch layer: the tunnel-guard pre-flight (the check
 * that keeps a pre-guard site from being published with the default admin
 * password), flag validation, and the --help/--version surface.
 *
 * tunnelGuardBlocker is tested in-process via its injected site-state facts;
 * everything argv-facing runs the real bin in a subprocess.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { tunnelGuardBlocker } from '../src/cli.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { deriveSiteId } from '../src/site-id.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

const runCli = (args, cwd) =>
	spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });

const tmpPlugin = (t, configSource) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cli-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	if (configSource) {
		fs.writeFileSync(
			path.join(root, 'playground.config.mjs'),
			configSource
		);
	}
	return root;
};

// --- tunnelGuardBlocker ------------------------------------------------------

const CONFIG = normalizeConfig({ slug: 'a-plugin' });
const facts = (provisioned, linked) => ({
	isProvisioned: () => provisioned,
	isMuPluginLinked: () => linked,
});

test('tunnel guard: non-persistent modes are never blocked', () => {
	assert.equal(
		tunnelGuardBlocker('/x', CONFIG, 'development', [], facts(true, false)),
		null
	);
});

test('tunnel guard: an unprovisioned site is safe (first boot links it)', () => {
	assert.equal(
		tunnelGuardBlocker('/x', CONFIG, 'start', [], facts(false, false)),
		null
	);
});

test('tunnel guard: a provisioning run (--fresh) is safe', () => {
	assert.equal(
		tunnelGuardBlocker(
			'/x',
			CONFIG,
			'start',
			['--fresh'],
			facts(true, false)
		),
		null
	);
});

test('tunnel guard: a warm site with the guard linked is safe', () => {
	assert.equal(
		tunnelGuardBlocker('/x', CONFIG, 'start', [], facts(true, true)),
		null
	);
});

test('tunnel guard: a warm pre-guard site is refused with the --fresh hint', () => {
	const blocker = tunnelGuardBlocker(
		'/x',
		CONFIG,
		'start',
		[],
		facts(true, false)
	);
	assert.match(blocker, /provisioned before the tunnel admin guard/);
	assert.match(blocker, /--fresh/);
});

// --- argv surface (subprocess) ----------------------------------------------

test('--help prints the full help on stdout and exits 0', () => {
	const res = runCli(['--help']);
	assert.equal(res.status, 0);
	assert.match(res.stdout, /usage: krokedil-playground/);
	assert.match(res.stdout, /--tunnel-domain/);
	assert.equal(res.stderr, '');
});

test('--version prints the package version on stdout and exits 0', () => {
	const pkg = JSON.parse(
		fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
	);
	const res = runCli(['--version']);
	assert.equal(res.status, 0);
	assert.equal(res.stdout, `${pkg.version}\n`);
});

test('site-id prints this checkout id on stdout, without a config', (t) => {
	const root = tmpPlugin(t);
	const res = runCli(['site-id'], root);
	assert.equal(res.status, 0);
	// stdout stays the bare token, so it pipes into other commands; the
	// human-facing context goes to stderr.
	assert.match(res.stdout, /^[0-9a-f]{8}\n$/);
	assert.match(res.stderr, /order numbers on this site read/);
	// The id keys on process.cwd(), which the OS reports realpath'd — the same
	// string the Playground CLI hashes for the site directory, so a symlinked
	// checkout still lands on one identity.
	assert.equal(res.stdout.trim(), deriveSiteId(fs.realpathSync(root)));
});

test('site-id exits 1 with guidance for an id nothing has booted', (t) => {
	const root = tmpPlugin(t);
	const res = runCli(['site-id', 'ffffffff'], root);
	assert.equal(res.status, 1);
	assert.match(res.stderr, /no checkout known for "ffffffff"/);
});

test('an unknown command prints usage on stderr and exits 1', () => {
	const res = runCli(['bogus-command']);
	assert.equal(res.status, 1);
	assert.match(res.stderr, /usage: krokedil-playground/);
});

test('--tunnel and --https are mutually exclusive', (t) => {
	const root = tmpPlugin(t); // no config needed — the check runs first
	const res = runCli(['start', '--tunnel', '--https'], root);
	assert.equal(res.status, 1);
	assert.match(res.stderr, /✖ playground: --tunnel and --https/);
});

test('--tunnel-domain rejects non-hostnames before doing anything', (t) => {
	const root = tmpPlugin(t);
	const res = runCli(['start', '--tunnel-domain=https://x.io'], root);
	assert.equal(res.status, 1);
	assert.match(res.stderr, /"--tunnel-domain" must be a bare hostname/);
});

test('server validates its mode against the config, not the launch table', (t) => {
	const root = tmpPlugin(
		t,
		"export default { slug: 'a-plugin', basePort: 9930 };\n"
	);
	for (const args of [['server'], ['server', 'bogus']]) {
		const res = runCli(args, root);
		assert.equal(res.status, 1);
		assert.match(res.stderr, /server needs a mode: development \| demo/);
		// setup/start live in the launch table but are not server modes.
		assert.doesNotMatch(res.stderr, /setup/);
	}
});

test('server on a start-only plugin explains the modes opt-in', (t) => {
	const root = tmpPlugin(
		t,
		"export default { slug: 'a-plugin', basePort: 9930, modes: ['start'] };\n"
	);
	const res = runCli(['server', 'development'], root);
	assert.equal(res.status, 1);
	assert.match(res.stderr, /only configures the persistent 'start' mode/);
	assert.match(res.stderr, /add development\/demo\/e2e to "modes"/);
});

test('a missing config errors in the package voice, without a stack trace', (t) => {
	const root = tmpPlugin(t);
	const res = runCli(['compose'], root);
	assert.equal(res.status, 1);
	assert.match(
		res.stderr,
		/✖ playground: playground\.config\.mjs: not found/
	);
	assert.doesNotMatch(res.stderr, /at .*config\.mjs:\d/);
});

test('staging errors carry exactly one playground prefix', (t) => {
	const root = tmpPlugin(
		t,
		"export default { slug: 'a-plugin', basePort: 9930, woocommerce: false, muPlugins: ['tools/nope.php'] };\n"
	);
	const res = runCli(['compose'], root);
	assert.equal(res.status, 1);
	assert.match(res.stderr, /✖ playground: mu-plugin not found/);
	assert.doesNotMatch(res.stderr, /playground: playground:/);
});
