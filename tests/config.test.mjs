/**
 * Tests for config normalization and validation in src/config.mjs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConfig, validateTunnelDomain } from '../src/config.mjs';

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

test('store overrides merge over org defaults', () => {
	const config = normalizeConfig({
		slug: 'a-plugin',
		store: { currency: 'NOK' },
	});
	assert.equal(config.store.currency, 'NOK');
	assert.equal(config.store.country, 'SE');
});
