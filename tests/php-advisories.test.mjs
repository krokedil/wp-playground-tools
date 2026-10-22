/**
 * Tests for the PHP advisory gate: version comparison, the effective-branch
 * rules (blueprint beats --php; a warm start uses --php or the CLI default),
 * and the blocker verdicts per branch — all via injected facts, pure/offline.
 * One smoke test resolves the real installed @php-wasm build.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeConfig } from '../src/config.mjs';
import {
	FIXED_PHP_BUILDS,
	comparePhpVersions,
	effectivePhpBranch,
	installedPhpBuild,
	readBlueprintPhp,
	vulnerablePhpBlocker,
} from '../src/php-advisories.mjs';
import { buildModes } from '../src/prepare.mjs';

const CONFIG = normalizeConfig({ slug: 'a-plugin' });

const facts = (build, provisioned = false, blueprintPhp) => ({
	installedPhpBuild: () => build,
	isProvisioned: () => provisioned,
	// undefined = unreadable file; { php } = what the blueprint pins.
	readBlueprintPhp: () => blueprintPhp ?? null,
});

// --- comparePhpVersions -------------------------------------------------------

test('version compare: orders point releases numerically', () => {
	assert.ok(comparePhpVersions('8.3.32', '8.3.36') < 0);
	assert.ok(comparePhpVersions('8.3.36', '8.3.32') > 0);
	assert.equal(comparePhpVersions('8.3.36', '8.3.36'), 0);
	// 8.3.4 < 8.3.36: numeric, not lexicographic.
	assert.ok(comparePhpVersions('8.3.4', '8.3.36') < 0);
	// Missing segments count as zero.
	assert.ok(comparePhpVersions('8.3', '8.3.1') < 0);
});

// --- effectivePhpBranch -------------------------------------------------------

test('effective branch: server modes take config.php, --php loses', () => {
	const config = normalizeConfig({ slug: 'a-plugin', php: '8.2' });
	const mode = buildModes(config).development;
	assert.equal(effectivePhpBranch(config, mode, ['--php=8.4'], false), '8.2');
});

test('effective branch: a provisioning start takes config.php', () => {
	const config = normalizeConfig({ slug: 'a-plugin', php: '8.2' });
	const mode = buildModes(config).start;
	assert.equal(effectivePhpBranch(config, mode, [], false), '8.2');
	assert.equal(effectivePhpBranch(config, mode, ['--fresh'], true), '8.2');
});

test('effective branch: a warm start uses --php, else the CLI default', () => {
	const config = normalizeConfig({ slug: 'a-plugin', php: '8.2' });
	const mode = buildModes(config).start;
	assert.equal(effectivePhpBranch(config, mode, ['--php=8.4'], true), '8.4');
	assert.equal(effectivePhpBranch(config, mode, [], true), '8.3');
});

// --- vulnerablePhpBlocker -----------------------------------------------------

test('php gate: a patched build passes', () => {
	assert.equal(
		vulnerablePhpBlocker('/x', CONFIG, 'development', [], facts('8.3.36')),
		null
	);
	assert.equal(
		vulnerablePhpBlocker('/x', CONFIG, 'development', [], facts('8.3.40')),
		null
	);
});

test('php gate: a vulnerable build is refused, naming both versions', () => {
	const blocker = vulnerablePhpBlocker(
		'/x',
		CONFIG,
		'development',
		[],
		facts('8.3.32')
	);
	assert.match(blocker, /8\.3\.32/);
	assert.match(blocker, /8\.3\.36/);
	assert.match(blocker, /PHP2Shell/);
	assert.match(blocker, /KROKEDIL_PG_ALLOW_VULNERABLE_PHP/);
});

test('php gate: an EOL branch is refused outright', () => {
	const config = normalizeConfig({ slug: 'a-plugin', php: '8.1' });
	const blocker = vulnerablePhpBlocker(
		'/x',
		config,
		'development',
		[],
		facts('8.1.33')
	);
	assert.match(blocker, /end-of-life/);
	assert.match(blocker, /8\.2/);
});

test('php gate: an unknown installed build fails closed', () => {
	const blocker = vulnerablePhpBlocker(
		'/x',
		CONFIG,
		'development',
		[],
		facts(null)
	);
	assert.match(blocker, /could not determine/);
	assert.match(blocker, /assumed vulnerable/);
});

test('php gate: a warm start is judged on its effective branch, not config', () => {
	// Config pins an EOL branch, but the warm start boots the CLI default
	// (8.3) — the verdict must come from the 8.3 build.
	const config = normalizeConfig({ slug: 'a-plugin', php: '8.1' });
	assert.equal(
		vulnerablePhpBlocker('/x', config, 'start', [], facts('8.3.36', true)),
		null
	);
});

test('php gate: a custom blueprint pinning an EOL branch is refused', () => {
	// config.php is safe, but the user blueprint boots 8.1 — the gate must
	// judge the blueprint's pin, not config.php.
	const blocker = vulnerablePhpBlocker(
		'/x',
		CONFIG,
		'start',
		['--blueprint=custom.json'],
		facts('8.3.36', true, { php: '8.1' })
	);
	assert.match(blocker, /end-of-life/);
});

test('php gate: a custom blueprint without a pin falls back to --php/default', () => {
	// Blueprint sets no php → the CLI applies --php, else its default.
	const safe = vulnerablePhpBlocker(
		'/x',
		CONFIG,
		'start',
		['--blueprint=custom.json', '--php=8.3'],
		facts('8.3.36', true, { php: null })
	);
	assert.equal(safe, null);
	const eol = vulnerablePhpBlocker(
		'/x',
		CONFIG,
		'start',
		['--blueprint=custom.json', '--php=8.0'],
		facts('8.3.36', true, { php: null })
	);
	assert.match(eol, /end-of-life/);
});

test('php gate: an unreadable custom blueprint fails closed', () => {
	const blocker = vulnerablePhpBlocker(
		'/x',
		CONFIG,
		'start',
		['--blueprint=missing.json'],
		facts('8.3.36', true, undefined)
	);
	assert.match(blocker, /could not read a PHP version/);
	assert.match(blocker, /missing\.json/);
});

test('php gate: a non-branch version like "latest" fails closed', () => {
	const blocker = vulnerablePhpBlocker(
		'/x',
		CONFIG,
		'start',
		['--blueprint=custom.json'],
		facts('8.3.36', true, { php: 'latest' })
	);
	assert.match(blocker, /cannot map the requested PHP version 'latest'/);
});

test('php gate: the fixed-builds map covers exactly the supported branches', () => {
	assert.deepEqual(Object.keys(FIXED_PHP_BUILDS).sort(), [
		'8.2',
		'8.3',
		'8.4',
		'8.5',
	]);
	for (const [branch, fixed] of Object.entries(FIXED_PHP_BUILDS)) {
		assert.ok(fixed.startsWith(`${branch}.`));
	}
});

// --- installedPhpBuild (smoke, against the real installed dep) ----------------

test('installed build: resolves a real point release for 8.3', () => {
	const build = installedPhpBuild('8.3');
	assert.match(build, /^8\.3\.\d+$/);
});

test('installed build: returns null for a nonsense branch', () => {
	assert.equal(installedPhpBuild('9.9'), null);
	assert.equal(installedPhpBuild('not-a-branch'), null);
});

// --- readBlueprintPhp ----------------------------------------------------------

test('blueprint pin: reads a pin, tolerates absence, fails on garbage', (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-bp-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const pinned = path.join(dir, 'pinned.json');
	fs.writeFileSync(
		pinned,
		JSON.stringify({ preferredVersions: { php: '8.1' } })
	);
	assert.deepEqual(readBlueprintPhp(pinned), { php: '8.1' });

	const bare = path.join(dir, 'bare.json');
	fs.writeFileSync(bare, '{"steps":[]}');
	assert.deepEqual(readBlueprintPhp(bare), { php: null });

	assert.equal(readBlueprintPhp(path.join(dir, 'missing.json')), null);

	const garbage = path.join(dir, 'garbage.json');
	fs.writeFileSync(garbage, 'not json');
	assert.equal(readBlueprintPhp(garbage), null);
});
