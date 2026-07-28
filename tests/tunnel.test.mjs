/**
 * Tests for proxy orchestration: ngrok log/API parsing and the proxy-url file
 * lifecycle. No real ngrok/mkcert processes are spawned.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseNgrokLogLine, parseTunnelsApi } from '../src/proxy/ngrok.mjs';
import {
	clearProxyUrl,
	proxyUrlFile,
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
