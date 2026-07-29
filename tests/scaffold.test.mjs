/**
 * Tests for the init scaffolder.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	CLAUDE_MD_BEGIN,
	CLAUDE_MD_END,
	inferSlug,
	PACKAGE_SPEC,
	scaffold,
} from '../src/init/scaffold.mjs';

/**
 * Create a bare fake plugin checkout.
 *
 * @param {Object} t node:test context for cleanup.
 * @return {string} The temp root.
 */
function makePluginRoot(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-init-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.writeFileSync(
		path.join(root, 'my-payment-gateway.php'),
		'<?php\n/**\n * Plugin Name: My Payment Gateway\n */\n'
	);
	return root;
}

test('inferSlug prefers the main plugin file over the directory name', (t) => {
	const root = makePluginRoot(t);
	assert.equal(inferSlug(root), 'my-payment-gateway');

	const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-bare-'));
	t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
	assert.equal(inferSlug(bare), path.basename(bare));
});

test('scaffold writes shim, config, pins, scripts, launch entries and ignores', async (t) => {
	const root = makePluginRoot(t);
	fs.writeFileSync(path.join(root, '.kernlignore'), 'node_modules\n');
	await scaffold(root, []);

	assert.ok(fs.existsSync(path.join(root, 'tools', 'playground.mjs')));
	assert.match(
		fs.readFileSync(path.join(root, 'tools', 'playground.mjs'), 'utf8'),
		/^\/\/ shim-version: \d+/
	);

	const config = fs.readFileSync(
		path.join(root, 'playground.config.mjs'),
		'utf8'
	);
	assert.match(config, /slug: 'my-payment-gateway'/);

	assert.equal(
		fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim(),
		'20.19.0'
	);
	assert.match(
		fs.readFileSync(path.join(root, '.npmrc'), 'utf8'),
		/use-node-version=20\.19\.0/
	);

	const pkg = JSON.parse(
		fs.readFileSync(path.join(root, 'package.json'), 'utf8')
	);
	assert.equal(
		pkg.scripts['playground:start'],
		'node tools/playground.mjs start'
	);
	assert.match(
		pkg.devDependencies['@krokedil/wp-playground-tools'],
		/^github:/
	);
	assert.match(pkg.engines.node, /^>=20\.19/);

	const launch = JSON.parse(
		fs.readFileSync(path.join(root, '.claude', 'launch.json'), 'utf8')
	);
	const names = launch.configurations.map((c) => c.name);
	assert.ok(names.includes('playground-my-payment-gateway-start'));
	assert.ok(launch.configurations.every((c) => c.autoPort === true));

	const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
	assert.match(gitignore, /\.playground\//);
	assert.match(gitignore, /^\.env$/m);
	const kernlignore = fs.readFileSync(
		path.join(root, '.kernlignore'),
		'utf8'
	);
	assert.match(kernlignore, /^playground\.config\.mjs$/m);
	assert.match(kernlignore, /^\.env$/m);

	const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
	assert.ok(
		claude.includes(CLAUDE_MD_BEGIN) && claude.includes(CLAUDE_MD_END)
	);
	assert.match(claude, /\.playground\/proxy-url\.txt/);
	assert.match(claude, /playground:start.*:8880/);
});

test('scaffold upserts the CLAUDE.md section without touching the rest', async (t) => {
	const root = makePluginRoot(t);
	fs.writeFileSync(
		path.join(root, 'CLAUDE.md'),
		'# My Plugin\n\nHand-written notes.\n'
	);
	await scaffold(root, []);

	let claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
	assert.match(claude, /^# My Plugin\n\nHand-written notes\./);
	assert.ok(claude.includes(CLAUDE_MD_BEGIN));

	// A refresh replaces the section in place — no duplicates, notes intact.
	fs.appendFileSync(path.join(root, 'CLAUDE.md'), '\nTrailing notes.\n');
	await scaffold(root, ['--update']);
	claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
	assert.equal(claude.split(CLAUDE_MD_BEGIN).length, 2);
	assert.match(claude, /Hand-written notes\./);
	assert.match(claude, /Trailing notes\./);
});

test('scaffold is idempotent and never overwrites the config', async (t) => {
	const root = makePluginRoot(t);
	await scaffold(root, []);

	// The dev fills in their config…
	const configPath = path.join(root, 'playground.config.mjs');
	fs.writeFileSync(configPath, "export default { slug: 'edited' };\n");
	// …and adds a custom launch entry + script that must survive.
	const launchPath = path.join(root, '.claude', 'launch.json');
	const launch = JSON.parse(fs.readFileSync(launchPath, 'utf8'));
	launch.configurations.push({ name: 'storybook', port: 6006 });
	fs.writeFileSync(launchPath, JSON.stringify(launch));

	await scaffold(root, ['--update']);

	assert.match(fs.readFileSync(configPath, 'utf8'), /slug: 'edited'/);
	const after = JSON.parse(fs.readFileSync(launchPath, 'utf8'));
	assert.ok(after.configurations.some((c) => c.name === 'storybook'));
	// Playground entries are regenerated, not duplicated.
	assert.equal(
		after.configurations.filter((c) => /^playground-/.test(c.name)).length,
		3
	);
});

test('scaffold --update derives scripts and launch entries from config.modes', async (t) => {
	const root = makePluginRoot(t);
	await scaffold(root, []);

	const pkgPath = path.join(root, 'package.json');
	assert.equal(
		JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts[
			'playground:server-e2e'
		],
		undefined
	);

	fs.writeFileSync(
		path.join(root, 'playground.config.mjs'),
		"export default { slug: 'my-payment-gateway', basePort: 8890, modes: ['start', 'development', 'demo', 'e2e'] };\n"
	);
	await scaffold(root, ['--update']);

	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	assert.equal(
		pkg.scripts['playground:server-e2e'],
		'node tools/playground.mjs server e2e'
	);

	const launch = JSON.parse(
		fs.readFileSync(path.join(root, '.claude', 'launch.json'), 'utf8')
	);
	const entries = launch.configurations.filter((c) =>
		/^playground-/.test(c.name)
	);
	assert.equal(entries.length, 4);
	const e2e = entries.find((c) => /-e2e$/.test(c.name));
	assert.equal(e2e.port, 8893);
	assert.deepEqual(e2e.runtimeArgs, ['run', 'playground:server-e2e']);
});

test('scaffold --update prunes dropped-mode scripts but keeps customized ones', async (t) => {
	const root = makePluginRoot(t);
	const pkgPath = path.join(root, 'package.json');
	await scaffold(root, []);

	fs.writeFileSync(
		path.join(root, 'playground.config.mjs'),
		"export default { slug: 'my-payment-gateway', basePort: 8890, modes: ['start', 'development', 'demo', 'e2e'] };\n"
	);
	await scaffold(root, ['--update']);

	// The dev drops e2e again but has customized its script — it must survive.
	fs.writeFileSync(
		path.join(root, 'playground.config.mjs'),
		"export default { slug: 'my-payment-gateway', basePort: 8890, modes: ['start', 'development', 'demo'] };\n"
	);
	let pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	pkg.scripts['playground:server-e2e'] = 'echo customized';
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');

	await scaffold(root, ['--update']);
	pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	assert.equal(pkg.scripts['playground:server-e2e'], 'echo customized');

	// An untouched generated script for a dropped mode is pruned.
	pkg.scripts['playground:server-e2e'] =
		'node tools/playground.mjs server e2e';
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');

	await scaffold(root, ['--update']);
	pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	assert.equal(pkg.scripts['playground:server-e2e'], undefined);
	const launch = JSON.parse(
		fs.readFileSync(path.join(root, '.claude', 'launch.json'), 'utf8')
	);
	assert.equal(
		launch.configurations.filter((c) => /^playground-/.test(c.name)).length,
		3
	);
});

test('scaffold preserves existing JSON indentation, defaults to tabs', async (t) => {
	const root = makePluginRoot(t);
	fs.writeFileSync(
		path.join(root, 'package.json'),
		JSON.stringify({ name: 'my-payment-gateway', private: true }, null, 2) +
			'\n'
	);
	fs.mkdirSync(path.join(root, '.claude'));
	fs.writeFileSync(
		path.join(root, '.claude', 'launch.json'),
		JSON.stringify(
			{
				version: '0.0.1',
				configurations: [{ name: 'storybook', port: 6006 }],
			},
			null,
			2
		) + '\n'
	);

	await scaffold(root, []);

	const pkgBody = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
	assert.match(pkgBody, /^ {2}"name"/m);
	assert.ok(!pkgBody.includes('\t'));
	assert.equal(
		JSON.parse(pkgBody).scripts['playground:start'],
		'node tools/playground.mjs start'
	);

	const launchBody = fs.readFileSync(
		path.join(root, '.claude', 'launch.json'),
		'utf8'
	);
	assert.match(launchBody, /^ {2}"version"/m);
	assert.ok(!launchBody.includes('\t'));

	// Without a pre-existing package.json the tab default applies.
	const bare = makePluginRoot(t);
	await scaffold(bare, []);
	assert.match(
		fs.readFileSync(path.join(bare, 'package.json'), 'utf8'),
		/^\t"name"/m
	);
});

test('scaffold restores the #semver range pnpm add drops, keeps deliberate pins', async (t) => {
	// `pnpm add …#semver:^1` resolves the range but saves the normalized
	// branch-tracking spec — init must correct it back to PACKAGE_SPEC.
	const root = makePluginRoot(t);
	const pkgPath = path.join(root, 'package.json');
	fs.writeFileSync(
		pkgPath,
		JSON.stringify({
			name: 'my-payment-gateway-dev',
			private: true,
			version: '0.0.0',
			devDependencies: {
				'@krokedil/wp-playground-tools':
					'git+https://github.com/krokedil/wp-playground-tools.git',
			},
		}) + '\n'
	);
	await scaffold(root, []);
	let pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	assert.equal(
		pkg.devDependencies['@krokedil/wp-playground-tools'],
		PACKAGE_SPEC
	);

	// A spec with an explicit #committish is a deliberate pin — untouched,
	// including on --update.
	const pinned = 'github:krokedil/wp-playground-tools#main';
	pkg.devDependencies['@krokedil/wp-playground-tools'] = pinned;
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
	await scaffold(root, ['--update']);
	pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	assert.equal(pkg.devDependencies['@krokedil/wp-playground-tools'], pinned);
});

test('scaffold --update respects a custom basePort from the config', async (t) => {
	const root = makePluginRoot(t);
	await scaffold(root, []);
	fs.writeFileSync(
		path.join(root, 'playground.config.mjs'),
		"export default { slug: 'my-payment-gateway', basePort: 8890 };\n"
	);
	await scaffold(root, ['--update']);
	const launch = JSON.parse(
		fs.readFileSync(path.join(root, '.claude', 'launch.json'), 'utf8')
	);
	const start = launch.configurations.find((c) => /-start$/.test(c.name));
	assert.equal(start.port, 8890);
});
