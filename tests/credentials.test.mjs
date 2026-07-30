/**
 * Tests for credential discovery in src/credentials.mjs: the static
 * envSecret() scan, central-file stubbing, and the credentials subcommand.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	ensureCredentialStubs,
	runCredentials,
	scanEnvSecretNames,
} from '../src/credentials.mjs';

/**
 * Create a temp plugin root, optionally with a playground.config.mjs.
 *
 * @param {Object}      t      node:test context for cleanup.
 * @param {string|null} config Config source, or null for none.
 * @return {string} The temp root.
 */
function makeRoot(t, config = null) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cred-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	if (config !== null) {
		fs.writeFileSync(path.join(root, 'playground.config.mjs'), config);
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

test('scanEnvSecretNames extracts literal names in all quote styles, deduplicated', () => {
	const { names, skipped } = scanEnvSecretNames(
		"const a = envSecret('SINGLE');\n" +
			'const b = envSecret("DOUBLE");\n' +
			'const c = envSecret(`BACKTICK`);\n' +
			"const d = envSecret( 'SPACED' );\n" +
			"const again = envSecret('SINGLE');\n"
	);
	assert.deepEqual(names, ['SINGLE', 'DOUBLE', 'BACKTICK', 'SPACED']);
	assert.equal(skipped, 0);
});

test('scanEnvSecretNames skips computed and invalid names', () => {
	const { names, skipped } = scanEnvSecretNames(
		"const ok = envSecret('OK_NAME');\n" +
			'const dynamic = envSecret(nameVar);\n' +
			'const interpolated = envSecret(`PREFIX_${mode}`);\n' +
			"const invalid = envSecret('not a name');\n"
	);
	assert.deepEqual(names, ['OK_NAME']);
	assert.equal(skipped, 3);
});

test('scanEnvSecretNames ignores imports and configs without envSecret', () => {
	const { names, skipped } = scanEnvSecretNames(
		"import { envSecret } from '@krokedil/wp-playground-tools';\n" +
			"export default { slug: 'plain' };\n"
	);
	assert.deepEqual(names, []);
	assert.equal(skipped, 0);
});

test('scanEnvSecretNames ignores calls inside line and block comments', () => {
	// The scaffolded config's own example lives in a comment — stubbing it
	// would put MY_TEST_SECRET in the shared central file on every onboard.
	const { names, skipped } = scanEnvSecretNames(
		"export default {\n\tslug: 'my-plugin',\n" +
			"\t// options: { all: { s: envSecret('MY_TEST_SECRET') } },\n" +
			'\t/* options: { all: {\n' +
			"\t\ts: envSecret('BLOCK_SECRET'),\n" +
			'\t} }, */\n' +
			'};\n'
	);
	assert.deepEqual(names, []);
	// Not even as unscannable calls — a comment is not configuration.
	assert.equal(skipped, 0);
});

test('scanEnvSecretNames keeps code around comments and comment-like strings', () => {
	const { names, skipped } = scanEnvSecretNames(
		"const url = 'https://example.com/*'; // not a comment start\n" +
			"const quoted = 'a // b /* c */ d';\n" +
			"const kept = envSecret('REAL_NAME'); // envSecret('COMMENTED')\n" +
			"const escaped = 'it\\'s // fine';\n" +
			"const also = envSecret('SECOND_NAME');\n"
	);
	assert.deepEqual(names, ['REAL_NAME', 'SECOND_NAME']);
	assert.equal(skipped, 0);
});

test('ensureCredentialStubs creates the file (and directory) with a heading', (t) => {
	const root = makeRoot(t);
	const file = path.join(root, 'deep', 'nested', '.env');
	const result = ensureCredentialStubs(['KEY_A', 'KEY_B'], file, {
		heading: 'my-plugin',
	});
	assert.equal(result.created, true);
	assert.deepEqual(result.stubbed, ['KEY_A', 'KEY_B']);
	assert.equal(
		fs.readFileSync(file, 'utf8'),
		'# --- my-plugin ---\n# KEY_A=\n# KEY_B=\n'
	);
	// The file will hold credentials — owner-only regardless of umask.
	// `% 0o1000` is the permission digits (no-bitwise forbids `&`).
	if (process.platform !== 'win32') {
		assert.equal(fs.statSync(file).mode % 0o1000, 0o600);
	}
});

test('ensureCredentialStubs is idempotent and never touches existing lines', (t) => {
	const root = makeRoot(t);
	const file = path.join(root, '.env');
	const existing = '# hand-written comment\nKEY_SET=value-123\n# KEY_STUB=\n';
	fs.writeFileSync(file, existing);

	// KEY_SET is set, KEY_STUB is already stubbed — only KEY_NEW is appended.
	const first = ensureCredentialStubs(
		['KEY_SET', 'KEY_STUB', 'KEY_NEW'],
		file,
		{
			heading: 'my-plugin',
		}
	);
	assert.equal(first.created, false);
	assert.deepEqual(first.stubbed, ['KEY_NEW']);
	const body = fs.readFileSync(file, 'utf8');
	assert.ok(body.startsWith(existing));
	assert.ok(body.includes('# --- my-plugin ---\n# KEY_NEW=\n'));

	// Second run adds nothing.
	const second = ensureCredentialStubs(
		['KEY_SET', 'KEY_STUB', 'KEY_NEW'],
		file,
		{ heading: 'my-plugin' }
	);
	assert.deepEqual(second.stubbed, []);
	assert.equal(fs.readFileSync(file, 'utf8'), body);
});

test('ensureCredentialStubs tightens a permissive file even with nothing to append', (t) => {
	if (process.platform === 'win32') {
		return;
	}
	const root = makeRoot(t);
	const file = path.join(root, '.env');
	// The steady state after upgrading: a world-readable file from a version
	// without the chmod, already holding every name.
	const existing = 'KEY_SET=value-123\n# KEY_STUB=\n';
	fs.writeFileSync(file, existing);
	fs.chmodSync(file, 0o644);

	const result = ensureCredentialStubs(['KEY_SET', 'KEY_STUB'], file, {
		heading: 'my-plugin',
	});
	assert.deepEqual(result, { created: false, stubbed: [] });
	assert.equal(fs.readFileSync(file, 'utf8'), existing);
	// `% 0o1000` is the permission digits (no-bitwise forbids `&`).
	assert.equal(fs.statSync(file).mode % 0o1000, 0o600);
});

test('ensureCredentialStubs sanitizes the heading and drops invalid names', (t) => {
	const root = makeRoot(t);
	const file = path.join(root, '.env');
	// A newline in the heading or a non-identifier name would otherwise
	// inject arbitrary lines into the shared central file.
	const result = ensureCredentialStubs(
		['KEY_OK', 'EVIL=x\nINJECTED', 'not a name'],
		file,
		{ heading: 'my-plugin\nEVIL_HEADING=1' }
	);
	assert.deepEqual(result.stubbed, ['KEY_OK']);
	assert.equal(
		fs.readFileSync(file, 'utf8'),
		'# --- my-plugin EVIL_HEADING=1 ---\n# KEY_OK=\n'
	);
});

test('ensureCredentialStubs recognizes export-prefixed values as known', (t) => {
	const root = makeRoot(t);
	const file = path.join(root, '.env');
	fs.writeFileSync(file, 'export KEY_EXPORTED=yes\n');
	const result = ensureCredentialStubs(['KEY_EXPORTED'], file, {});
	assert.deepEqual(result.stubbed, []);
});

test('runCredentials scans the config, reports, and stubs the central file', (t) => {
	const captured = captureStderr(t);
	const root = makeRoot(
		t,
		"import { envSecret } from '@krokedil/wp-playground-tools';\n" +
			'export default {\n' +
			"\tslug: 'my-gateway',\n" +
			'\toptions: {\n' +
			'\t\tall: {\n' +
			"\t\t\tmerchant: envSecret('GATEWAY_TEST_MERCHANT'),\n" +
			"\t\t\tsecret: envSecret('GATEWAY_TEST_SECRET'),\n" +
			'\t\t},\n' +
			'\t},\n' +
			'};\n'
	);
	const globalFile = path.join(root, 'central', '.env');

	const report = runCredentials(root, {
		env: { GATEWAY_TEST_MERCHANT: 'm-123' },
		globalFile,
	});
	assert.deepEqual(report.satisfied, ['GATEWAY_TEST_MERCHANT']);
	assert.deepEqual(report.unset, ['GATEWAY_TEST_SECRET']);
	// Every scanned name gets a commented stub — even a currently-satisfied
	// one, so the central file documents the full set — plus the per-user
	// tooling names.
	assert.deepEqual(report.stubbed, [
		'GATEWAY_TEST_MERCHANT',
		'GATEWAY_TEST_SECRET',
		'NGROK_AUTHTOKEN',
		'KROKEDIL_PG_TUNNEL_PASS',
	]);

	const body = fs.readFileSync(globalFile, 'utf8');
	assert.ok(
		body.includes(
			'# --- my-gateway ---\n# GATEWAY_TEST_MERCHANT=\n# GATEWAY_TEST_SECRET=\n'
		)
	);
	assert.ok(body.includes('# NGROK_AUTHTOKEN=\n'));
	const output = captured();
	assert.match(output, /✓ GATEWAY_TEST_MERCHANT is set/);
	assert.match(output, /✗ GATEWAY_TEST_SECRET is not set/);
	// Values never reach the output.
	assert.ok(!output.includes('m-123'));
});

test('runCredentials ignores a commented-out slug when naming the section', (t) => {
	captureStderr(t);
	// The scaffolded config's commented `pages:` example carries a slug of its
	// own; only the real one may name a section in the shared central file.
	const root = makeRoot(
		t,
		'export default {\n' +
			"\t// pages: { all: [ { title: 'Checkout', slug: 'checkout-test' } ] },\n" +
			"\tslug: 'my-gateway',\n" +
			"\to: envSecret('GATEWAY_TEST_SECRET'),\n" +
			'};\n'
	);
	const globalFile = path.join(root, 'central', '.env');

	runCredentials(root, { env: {}, globalFile });
	const body = fs.readFileSync(globalFile, 'utf8');
	assert.ok(body.includes('# --- my-gateway ---\n# GATEWAY_TEST_SECRET=\n'));
	assert.ok(!body.includes('checkout-test'));
});

test('runCredentials counts satisfied via the .env chain, not just ambient env', (t) => {
	captureStderr(t);
	const root = makeRoot(
		t,
		"export default { slug: 'p', o: envSecret('FROM_CENTRAL_FILE') };\n"
	);
	const globalFile = path.join(root, 'central', '.env');
	fs.mkdirSync(path.dirname(globalFile));
	fs.writeFileSync(globalFile, 'FROM_CENTRAL_FILE=x\n');

	const env = {};
	const report = runCredentials(root, { env, globalFile });
	assert.deepEqual(report.satisfied, ['FROM_CENTRAL_FILE']);
	// The probe never mutates the caller's env.
	assert.deepEqual(env, {});
});

test('runCredentials fails cleanly without a playground.config.mjs', (t) => {
	const captured = captureStderr(t);
	const before = process.exitCode;
	t.after(() => {
		process.exitCode = before;
	});
	const report = runCredentials(makeRoot(t), { env: {}, globalFile: '' });
	assert.equal(report, null);
	assert.equal(process.exitCode, 1);
	assert.match(captured(), /no playground\.config\.mjs here/);
});
