/**
 * Blueprint composer tests: structural expectations plus semantic parity
 * against the previously committed returns-and-withdrawals blueprints.
 *
 * "Parity" is semantic, not byte-for-byte: the composer relocates staged
 * assets to .playground/, replaces `wp post create` with idempotent runPHP
 * page creation, and may add options/steps (superset) — but every effective
 * site option, installed plugin/theme, page and wp-cli command from the old
 * blueprints must survive with identical values.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	composeAndStage,
	composeBlueprint,
} from '../src/blueprint/compose.mjs';
import { normalizeConfig } from '../src/config.mjs';
import rwwcRawConfig from './fixtures/rwwc.config.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const rwwcConfig = normalizeConfig(rwwcRawConfig, { hasComposerJson: true });

/**
 * Read a committed reference blueprint fixture.
 *
 * @param {string} mode Blueprint mode.
 * @return {Object} Parsed blueprint.
 */
function referenceBlueprint(mode) {
	return JSON.parse(
		fs.readFileSync(path.join(FIXTURES, `rwwc-${mode}.json`), 'utf8')
	);
}

/**
 * Merge all setSiteOptions steps, in order, into one effective option map.
 *
 * @param {Object} blueprint A blueprint object.
 * @return {Object} option name -> final value.
 */
function effectiveOptions(blueprint) {
	const options = {};
	for (const step of blueprint.steps) {
		if (step.step === 'setSiteOptions') {
			Object.assign(options, step.options);
		}
	}
	return options;
}

/**
 * Collect installed plugin/theme slugs.
 *
 * @param {Object} blueprint A blueprint object.
 * @return {string[]} Sorted slugs.
 */
function installedSlugs(blueprint) {
	return blueprint.steps
		.filter((s) => s.step === 'installPlugin' || s.step === 'installTheme')
		.map((s) => (s.pluginData ?? s.themeData).slug)
		.sort();
}

/**
 * Collect wp-cli commands.
 *
 * @param {Object} blueprint A blueprint object.
 * @return {string[]} Commands.
 */
function wpCliCommands(blueprint) {
	return blueprint.steps
		.filter((s) => s.step === 'wp-cli')
		.map((s) => s.command);
}

/**
 * Collect page slugs created by either `wp post create --post_name=…` or the
 * composer's guarded runPHP insert.
 *
 * @param {Object} blueprint A blueprint object.
 * @return {string[]} Page slugs.
 */
function createdPageSlugs(blueprint) {
	const slugs = [];
	for (const step of blueprint.steps) {
		if (step.step === 'wp-cli') {
			const m = step.command.match(/wp post create .*--post_name=(\S+)/);
			if (m) {
				slugs.push(m[1]);
			}
		}
		if (step.step === 'runPHP') {
			const m = step.code.match(
				/get_page_by_path\( '([^']+)' \) \) \{ wp_insert_post/
			);
			if (m) {
				slugs.push(m[1]);
			}
		}
	}
	return slugs;
}

for (const mode of ['development', 'demo', 'e2e']) {
	test(`parity (${mode}): every legacy site option survives with the same value`, () => {
		const composed = effectiveOptions(composeBlueprint(rwwcConfig, mode));
		const reference = effectiveOptions(referenceBlueprint(mode));
		for (const [key, value] of Object.entries(reference)) {
			assert.deepEqual(
				composed[key],
				value,
				`option ${key} diverged in ${mode}`
			);
		}
	});

	test(`parity (${mode}): installed plugins/themes are identical`, () => {
		assert.deepEqual(
			installedSlugs(composeBlueprint(rwwcConfig, mode)),
			installedSlugs(referenceBlueprint(mode))
		);
	});

	test(`parity (${mode}): legacy wp-cli commands survive (pages moved to runPHP)`, () => {
		const composed = wpCliCommands(composeBlueprint(rwwcConfig, mode));
		const reference = wpCliCommands(referenceBlueprint(mode)).filter(
			(cmd) => !cmd.startsWith('wp post create')
		);
		for (const cmd of reference) {
			assert.ok(
				composed.includes(cmd),
				`missing wp-cli command in ${mode}: ${cmd}`
			);
		}
	});

	test(`parity (${mode}): all legacy pages are created`, () => {
		const composed = createdPageSlugs(composeBlueprint(rwwcConfig, mode));
		for (const slug of createdPageSlugs(referenceBlueprint(mode))) {
			assert.ok(
				composed.includes(slug),
				`missing page in ${mode}: ${slug}`
			);
		}
	});

	test(`parity (${mode}): versions, landing page and login match`, () => {
		const composed = composeBlueprint(rwwcConfig, mode);
		const reference = referenceBlueprint(mode);
		assert.deepEqual(
			composed.preferredVersions,
			reference.preferredVersions
		);
		assert.equal(composed.landingPage, reference.landingPage);
		// Deliberate divergence in development: the CLI's auto-login is
		// per-client (cookie-less clients redirect-loop, each pass writing a
		// session), so the composer turns it off there —
		// playground-dev-login.php owns local login instead.
		assert.equal(
			composed.login,
			mode === 'development' ? false : reference.login
		);
	});
}

test('development blueprint stages seeder + dev-helper + proxy + login mu-plugins and seeds', () => {
	const blueprint = composeBlueprint(rwwcConfig, 'development');
	const code = JSON.stringify(blueprint.steps);
	for (const name of [
		'playground-proxy-url.php',
		'playground-dev-login.php',
		'playground-seeder.php',
		'rwwc-dev-helper.php',
	]) {
		assert.ok(code.includes(name), `missing mu-plugin link: ${name}`);
	}
	assert.match(code, /playground_seed_products/);
	assert.match(
		code,
		/plugins\/returns-and-withdrawals\/\.playground\/seed-data\.json/
	);
});

test('demo/e2e blueprints use the built-in fixture, not the seeder', () => {
	for (const mode of ['demo', 'e2e']) {
		const code = JSON.stringify(composeBlueprint(rwwcConfig, mode).steps);
		assert.ok(!code.includes('playground_seed_products'));
		assert.match(code, /simple-product/);
	}
});

test('the auto-login mu-plugin stays out of demo/e2e blueprints', () => {
	for (const mode of ['demo', 'e2e']) {
		const code = JSON.stringify(composeBlueprint(rwwcConfig, mode).steps);
		assert.ok(!code.includes('playground-dev-login.php'));
	}
});

test('every mode disables the background auto-updater, persisted in wp-config', () => {
	for (const mode of ['development', 'demo', 'e2e']) {
		const step = composeBlueprint(rwwcConfig, mode).steps.find(
			(s) =>
				s.step === 'defineWpConfigConsts' &&
				s.consts.AUTOMATIC_UPDATER_DISABLED
		);
		assert.ok(step, `AUTOMATIC_UPDATER_DISABLED missing in ${mode}`);
		// rewrite-wp-config: the define must survive warm boots, which skip
		// the blueprint (define-before-run is per-boot only).
		assert.equal(step.method, 'rewrite-wp-config');
	}
});

test('every mode links the tunnel guard (--tunnel is a per-run flag)', () => {
	for (const mode of ['development', 'demo', 'e2e']) {
		const code = JSON.stringify(composeBlueprint(rwwcConfig, mode).steps);
		assert.ok(
			code.includes('playground-tunnel-guard.php'),
			`missing tunnel guard link in ${mode}`
		);
	}
});

test('extraSteps are appended verbatim at the end', () => {
	const config = normalizeConfig({
		slug: 'a-plugin',
		extraSteps: {
			demo: [{ step: 'wp-cli', command: 'wp option get blogname' }],
		},
	});
	const blueprint = composeBlueprint(config, 'demo');
	assert.deepEqual(blueprint.steps.at(-1), {
		step: 'wp-cli',
		command: 'wp option get blogname',
	});
});

test('a woocommerce:false plugin gets no WC steps', () => {
	const config = normalizeConfig({ slug: 'a-plugin', woocommerce: false });
	const code = JSON.stringify(composeBlueprint(config, 'development').steps);
	assert.ok(!code.includes('woocommerce'));
	assert.ok(!code.includes('playground_seed_products'));
});

test('composeAndStage writes the blueprint and stages assets', async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-compose-'));
	// Pre-seed the zip cache so staging never touches the network: fake zips
	// (>1000 bytes so the size sanity check would pass had they been fetched).
	const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cache-'));
	process.env.KROKEDIL_PG_CACHE_DIR = cache;
	t.after(() => {
		delete process.env.KROKEDIL_PG_CACHE_DIR;
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(cache, { recursive: true, force: true });
	});
	// Stage everything under an owner-only umask: that is the shell the
	// runtime-readability bug hides in — sources are created 0600, and both
	// copyFileSync's mode inheritance and writeFileSync's `mode` option go
	// through open(2), so only an explicit chmod survives it.
	const previousUmask = process.umask(0o077);
	let blueprintPath;
	try {
		for (const slug of [
			'woocommerce',
			'query-monitor',
			'show-hidden-post-meta',
			'transients-manager',
			'wp-mail-logging',
		]) {
			fs.writeFileSync(path.join(cache, `${slug}.zip`), 'x'.repeat(2000));
		}

		// A plugin-local mu-plugin + seed data to stage.
		fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
		fs.writeFileSync(
			path.join(root, 'tools', 'my-helper.php'),
			'<?php // helper'
		);
		fs.writeFileSync(
			path.join(root, 'tools', 'seed.json'),
			JSON.stringify({ products: [] })
		);

		const config = normalizeConfig({
			slug: 'a-plugin',
			muPlugins: { development: ['tools/my-helper.php'] },
			seedData: 'tools/seed.json',
		});
		({ blueprintPath } = await composeAndStage(
			root,
			config,
			'development'
		));
	} finally {
		process.umask(previousUmask);
	}

	assert.equal(
		blueprintPath,
		path.join(root, '.playground', 'blueprint.development.json')
	);
	assert.ok(fs.existsSync(blueprintPath));
	for (const staged of [
		'mu-plugins/playground-proxy-url.php',
		'mu-plugins/playground-tunnel-guard.php',
		'mu-plugins/playground-dev-login.php',
		'mu-plugins/playground-seeder.php',
		'mu-plugins/my-helper.php',
		'seed-data.json',
		'plugins/woocommerce.zip',
		'plugins/wp-mail-logging.zip',
	]) {
		const file = path.join(root, '.playground', staged);
		assert.ok(fs.existsSync(file), `not staged: ${staged}`);
		// Staged modes must not depend on the developer's umask: where the
		// runtime reaches the mount as another uid, an owner-only file is
		// unreadable there and its mu-plugin or step fails silently.
		// `% 0o10` is the "other" permission digit (no-bitwise forbids `&`).
		assert.equal(
			fs.statSync(file).mode % 0o10,
			0o4,
			`not runtime-readable: ${staged}`
		);
	}
	// And the directories holding them: a readable file inside an owner-only
	// directory is still unreachable, since reading it means traversing in.
	for (const dir of ['', 'mu-plugins', 'plugins']) {
		const staged = path.join(root, '.playground', dir);
		assert.equal(
			fs.statSync(staged).mode % 0o10,
			0o5,
			`not runtime-traversable: .playground/${dir}`
		);
	}
	// Every wordpress.org installPlugin step was rewritten to the staged zip.
	const parsed = JSON.parse(fs.readFileSync(blueprintPath, 'utf8'));
	const installs = parsed.steps.filter((s) => s.step === 'installPlugin');
	assert.ok(installs.length >= 5);
	for (const step of installs) {
		assert.equal(step.pluginData.resource, 'vfs');
		assert.match(
			step.pluginData.path,
			/^\/wordpress\/wp-content\/plugins\/a-plugin\/\.playground\/plugins\/[a-z-]+\.zip$/
		);
	}
});

test('composeAndStage fails actionably on a missing mu-plugin', async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-compose-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const config = normalizeConfig({
		slug: 'a-plugin',
		muPlugins: { development: ['tools/nope.php'] },
	});
	await assert.rejects(
		() => composeAndStage(root, config, 'development'),
		/mu-plugin not found.*config\.muPlugins/s
	);
});

test('undefined option values (missing secrets) drop out of the staged blueprint', async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-compose-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const config = normalizeConfig({
		slug: 'a-plugin',
		options: {
			all: {
				my_gateway_settings: {
					enabled: 'yes',
					// What envSecret() returns for an unset variable.
					test_secret: undefined,
				},
			},
		},
	});
	await composeAndStage(root, config, 'development');
	const staged = JSON.parse(
		fs.readFileSync(
			path.join(root, '.playground', 'blueprint.development.json'),
			'utf8'
		)
	);
	const options = effectiveOptions(staged);
	assert.deepEqual(options.my_gateway_settings, { enabled: 'yes' });
	assert.ok(!JSON.stringify(staged).includes('test_secret'));
});
