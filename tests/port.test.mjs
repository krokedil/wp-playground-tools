/**
 * Tests for the free-port probe and resolution precedence in src/port.mjs.
 *
 * Zero-dependency: uses the built-in node:test runner. Run: node --test tests/
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { findFreePort, isPortFree, resolvePort } from '../src/port.mjs';

/**
 * Hold `port` open for the duration of `fn`, then release it.
 *
 * @param {number}   port The port to occupy.
 * @param {Function} fn   Async callback run while the port is held.
 */
async function withOccupiedPort(port, fn) {
	const server = net.createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, resolve);
	});
	try {
		await fn();
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

test('findFreePort returns the start port when it is free', async () => {
	const free = await findFreePort(8950);
	assert.equal(await isPortFree(free), true);
	assert.equal(await findFreePort(free), free);
});

test('findFreePort skips an occupied port', async () => {
	const start = await findFreePort(8960);
	await withOccupiedPort(start, async () => {
		assert.equal(await isPortFree(start), false);
		const next = await findFreePort(start);
		assert.ok(next > start, `expected a port above ${start}, got ${next}`);
	});
});

test('findFreePort throws when no port in the range is free', async () => {
	const start = await findFreePort(8970);
	await withOccupiedPort(start, async () => {
		// A 1-wide range over the one occupied port: nothing free -> throws.
		await assert.rejects(() => findFreePort(start, 1), /no free port/);
	});
});

test('resolvePort respects an explicit --port in the args', async () => {
	assert.equal(await resolvePort(8880, ['--port=9999'], {}), null);
	assert.equal(await resolvePort(8880, ['--port', '9999'], {}), null);
});

test('resolvePort uses the PORT env verbatim, no probing', async () => {
	const start = await findFreePort(8940);
	await withOccupiedPort(start, async () => {
		// Even though the port is occupied, PORT wins verbatim (preview
		// autoPort already picked it and will navigate exactly there).
		assert.equal(
			await resolvePort(8880, [], { PORT: String(start) }),
			start
		);
	});
});

test('resolvePort rejects a non-numeric PORT env', async () => {
	await assert.rejects(
		() => resolvePort(8880, [], { PORT: 'abc' }),
		/invalid PORT/
	);
});

test('resolvePort probes from the default when nothing pins a port', async () => {
	const free = await findFreePort(8930);
	assert.equal(await resolvePort(free, [], {}), free);
});
