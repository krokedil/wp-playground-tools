/**
 * Tests for the PHP advisory gate: version comparison, the effective-branch
 * rules (blueprint beats --php; a warm start uses --php or the CLI default),
 * and the blocker verdicts per branch — all via injected facts, pure/offline.
 * One smoke test resolves the real installed @php-wasm build.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../src/config.mjs';
import {
	FIXED_PHP_BUILDS,
	comparePhpVersions,
	effectivePhpBranch,
	installedPhpBuild,
	vulnerablePhpBlocker,
} from '../src/php-advisories.mjs';
import { buildModes } from '../src/prepare.mjs';

const CONFIG = normalizeConfig({ slug: 'a-plugin' });

const facts = (build, provisioned = false) => ({
	installedPhpBuild: () => build,
	isProvisioned: () => provisioned,
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
