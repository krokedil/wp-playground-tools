/**
 * Tests for the bootstrap shim template (src/init/templates/playground-shim.mjs).
 *
 * The shim's install runs through a recorder stub passed as npm_execpath —
 * offline, nothing on PATH is spawned: the stub logs its argv and exits 1, so
 * the shim walks its strict install → fallback → failure path and we can
 * assert exactly which commands each manager would have run.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SHIM_TEMPLATE = fileURLToPath(
	new URL('../src/init/templates/playground-shim.mjs', import.meta.url)
);

// The stub records its argv and fails, forcing strict + fallback attempts.
const STUB_SOURCE = `const fs = require('node:fs');
fs.appendFileSync(process.env.PM_STUB_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(1);
`;

/**
 * Run the shim in a temp plugin root against a recorder stub.
 *
 * @param {Object}      t        node:test context for cleanup.
 * @param {string|null} pkgBody  package.json contents (null: none).
 * @param {string}      stubName Stub filename — must satisfy the shim's
 *                               npm_execpath check for the expected manager.
 * @return {Object} { res, recorded } — spawn result + recorded argv arrays.
 */
function runShim(t, pkgBody, stubName) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-shim-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, 'tools'));
	fs.copyFileSync(SHIM_TEMPLATE, path.join(root, 'tools', 'playground.mjs'));
	if (pkgBody !== null) {
		fs.writeFileSync(path.join(root, 'package.json'), pkgBody);
	}
	const stubPath = path.join(root, stubName);
	fs.writeFileSync(stubPath, STUB_SOURCE);
	const logPath = path.join(root, 'stub.log');
	const res = spawnSync(
		process.execPath,
		[path.join(root, 'tools', 'playground.mjs'), 'setup'],
		{
			cwd: root,
			encoding: 'utf8',
			env: {
				...process.env,
				npm_execpath: stubPath,
				PM_STUB_LOG: logPath,
			},
		}
	);
	const recorded = fs.existsSync(logPath)
		? fs
				.readFileSync(logPath, 'utf8')
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line))
		: [];
	return { res, recorded };
}

test('shim installs a pnpm-declared plugin with pnpm (strict, then fallback)', (t) => {
	const { res, recorded } = runShim(
		t,
		'{"packageManager":"pnpm@9.15.9"}',
		'pnpm.cjs'
	);
	assert.deepEqual(recorded, [
		['install', '--frozen-lockfile'],
		['install', '--no-frozen-lockfile'],
	]);
	assert.equal(res.status, 1);
	assert.match(res.stderr, /installing Node dependencies \(pnpm install\)/);
	assert.match(res.stderr, /pnpm install failed/);
});

test('shim installs an undeclared plugin with npm (ci, then install)', (t) => {
	const { res, recorded } = runShim(
		t,
		'{"name":"undeclared-plugin"}',
		'npm-cli.js'
	);
	assert.deepEqual(recorded, [['ci'], ['install']]);
	assert.equal(res.status, 1);
	assert.match(res.stderr, /installing Node dependencies \(npm ci\)/);
	assert.match(res.stderr, /npm install failed/);
});

test('shim never treats a pnpm execpath as npm (basename check)', (t) => {
	// npm-detected plugin, but npm_execpath points at pnpm's entry: the shim
	// must NOT reuse it. It falls through to PATH — stub that out by making
	// the spawn fail fast (manager binary 'npm' resolved against an empty
	// PATH), and assert the pnpm stub was never invoked.
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-shim-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, 'tools'));
	fs.copyFileSync(SHIM_TEMPLATE, path.join(root, 'tools', 'playground.mjs'));
	fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}');
	const stubPath = path.join(root, 'pnpm.cjs');
	fs.writeFileSync(stubPath, STUB_SOURCE);
	const logPath = path.join(root, 'stub.log');
	const res = spawnSync(
		process.execPath,
		[path.join(root, 'tools', 'playground.mjs'), 'setup'],
		{
			cwd: root,
			encoding: 'utf8',
			env: {
				PATH: root, // no npm here — the PATH spawn errors out
				npm_execpath: stubPath,
				PM_STUB_LOG: logPath,
			},
		}
	);
	assert.equal(res.status, 1);
	assert.ok(!fs.existsSync(logPath), 'the pnpm stub was never invoked');
});
