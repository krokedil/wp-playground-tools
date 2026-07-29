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
	proxyUrlFile,
	resolveTunnelDomain,
	writeProxyUrl,
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

test('resolveTunnelDomain: override wins, "none" forces ephemeral', () => {
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
