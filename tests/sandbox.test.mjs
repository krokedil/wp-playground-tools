/**
 * Guards the committed sandbox: its config must keep normalizing and
 * composing as the schema evolves, so `pnpm run sandbox:*` cannot silently
 * rot. Also covers the ensurePrereqs package.json gate the sandbox relies on
 * (sandbox/ has no package.json of its own).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { composeBlueprint } from '../src/blueprint/compose.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { ensurePrereqs } from '../src/prepare.mjs';
import sandboxRawConfig from '../sandbox/playground.config.mjs';

const sandboxConfig = normalizeConfig(sandboxRawConfig, {
	hasComposerJson: false,
});

test('sandbox config normalizes with the expected identity', () => {
	assert.equal(sandboxConfig.slug, 'krokedil-playground-sandbox');
	assert.equal(sandboxConfig.basePort, 9880);
	assert.equal(sandboxConfig.tunnel.provider, 'ngrok');
	assert.equal(sandboxConfig.composer, null);
	assert.equal(sandboxConfig.build, null);
	assert.deepEqual(sandboxConfig.activate, ['krokedil-playground-sandbox']);
	assert.deepEqual(sandboxConfig.https.hosts, ['localhost']);
});

test('sandbox blueprints compose for every configured server mode', () => {
	for (const mode of sandboxConfig.modes.filter((m) => m !== 'start')) {
		const blueprint = composeBlueprint(sandboxConfig, mode);
		assert.ok(
			Array.isArray(blueprint.steps) && blueprint.steps.length > 0,
			`${mode}: blueprint has steps`
		);
		const json = JSON.stringify(blueprint);
		assert.ok(
			json.includes(
				'/wordpress/wp-content/plugins/krokedil-playground-sandbox'
			),
			`${mode}: container paths derive from the sandbox slug`
		);
		assert.ok(
			json.includes('plugin activate krokedil-playground-sandbox'),
			`${mode}: the sandbox plugin is activated`
		);
	}
});

test('ensurePrereqs fails actionably when "build" is set without package.json', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sandbox-build-'));
	const prepareUrl = new URL('../src/prepare.mjs', import.meta.url).href;
	try {
		// fail() exits the process, so run the guard in a subprocess.
		const res = spawnSync(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`import { ensurePrereqs } from '${prepareUrl}';
				ensurePrereqs(process.argv[1], {
					composer: null,
					build: { markers: ['build/index.js'], command: 'build' },
				}, false);`,
				dir,
			],
			{ encoding: 'utf8' }
		);
		assert.equal(res.status, 1);
		assert.match(res.stderr, /declares "build".*no package\.json/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('ensurePrereqs installs with the manager detected from package.json', (t) => {
	// Offline: npm_execpath points at a recorder stub that logs its argv and
	// exits 0, so the strict install "succeeds" and nothing on PATH is spawned.
	const stubSource = `const fs = require('node:fs');
fs.appendFileSync(process.env.PM_STUB_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
`;
	const run = (pkgBody, stubName) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-prereq-pm-'));
		t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
		fs.writeFileSync(path.join(dir, 'package.json'), pkgBody);
		const stubPath = path.join(dir, stubName);
		fs.writeFileSync(stubPath, stubSource);
		const logPath = path.join(dir, 'stub.log');
		const saved = {
			npm_execpath: process.env.npm_execpath,
			PM_STUB_LOG: process.env.PM_STUB_LOG,
		};
		process.env.npm_execpath = stubPath;
		process.env.PM_STUB_LOG = logPath;
		try {
			ensurePrereqs(dir, { composer: null, build: null }, false);
		} finally {
			process.env.npm_execpath = saved.npm_execpath;
			if (saved.PM_STUB_LOG === undefined) {
				delete process.env.PM_STUB_LOG;
			} else {
				process.env.PM_STUB_LOG = saved.PM_STUB_LOG;
			}
		}
		return fs
			.readFileSync(logPath, 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
	};

	assert.deepEqual(run('{"name":"undeclared"}', 'npm-cli.js'), [['ci']]);
	assert.deepEqual(run('{"packageManager":"pnpm@9.15.9"}', 'pnpm.cjs'), [
		['install', '--frozen-lockfile'],
	]);
});

test('ensurePrereqs is a no-op for a root without package.json', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sandbox-prereqs-'));
	try {
		ensurePrereqs(dir, sandboxConfig, false);
		assert.ok(
			!fs.existsSync(path.join(dir, 'node_modules')),
			'no node_modules was created'
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
