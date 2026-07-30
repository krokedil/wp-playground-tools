/**
 * Tests for config normalization and validation in src/config.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
	loadConfig,
	normalizeConfig,
	validateTunnelDomain,
} from '../src/config.mjs';

test('slug is required and validated', () => {
	assert.throws(() => normalizeConfig({}), /"slug" is required/);
	assert.throws(() => normalizeConfig({ slug: 'Bad Slug' }), /kebab-case/);
});

test('defaults are applied from the slug', () => {
	const config = normalizeConfig({ slug: 'my-payment-gateway' });
	assert.equal(config.siteName, 'My Payment Gateway');
	assert.equal(config.basePort, 8880);
	assert.equal(config.landingPage, '/wp-admin/');
	assert.deepEqual(config.activate, ['my-payment-gateway']);
	assert.deepEqual(config.modes, ['start', 'development', 'demo']);
	assert.equal(config.woocommerce, true);
	assert.equal(config.php, '8.3');
	assert.deepEqual(config.store, {
		country: 'SE',
		currency: 'SEK',
		timezone: 'Europe/Stockholm',
	});
});

test('composer marker defaults to vendor/autoload.php only when composer.json exists', () => {
	const withComposer = normalizeConfig(
		{ slug: 'a-plugin' },
		{ hasComposerJson: true }
	);
	assert.deepEqual(withComposer.composer, {
		markers: ['vendor/autoload.php'],
	});

	const without = normalizeConfig({ slug: 'a-plugin' });
	assert.equal(without.composer, null);
});

test('explicit composer markers pass through (wpify-scoper plugins)', () => {
	const config = normalizeConfig({
		slug: 'a-plugin',
		composer: {
			markers: ['vendor/autoload.php', 'dependencies/autoload.php'],
		},
	});
	assert.deepEqual(config.composer.markers, [
		'vendor/autoload.php',
		'dependencies/autoload.php',
	]);
});

test('unknown modes are rejected with the known list', () => {
	assert.throws(
		() => normalizeConfig({ slug: 'a-plugin', modes: ['staging'] }),
		/unknown mode\(s\) staging/
	);
});

test('build requires markers', () => {
	assert.throws(
		() => normalizeConfig({ slug: 'a-plugin', build: {} }),
		/build\.markers/
	);
	const config = normalizeConfig({
		slug: 'a-plugin',
		build: { markers: ['blocks/build/x.asset.php'], command: 'build' },
	});
	assert.equal(config.build.command, 'build');
});

test('unsupported tunnel provider is rejected', () => {
	assert.throws(
		() =>
			normalizeConfig({
				slug: 'a-plugin',
				tunnel: { provider: 'localtunnel' },
			}),
		/only "ngrok"/
	);
	const config = normalizeConfig({
		slug: 'a-plugin',
		tunnel: { provider: 'ngrok', domain: 'x.eu.ngrok.io' },
	});
	assert.equal(config.tunnel.domain, 'x.eu.ngrok.io');
});

test('tunnel.domain must be a bare hostname', () => {
	for (const bad of [
		'https://x.eu.ngrok.io',
		'x.eu.ngrok.io/path',
		'x.eu.ngrok.io:443',
		'not a host',
		123,
		'',
	]) {
		assert.throws(
			() =>
				normalizeConfig({
					slug: 'a-plugin',
					tunnel: { provider: 'ngrok', domain: bad },
				}),
			/bare hostname/,
			`expected rejection for ${JSON.stringify(bad)}`
		);
	}

	// No domain at all stays valid (ephemeral URLs).
	const config = normalizeConfig({
		slug: 'a-plugin',
		tunnel: { provider: 'ngrok' },
	});
	assert.equal(config.tunnel.domain, undefined);
});

test('validateTunnelDomain accepts hostnames and names the failing setting', () => {
	assert.equal(
		validateTunnelDomain('my-plugin.eu.ngrok.io'),
		'my-plugin.eu.ngrok.io'
	);
	assert.equal(validateTunnelDomain('a-b.ngrok.app'), 'a-b.ngrok.app');
	assert.throws(
		() => validateTunnelDomain('nodots', '--tunnel-domain'),
		/"--tunnel-domain" must be a bare hostname/
	);
});

test('loadConfig merges .env before evaluating the config, ambient env wins', async (t) => {
	t.mock.method(process.stderr, 'write', () => true);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cfg-env-'));
	t.after(() => {
		fs.rmSync(root, { recursive: true, force: true });
		delete process.env.PG_TEST_FROM_FILE;
		delete process.env.PG_TEST_AMBIENT;
	});

	process.env.PG_TEST_AMBIENT = 'from-shell';
	fs.writeFileSync(
		path.join(root, '.env'),
		'PG_TEST_FROM_FILE=file-secret\nPG_TEST_AMBIENT=file-loses\n'
	);
	fs.writeFileSync(
		path.join(root, 'playground.config.mjs'),
		"export default {\n\tslug: 'env-plugin',\n" +
			'\toptions: { all: {\n' +
			'\t\tfrom_file: process.env.PG_TEST_FROM_FILE,\n' +
			'\t\tambient: process.env.PG_TEST_AMBIENT,\n' +
			'\t} },\n};\n'
	);

	const config = await loadConfig(root);
	assert.equal(config.options.development.from_file, 'file-secret');
	assert.equal(config.options.development.ambient, 'from-shell');
});

test('loadConfig warns on a defaulted basePort, silent when set', async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-config-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const file = path.join(root, 'playground.config.mjs');
	const write = t.mock.method(process.stderr, 'write', () => true);

	fs.writeFileSync(file, "export default { slug: 'a-plugin' };\n");
	await loadConfig(root);
	assert.ok(write.mock.calls.some((c) => /basePort/.test(c.arguments[0])));

	write.mock.resetCalls();
	fs.writeFileSync(
		file,
		"export default { slug: 'a-plugin', basePort: 8890 };\n"
	);
	// Force a distinct mtime — loadConfig's ESM cache-bust keys on it, and
	// back-to-back writes can land in the same timestamp.
	fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
	await loadConfig(root);
	assert.ok(!write.mock.calls.some((c) => /basePort/.test(c.arguments[0])));
});

test('composer requires markers when set (null disables it)', () => {
	assert.throws(
		() => normalizeConfig({ slug: 'a-plugin', composer: {} }),
		/composer\.markers/
	);
	const config = normalizeConfig(
		{ slug: 'a-plugin', composer: null },
		{ hasComposerJson: true }
	);
	assert.equal(config.composer, null);
});

test('modes must be a non-empty array of strings', () => {
	for (const bad of ['start', [], [42], {}]) {
		assert.throws(
			() => normalizeConfig({ slug: 'a-plugin', modes: bad }),
			/"modes" must be a non-empty array/,
			`expected rejection for ${JSON.stringify(bad)}`
		);
	}
});

test('activate must be an array of strings', () => {
	for (const bad of ['my-plugin', [42], { all: [] }]) {
		assert.throws(
			() => normalizeConfig({ slug: 'a-plugin', activate: bad }),
			/"activate" must be an array/,
			`expected rejection for ${JSON.stringify(bad)}`
		);
	}
});

test('php and wp must be version strings', () => {
	assert.throws(
		() => normalizeConfig({ slug: 'a-plugin', php: 8.3 }),
		/"php" must be a version string/
	);
	assert.throws(
		() => normalizeConfig({ slug: 'a-plugin', wp: 6.7 }),
		/"wp" must be a version string/
	);
	assert.throws(
		() => normalizeConfig({ slug: 'a-plugin', wp: { development: 6.7 } }),
		/"wp" must be a version string/
	);
	const config = normalizeConfig({
		slug: 'a-plugin',
		php: '8.2',
		wp: { development: 'beta' },
	});
	assert.equal(config.php, '8.2');
	assert.equal(config.wp.development, 'beta');
});

test('screenshots must be a path string', () => {
	assert.throws(
		() => normalizeConfig({ slug: 'a-plugin', screenshots: 42 }),
		/"screenshots" must be a path string/
	);
});

test('https.hosts must be a non-empty string array', () => {
	for (const bad of ['localhost', [], [42]]) {
		assert.throws(
			() => normalizeConfig({ slug: 'a-plugin', https: { hosts: bad } }),
			/"https\.hosts" must be a non-empty array/,
			`expected rejection for ${JSON.stringify(bad)}`
		);
	}
	const config = normalizeConfig({
		slug: 'a-plugin',
		https: { hosts: ['app.localhost'] },
	});
	assert.deepEqual(config.https.hosts, ['app.localhost']);
});

test('per-mode keys reject primitives instead of normalizing to empty', () => {
	assert.throws(
		() => normalizeConfig({ slug: 'a-plugin', pages: 42 }),
		/"pages" must be an array or a per-mode object/
	);
	assert.throws(
		() => normalizeConfig({ slug: 'a-plugin', options: 'x' }),
		/"options" must be an object/
	);
});

test('pages entries need string title, slug and content', () => {
	assert.throws(
		() =>
			normalizeConfig({
				slug: 'a-plugin',
				pages: [{ title: 'Checkout Test', slug: 'checkout-test' }],
			}),
		/"pages" entries need string/
	);
	const config = normalizeConfig({
		slug: 'a-plugin',
		pages: [{ title: 'T', slug: 't', content: '<!-- wp:paragraph -->' }],
	});
	assert.equal(config.pages.development.length, 1);
});

test('store overrides merge over org defaults', () => {
	const config = normalizeConfig({
		slug: 'a-plugin',
		store: { currency: 'NOK' },
	});
	assert.equal(config.store.currency, 'NOK');
	assert.equal(config.store.country, 'SE');
});
