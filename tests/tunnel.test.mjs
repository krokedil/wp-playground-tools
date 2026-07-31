/**
 * Tests for proxy orchestration: ngrok log/API parsing and the proxy-url file
 * lifecycle. No real ngrok/mkcert processes are spawned.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	hintForNgrokError,
	parseNgrokErrorLine,
	parseNgrokLogLine,
	parseTunnelsApi,
} from '../src/proxy/ngrok.mjs';
import {
	clearProxyUrl,
	clearTunnelPassword,
	expandTunnelDomain,
	proxyUrlFile,
	resolveTunnelDomain,
	resolveTunnelPassword,
	startProxy,
	tunnelPasswordFile,
	writeProxyUrl,
	writeTunnelPassword,
} from '../src/proxy/tunnel.mjs';

test('parseNgrokLogLine finds the started-tunnel event', () => {
	const line = JSON.stringify({
		addr: 'http://localhost:8880',
		lvl: 'info',
		msg: 'started tunnel',
		name: 'command_line',
		obj: 'tunnels',
		url: 'https://a1b2c3.ngrok-free.app',
	});
	assert.equal(parseNgrokLogLine(line), 'https://a1b2c3.ngrok-free.app');
});

test('parseNgrokLogLine ignores other events, http URLs and non-JSON noise', () => {
	assert.equal(
		parseNgrokLogLine(
			JSON.stringify({ msg: 'client session established' })
		),
		null
	);
	assert.equal(
		parseNgrokLogLine(
			JSON.stringify({ msg: 'started tunnel', url: 'http://insecure' })
		),
		null
	);
	assert.equal(parseNgrokLogLine('plain text warning'), null);
	assert.equal(parseNgrokLogLine(''), null);
});

test('parseTunnelsApi picks the https tunnel', () => {
	const payload = {
		tunnels: [
			{ public_url: 'http://a1b2c3.ngrok-free.app' },
			{ public_url: 'https://a1b2c3.ngrok-free.app' },
		],
	};
	assert.equal(parseTunnelsApi(payload), 'https://a1b2c3.ngrok-free.app');
	assert.equal(parseTunnelsApi({ tunnels: [] }), null);
	assert.equal(parseTunnelsApi({}), null);
});

test('parseNgrokErrorLine extracts JSON error lines and ERR_NGROK codes', () => {
	const limit = parseNgrokErrorLine(
		JSON.stringify({
			lvl: 'eror',
			msg: 'failed to start tunnel',
			err: 'Your account is limited to 1 simultaneous ngrok agent sessions.\nERR_NGROK_108',
		})
	);
	assert.equal(limit.code, 'ERR_NGROK_108');
	assert.match(limit.text, /failed to start tunnel/);
	assert.match(limit.text, /limited to 1 simultaneous/);

	const noCode = parseNgrokErrorLine(
		JSON.stringify({ lvl: 'eror', msg: 'session closed' })
	);
	assert.deepEqual(noCode, { code: null, text: 'session closed' });

	// An err field alone marks an error line, even without lvl=eror.
	const errOnly = parseNgrokErrorLine(
		JSON.stringify({ lvl: 'info', msg: 'reconnecting', err: 'EOF' })
	);
	assert.deepEqual(errOnly, { code: null, text: 'reconnecting: EOF' });
});

test('parseNgrokErrorLine handles plain-text fatal errors', () => {
	const plain = parseNgrokErrorLine(
		'ERROR:  authentication failed: The authtoken you specified is properly formed, but it is invalid. ERR_NGROK_107'
	);
	assert.equal(plain.code, 'ERR_NGROK_107');
	assert.match(plain.text, /authentication failed/);
});

test('parseNgrokErrorLine ignores info lines, err:"<nil>" and noise', () => {
	assert.equal(
		parseNgrokErrorLine(
			JSON.stringify({ lvl: 'info', msg: 'started tunnel' })
		),
		null
	);
	assert.equal(
		parseNgrokErrorLine(
			JSON.stringify({
				lvl: 'info',
				msg: 'join connections',
				err: '<nil>',
			})
		),
		null
	);
	assert.equal(parseNgrokErrorLine('plain text warning'), null);
	assert.equal(parseNgrokErrorLine(''), null);
});

test('hintForNgrokError maps known codes to actionable hints', () => {
	assert.match(hintForNgrokError('ERR_NGROK_4018'), /authtoken/);
	assert.match(hintForNgrokError('ERR_NGROK_105'), /malformed/);
	assert.match(hintForNgrokError('ERR_NGROK_107'), /rejected/);
	assert.match(hintForNgrokError('ERR_NGROK_108'), /simultaneous/);
	assert.match(hintForNgrokError('ERR_NGROK_313'), /paid plan/);
	assert.match(hintForNgrokError('ERR_NGROK_320'), /not reserved/);
	assert.match(hintForNgrokError('ERR_NGROK_334'), /already online/);
	assert.equal(hintForNgrokError('ERR_NGROK_9999'), null);
	assert.equal(hintForNgrokError(null), null);
});

test('resolveTunnelDomain: override wins, "none" clears the domain', () => {
	const config = { tunnel: { provider: 'ngrok', domain: 'kp.eu.ngrok.io' } };
	assert.equal(resolveTunnelDomain(config), 'kp.eu.ngrok.io');
	assert.equal(
		resolveTunnelDomain(config, 'kp-2.eu.ngrok.io'),
		'kp-2.eu.ngrok.io'
	);
	assert.equal(resolveTunnelDomain(config, 'none'), null);
	assert.equal(resolveTunnelDomain({ tunnel: null }), null);
	assert.equal(
		resolveTunnelDomain({ tunnel: null }, 'x.ngrok.io'),
		'x.ngrok.io'
	);
});

test('expandTunnelDomain: a wildcard becomes one stable host per worktree', () => {
	const opts = { slug: 'qliro-for-woocommerce', cwd: '/repos/qliro' };
	const host = expandTunnelDomain('*.krokedil.ngrok.io', opts);

	assert.match(
		host,
		/^qliro-for-woocommerce-[0-9a-f]{8}\.krokedil\.ngrok\.io$/
	);
	// Same worktree, same URL on every run — callback registrations survive.
	assert.equal(expandTunnelDomain('*.krokedil.ngrok.io', opts), host);
	// A second checkout of the same plugin gets its own host, so both can run.
	assert.notEqual(
		expandTunnelDomain('*.krokedil.ngrok.io', {
			...opts,
			cwd: '/repos/qliro-worktree-2',
		}),
		host
	);
});

test('expandTunnelDomain: passes non-wildcards through, keeps labels legal', () => {
	const opts = { slug: 'my-plugin', cwd: '/repos/x' };
	assert.equal(expandTunnelDomain('kp.eu.ngrok.io', opts), 'kp.eu.ngrok.io');
	assert.equal(expandTunnelDomain(null, opts), null);

	// Only the digest guarantees uniqueness, so an over-long slug is what gives.
	const long = expandTunnelDomain('*.krokedil.ngrok.io', {
		slug: 'a'.repeat(80),
		cwd: '/repos/x',
	});
	const label = long.split('.')[0];
	assert.ok(label.length <= 63, `label too long: ${label.length}`);
	assert.match(label, /^a+-[0-9a-f]{8}$/);

	// Slugs are lowercased and stripped of anything DNS would reject.
	assert.match(
		expandTunnelDomain('*.krokedil.ngrok.io', {
			slug: 'My_Plugin!',
			cwd: '/repos/x',
		}),
		/^my-plugin-[0-9a-f]{8}\.krokedil\.ngrok\.io$/
	);

	// A slug that sanitizes away must not leave a leading hyphen, which would
	// be an illegal label. normalizeConfig rejects such slugs, but this helper
	// is exported and can't lean on that.
	assert.match(
		expandTunnelDomain('*.krokedil.ngrok.io', {
			slug: '!!!',
			cwd: '/repos/x',
		}),
		/^[0-9a-f]{8}\.krokedil\.ngrok\.io$/
	);
});

test('proxy-url file lifecycle: write, read location, clear (idempotent)', (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-proxy-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	writeProxyUrl(root, 'https://a1b2c3.ngrok-free.app');
	const file = proxyUrlFile(root);
	assert.equal(
		file,
		path.join(root, '.playground', 'proxy-url.txt'),
		'the mu-plugin contract: .playground/proxy-url.txt'
	);
	assert.equal(
		fs.readFileSync(file, 'utf8').trim(),
		'https://a1b2c3.ngrok-free.app'
	);

	clearProxyUrl(root);
	assert.equal(fs.existsSync(file), false);
	// Defensive clears (before non-proxied launches) must not throw.
	clearProxyUrl(root);
});

test('resolveTunnelPassword prefers KROKEDIL_PG_TUNNEL_PASS', () => {
	const fromEnv = resolveTunnelPassword({
		env: { KROKEDIL_PG_TUNNEL_PASS: 'team-shared-pass' },
	});
	assert.deepEqual(fromEnv, {
		password: 'team-shared-pass',
		fromEnv: true,
	});
});

test('resolveTunnelPassword generates one when the env value is unset or empty', () => {
	for (const env of [{}, { KROKEDIL_PG_TUNNEL_PASS: '' }]) {
		const generated = resolveTunnelPassword({ env });
		assert.equal(generated.fromEnv, false);
		assert.equal(generated.password.length, 20);
		assert.match(generated.password, /^[A-HJ-NP-Z2-9]+$/);
	}
	// Inherited properties must read as unset, not as a password.
	const inherited = resolveTunnelPassword({
		env: Object.create({ KROKEDIL_PG_TUNNEL_PASS: 'inherited' }),
	});
	assert.equal(inherited.fromEnv, false);
	// Two runs must not share a password.
	assert.notEqual(
		resolveTunnelPassword({ env: {} }).password,
		resolveTunnelPassword({ env: {} }).password
	);
});

test('tunnel password file lifecycle: write, read location, clear (idempotent)', (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-tunnel-pass-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	writeTunnelPassword(root, 'HJKL2345');
	const file = tunnelPasswordFile(root);
	assert.equal(
		file,
		path.join(root, '.playground', 'tunnel-password.txt'),
		'the mu-plugin contract: .playground/tunnel-password.txt'
	);
	assert.equal(fs.readFileSync(file, 'utf8').trim(), 'HJKL2345');

	clearTunnelPassword(root);
	assert.equal(fs.existsSync(file), false);
	// Defensive clears (before every launch) must not throw.
	clearTunnelPassword(root);
});

test('the runtime contract files stay readable under a restrictive umask', (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-umask-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	// An owner-only file reads as unreadable inside the Playground runtime: the
	// guard mu-plugin then finds no password and the default one works on a
	// public URL, and the proxy-url mu-plugin leaves the site on localhost
	// URLs. writeFileSync's mode goes through open(2) and is masked by the
	// umask, so only an explicit chmod survives this.
	const previous = process.umask(0o077);
	try {
		writeTunnelPassword(root, 'HJKL2345');
		writeProxyUrl(root, 'https://a1b2c3.ngrok-free.app');
	} finally {
		process.umask(previous);
	}

	for (const file of [tunnelPasswordFile(root), proxyUrlFile(root)]) {
		// % 0o10 isolates the other-read/write/execute digit (no bitwise ops:
		// the eslint config forbids them).
		assert.notEqual(
			fs.statSync(file).mode % 0o10,
			0,
			`the runtime must be able to read ${path.basename(file)}`
		);
	}
	// A readable file inside an owner-only directory is still out of reach.
	assert.notEqual(
		fs.statSync(path.join(root, '.playground')).mode % 0o10,
		0,
		'the runtime must be able to traverse into .playground'
	);
});

test('startProxy hands the provider the expanded wildcard host', async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-wildcard-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	let served = null;
	const providers = {
		ngrok: async () => ({
			startTunnel: async ({ domain }) => {
				served = domain;
				return { url: `https://${domain}`, stop: async () => {} };
			},
		}),
	};

	const proxy = await startProxy(
		root,
		{ slug: 'my-plugin', tunnel: { domain: '*.krokedil.ngrok.io' } },
		{ port: 9881, kind: 'tunnel', providers }
	);
	t.after(() => proxy.stop());

	// The provider must never see the wildcard itself — ngrok would reject it.
	assert.equal(
		served,
		expandTunnelDomain('*.krokedil.ngrok.io', {
			slug: 'my-plugin',
			cwd: root,
		})
	);
	assert.equal(
		fs.readFileSync(proxyUrlFile(root), 'utf8').trim(),
		`https://${served}`
	);
});

test('startProxy takes the proxy down when publishing its URL fails', async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cleanup-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	let stopped = 0;
	const providers = {
		ngrok: async () => ({
			startTunnel: async () => ({
				url: 'https://a1b2c3.ngrok-free.app',
				stop: async () => {
					stopped += 1;
				},
			}),
		}),
	};

	// proxy-url.txt as a *directory* makes writeProxyUrl throw EISDIR once the
	// tunnel is already up, standing in for any post-start failure (ENOSPC,
	// EACCES, a read-only mount). The password is written before the tunnel
	// starts, so it lands normally and the cleanup has something to remove.
	fs.mkdirSync(path.join(root, '.playground', 'proxy-url.txt'), {
		recursive: true,
	});

	await assert.rejects(() =>
		startProxy(
			root,
			{ tunnel: { provider: 'ngrok', domain: 'kp.eu.ngrok.io' } },
			{ port: 9881, kind: 'tunnel', providers }
		)
	);

	// Otherwise the agent keeps serving the site and holds the reserved domain,
	// so the next run dies with "endpoint already online".
	assert.equal(stopped, 1, 'the tunnel must be stopped');
	assert.equal(
		fs.existsSync(tunnelPasswordFile(root)),
		false,
		'the run password must not outlive the failed run'
	);
});

test('startProxy clears the password when the tunnel itself fails to start', async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-armfail-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	const providers = {
		ngrok: async () => ({
			startTunnel: async () => {
				throw new Error(
					'ngrok exited (code 1) before the tunnel came up.'
				);
			},
		}),
	};

	await assert.rejects(
		() =>
			startProxy(
				root,
				{ tunnel: { provider: 'ngrok' } },
				{ port: 9881, kind: 'tunnel', providers }
			),
		/ngrok exited/
	);
	assert.equal(fs.existsSync(tunnelPasswordFile(root)), false);
});
