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

	assert.match(
		fs.readFileSync(path.join(root, '.gitignore'), 'utf8'),
		/\.playground\//
	);

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
