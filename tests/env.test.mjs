/**
 * Tests for .env loading and envSecret in src/env.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyEnvFile, envSecret } from '../src/env.mjs';

/**
 * Create a temp plugin root, optionally with a .env file.
 *
 * @param {Object}      t       node:test context for cleanup.
 * @param {string|null} envFile .env content, or null for none.
 * @return {string} The temp root.
 */
function makeRoot(t, envFile = null) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-env-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	if (envFile !== null) {
		fs.writeFileSync(path.join(root, '.env'), envFile);
	}
	return root;
}

/**
 * Silence + capture stderr for the duration of a test.
 *
 * @param {Object} t node:test context.
 * @return {Function} Returns everything written so far as one string.
 */
function captureStderr(t) {
	const mock = t.mock.method(process.stderr, 'write', () => true);
	return () => mock.mock.calls.map((c) => String(c.arguments[0])).join('');
}

test('applyEnvFile loads values without overriding ambient env', (t) => {
	captureStderr(t);
	const root = makeRoot(t, 'FRESH=from-file\nAMBIENT=from-file\nEMPTY=x\n');
	const env = { AMBIENT: 'from-shell', EMPTY: '' };
	const result = applyEnvFile(root, { env });

	assert.equal(result.loaded, true);
	assert.deepEqual(result.applied, ['FRESH']);
	assert.equal(env.FRESH, 'from-file');
	// Ambient wins — even an ambient empty string (the fork-PR CI case;
	// envSecret treats '' as unset anyway).
	assert.equal(env.AMBIENT, 'from-shell');
	assert.equal(env.EMPTY, '');
});

test('applyEnvFile is a silent no-op without a .env (the CI case)', (t) => {
	const captured = captureStderr(t);
	const env = {};
	const result = applyEnvFile(makeRoot(t), { env });
	assert.deepEqual(result, { loaded: false, applied: [] });
	assert.deepEqual(env, {});
	assert.equal(captured(), '');
});

test('applyEnvFile handles export prefixes, quotes and multi-line values', (t) => {
	captureStderr(t);
	const root = makeRoot(
		t,
		'export EXPORTED=yes\n' +
			"QUOTED='hello world' # trailing comment\n" +
			'PEM="line one\nline two"\n'
	);
	const env = {};
	applyEnvFile(root, { env });
	assert.equal(env.EXPORTED, 'yes');
	assert.equal(env.QUOTED, 'hello world');
	assert.equal(env.PEM, 'line one\nline two');
});

test('applyEnvFile strips a leading BOM', (t) => {
	captureStderr(t);
	const env = {};
	applyEnvFile(makeRoot(t, '\uFEFFFIRST=1\n'), { env });
	assert.equal(env.FIRST, '1');
});

test('applyEnvFile never echoes a malformed line', (t) => {
	const captured = captureStderr(t);
	// parseEnv differs by Node version: Node 20 glues a line without "=" into
	// the next line's key (SWALLOWED is lost and the warning is the only
	// signal); Node 22+ drops the bare line and parses SWALLOWED normally.
	// Either way the pasted secret must never reach stderr.
	const root = makeRoot(
		t,
		'OK=1\nsk_live_pasted_secret_no_equals\nSWALLOWED=2\n'
	);
	const env = {};
	applyEnvFile(root, { env });

	assert.equal(env.OK, '1');
	const output = captured();
	assert.ok(!output.includes('sk_live_pasted_secret_no_equals'));
	if (env.SWALLOWED !== '2') {
		assert.match(output, /malformed line/);
	}
});

test('applyEnvFile falls back to the main checkout .env from a linked worktree', (t) => {
	captureStderr(t);
	const main = makeRoot(t, 'SHARED=from-main\nONLY_MAIN=main\n');
	fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), {
		recursive: true,
	});

	const worktree = makeRoot(t, 'SHARED=from-worktree\n');
	fs.writeFileSync(
		path.join(worktree, '.git'),
		`gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`
	);

	const env = {};
	const result = applyEnvFile(worktree, { env });
	// Untracked files never transfer into worktrees — the fallback is what
	// makes a fresh worktree session boot configured.
	assert.equal(env.ONLY_MAIN, 'main');
	assert.equal(env.SHARED, 'from-worktree');
	assert.deepEqual(result.applied.sort(), ['ONLY_MAIN', 'SHARED']);
});

test('applyEnvFile ignores an unparseable .git file', (t) => {
	captureStderr(t);
	const root = makeRoot(t, 'A=1\n');
	fs.writeFileSync(path.join(root, '.git'), 'not a gitdir pointer\n');
	const env = {};
	const result = applyEnvFile(root, { env });
	assert.equal(env.A, '1');
	assert.deepEqual(result.applied, ['A']);
});

test('applyEnvFile applies names shadowing Object.prototype members', (t) => {
	captureStderr(t);
	const env = {};
	// `name in env` would see the inherited toString and silently skip it.
	applyEnvFile(makeRoot(t, 'toString=shadowed\n'), { env });
	assert.equal(env.toString, 'shadowed');
});

test('applyEnvFile rejects reserved names, naming them', (t) => {
	const captured = captureStderr(t);
	const env = {};
	const result = applyEnvFile(makeRoot(t, 'prototype=evil\nSAFE=1\n'), {
		env,
	});
	assert.equal(env.SAFE, '1');
	assert.deepEqual(result.applied, ['SAFE']);
	assert.ok(!Object.hasOwn(env, 'prototype'));
	assert.match(captured(), /reserved variable name "prototype"/);
});

test('applyEnvFile never pollutes the prototype via __proto__', (t) => {
	captureStderr(t);
	const env = {};
	// parseEnv drops __proto__ itself on some Node versions and surfaces it
	// on others — either way it must not reach the prototype link.
	applyEnvFile(makeRoot(t, '__proto__=evil\nSAFE=1\n'), { env });
	assert.equal(env.SAFE, '1');
	assert.equal(Object.getPrototypeOf(env), Object.prototype);
	assert.ok(!Object.hasOwn(env, '__proto__'));
});

test('envSecret ignores inherited properties', (t) => {
	const captured = captureStderr(t);
	// env.constructor exists on the prototype chain but is not an env var.
	assert.equal(envSecret('constructor', { env: {} }), undefined);
	assert.match(captured(), /constructor is not set/);
});

test('envSecret returns set values and treats unset/empty as missing', (t) => {
	const captured = captureStderr(t);
	const env = { PG_SET: 'value-123', PG_EMPTY: '' };

	assert.equal(envSecret('PG_SET', { env }), 'value-123');
	assert.equal(captured(), '');

	// '' is how GitHub Actions renders missing/fork-PR secrets.
	assert.equal(envSecret('PG_EMPTY', { env }), undefined);
	assert.equal(envSecret('PG_UNSET_A1', { env }), undefined);

	const output = captured();
	assert.match(output, /PG_EMPTY is not set/);
	assert.match(output, /PG_UNSET_A1 is not set/);
	assert.ok(!output.includes('value-123'));
});

test('envSecret warns once per name per process', (t) => {
	const captured = captureStderr(t);
	envSecret('PG_UNSET_B2', { env: {} });
	envSecret('PG_UNSET_B2', { env: {} });
	const warnings = captured().match(/PG_UNSET_B2/g);
	assert.equal(warnings.length, 1);
});
