/**
 * Package-manager detection tests. The semantics under test must stay
 * byte-compatible with krokedil-wp-ci's detection (see src/pm.mjs) — if a
 * case here changes, the CI side has to change with it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	PM_COMMANDS,
	detectPackageManager,
	execpathMatches,
	readPackageManagerField,
} from '../src/pm.mjs';

test('readPackageManagerField reads packageManager, then devEngines', () => {
	const cases = [
		[{ packageManager: 'pnpm@9.15.9' }, 'pnpm@9.15.9'],
		[{ packageManager: 'yarn@4.0.0' }, 'yarn@4.0.0'],
		[{ devEngines: { packageManager: 'pnpm@9' } }, 'pnpm@9'],
		[
			{ devEngines: { packageManager: { name: 'pnpm', version: '9' } } },
			'pnpm',
		],
		[{ devEngines: { packageManager: { version: '9' } } }, ''],
		[{}, ''],
		// packageManager wins over devEngines when both are strings…
		[
			{
				packageManager: 'npm@10',
				devEngines: { packageManager: 'pnpm@9' },
			},
			'npm@10',
		],
		// …but a non-string packageManager falls through to devEngines.
		[
			{
				packageManager: { name: 'npm' },
				devEngines: { packageManager: 'pnpm@9' },
			},
			'pnpm@9',
		],
	];
	for (const [pkg, expected] of cases) {
		assert.equal(
			readPackageManagerField(pkg),
			expected,
			JSON.stringify(pkg)
		);
	}
});

test('detectPackageManager: pnpm only when declared, npm otherwise', (t) => {
	const detect = (pkgBody) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-pm-'));
		t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
		if (pkgBody !== null) {
			fs.writeFileSync(path.join(dir, 'package.json'), pkgBody);
		}
		return detectPackageManager(dir);
	};

	const pnpmCases = [
		'{"packageManager":"pnpm@9.15.9"}',
		'{"packageManager":"pnpm"}',
		'{"packageManager":"pnpm@9.15.9+sha256.abcdef"}',
		'{"devEngines":{"packageManager":"pnpm@9"}}',
		'{"devEngines":{"packageManager":{"name":"pnpm","version":"9"}}}',
	];
	for (const body of pnpmCases) {
		assert.equal(detect(body), 'pnpm', body);
	}

	const npmCases = [
		'{"packageManager":"yarn@4.0.0"}',
		'{"packageManager":"npm@10.0.0"}',
		'{"packageManager":"pnpmx@1"}',
		'{"devEngines":{"packageManager":{"name":"yarn"}}}',
		'{"name":"undeclared"}',
		'{', // malformed — npm produces the clearer error
	];
	for (const body of npmCases) {
		assert.equal(detect(body), 'npm', body);
	}
	assert.equal(detect(null), 'npm', 'no package.json');
});

test('PM_COMMANDS matches the CI command vocabulary', () => {
	assert.deepEqual(PM_COMMANDS.pnpm.install, [
		'install',
		'--frozen-lockfile',
	]);
	assert.deepEqual(PM_COMMANDS.pnpm.installFallback, [
		'install',
		'--no-frozen-lockfile',
	]);
	assert.equal(PM_COMMANDS.pnpm.lockfile, 'pnpm-lock.yaml');
	assert.deepEqual(PM_COMMANDS.npm.install, ['ci']);
	assert.deepEqual(PM_COMMANDS.npm.installFallback, ['install']);
	assert.equal(PM_COMMANDS.npm.lockfile, 'package-lock.json');
});

test('execpathMatches: npm matches on the exact basename only', () => {
	const pnpmPath = '/usr/lib/node_modules/pnpm/bin/pnpm.cjs';
	const npmPath = '/usr/lib/node_modules/npm/bin/npm-cli.js';
	assert.equal(execpathMatches('pnpm', pnpmPath), true);
	assert.equal(execpathMatches('npm', npmPath), true);
	// The substring trap: a pnpm execpath contains "npm" but is not npm.
	assert.equal(execpathMatches('npm', pnpmPath), false);
	assert.equal(execpathMatches('pnpm', npmPath), false);
	assert.equal(execpathMatches('pnpm', undefined), false);
	assert.equal(execpathMatches('npm', undefined), false);
});
