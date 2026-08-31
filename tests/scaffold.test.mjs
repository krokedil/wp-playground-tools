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

/**
 * scaffold() with the central credentials file redirected into the temp root,
 * so tests never read or write the real ~/.config/krokedil-playground/.env.
 *
 * @param {string}   root Temp plugin root.
 * @param {string[]} args CLI args after "init".
 * @return {Promise<void>} Resolves when done.
 */
function runScaffold(root, args = []) {
	return scaffold(root, args, {
		credentials: { env: {}, globalFile: path.join(root, 'central.env') },
	});
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
	await runScaffold(root, []);

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
		'22.23.2'
	);
	assert.match(
		fs.readFileSync(path.join(root, '.npmrc'), 'utf8'),
		/use-node-version=22\.23\.2/
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
	assert.match(kernlignore, /^tools\/playground\.mjs$/m);
	assert.match(kernlignore, /^CLAUDE\.md$/m);
	assert.match(kernlignore, /^\.nvmrc$/m);
	assert.match(kernlignore, /^\.claude$/m);
	assert.match(kernlignore, /^\.claude\/\*\*\/\*$/m);

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
	await runScaffold(root, []);

	let claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
	assert.match(claude, /^# My Plugin\n\nHand-written notes\./);
	assert.ok(claude.includes(CLAUDE_MD_BEGIN));

	// A refresh replaces the section in place — no duplicates, notes intact.
	fs.appendFileSync(path.join(root, 'CLAUDE.md'), '\nTrailing notes.\n');
	await runScaffold(root, ['--update']);
	claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
	assert.equal(claude.split(CLAUDE_MD_BEGIN).length, 2);
	assert.match(claude, /Hand-written notes\./);
	assert.match(claude, /Trailing notes\./);
});

test('scaffold is idempotent and never overwrites the config', async (t) => {
	const root = makePluginRoot(t);
	await runScaffold(root, []);

	// The dev fills in their config…
	const configPath = path.join(root, 'playground.config.mjs');
	fs.writeFileSync(configPath, "export default { slug: 'edited' };\n");
	// …and adds a custom launch entry + script that must survive.
	const launchPath = path.join(root, '.claude', 'launch.json');
	const launch = JSON.parse(fs.readFileSync(launchPath, 'utf8'));
	launch.configurations.push({ name: 'storybook', port: 6006 });
	fs.writeFileSync(launchPath, JSON.stringify(launch));

	await runScaffold(root, ['--update']);

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
	await runScaffold(root, []);

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
	await runScaffold(root, ['--update']);

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
	await runScaffold(root, []);

	fs.writeFileSync(
		path.join(root, 'playground.config.mjs'),
		"export default { slug: 'my-payment-gateway', basePort: 8890, modes: ['start', 'development', 'demo', 'e2e'] };\n"
	);
	await runScaffold(root, ['--update']);

	// The dev drops e2e again but has customized its script — it must survive.
	fs.writeFileSync(
		path.join(root, 'playground.config.mjs'),
		"export default { slug: 'my-payment-gateway', basePort: 8890, modes: ['start', 'development', 'demo'] };\n"
	);
	let pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	pkg.scripts['playground:server-e2e'] = 'echo customized';
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');

	await runScaffold(root, ['--update']);
	pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	assert.equal(pkg.scripts['playground:server-e2e'], 'echo customized');

	// An untouched generated script for a dropped mode is pruned.
	pkg.scripts['playground:server-e2e'] =
		'node tools/playground.mjs server e2e';
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');

	await runScaffold(root, ['--update']);
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

test('fresh scaffold (no package.json) defaults to pnpm and declares it', async (t) => {
	const root = makePluginRoot(t);
	await runScaffold(root, []);

	const pkg = JSON.parse(
		fs.readFileSync(path.join(root, 'package.json'), 'utf8')
	);
	assert.equal(pkg.packageManager, 'pnpm@9.15.9');
	assert.equal(pkg.engines.pnpm, '>=9.13.0');
	assert.match(
		fs.readFileSync(path.join(root, '.npmrc'), 'utf8'),
		/use-node-version=/
	);

	const launch = JSON.parse(
		fs.readFileSync(path.join(root, '.claude', 'launch.json'), 'utf8')
	);
	assert.ok(
		launch.configurations.every((c) => c.runtimeExecutable === 'pnpm')
	);

	const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
	assert.match(claude, /pnpm run playground:start/);
	assert.match(claude, /never insert a literal `--` separator/);
	assert.match(claude, /pnpm exec krokedil-playground compose/);
	assert.doesNotMatch(claude, /__PM__|__PM_EXEC__|__FLAGS_NOTE__/);
});

test('scaffold treats an undeclared package.json as npm (CI detection)', async (t) => {
	const root = makePluginRoot(t);
	fs.writeFileSync(
		path.join(root, 'package.json'),
		JSON.stringify({ name: 'my-payment-gateway', version: '1.0.0' })
	);
	await runScaffold(root, []);

	const pkg = JSON.parse(
		fs.readFileSync(path.join(root, 'package.json'), 'utf8')
	);
	// No packageManager stamp — its absence is what makes CI build with npm.
	assert.equal(pkg.packageManager, undefined);
	assert.equal(pkg.engines.pnpm, undefined);
	assert.match(pkg.engines.node, /^>=20\.19/);
	// use-node-version is pnpm-only; npm plugins get just .nvmrc.
	assert.ok(!fs.existsSync(path.join(root, '.npmrc')));
	assert.ok(fs.existsSync(path.join(root, '.nvmrc')));

	const launch = JSON.parse(
		fs.readFileSync(path.join(root, '.claude', 'launch.json'), 'utf8')
	);
	assert.ok(
		launch.configurations.every((c) => c.runtimeExecutable === 'npm')
	);

	const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
	assert.match(claude, /npm run playground:start/);
	assert.match(claude, /playground:start -- --xdebug/);
	assert.match(claude, /npm exec krokedil-playground compose/);
	assert.doesNotMatch(claude, /__PM__|__PM_EXEC__|__FLAGS_NOTE__/);
});

test('scaffold treats a yarn declaration as npm and preserves it', async (t) => {
	const root = makePluginRoot(t);
	fs.writeFileSync(
		path.join(root, 'package.json'),
		JSON.stringify({ name: 'x', packageManager: 'yarn@4.0.0' })
	);
	await runScaffold(root, []);

	const pkg = JSON.parse(
		fs.readFileSync(path.join(root, 'package.json'), 'utf8')
	);
	assert.equal(pkg.packageManager, 'yarn@4.0.0');
	assert.equal(pkg.engines.pnpm, undefined);
	const launch = JSON.parse(
		fs.readFileSync(path.join(root, '.claude', 'launch.json'), 'utf8')
	);
	assert.ok(
		launch.configurations.every((c) => c.runtimeExecutable === 'npm')
	);
});

test('scaffold keeps pnpm treatment for declared pnpm plugins without re-stamping', async (t) => {
	const root = makePluginRoot(t);
	fs.writeFileSync(
		path.join(root, 'package.json'),
		JSON.stringify({
			name: 'x',
			devEngines: { packageManager: { name: 'pnpm', version: '9' } },
		})
	);
	await runScaffold(root, []);

	const pkg = JSON.parse(
		fs.readFileSync(path.join(root, 'package.json'), 'utf8')
	);
	// pnpm via devEngines: pnpm treatment, but no redundant second declaration.
	assert.equal(pkg.packageManager, undefined);
	assert.equal(pkg.engines.pnpm, '>=9.13.0');
	assert.match(
		fs.readFileSync(path.join(root, '.npmrc'), 'utf8'),
		/use-node-version=/
	);
	const launch = JSON.parse(
		fs.readFileSync(path.join(root, '.claude', 'launch.json'), 'utf8')
	);
	assert.ok(
		launch.configurations.every((c) => c.runtimeExecutable === 'pnpm')
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

	await runScaffold(root, []);

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
	await runScaffold(bare, []);
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
	await runScaffold(root, []);
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
	await runScaffold(root, ['--update']);
	pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	assert.equal(pkg.devDependencies['@krokedil/wp-playground-tools'], pinned);
});

test('scaffold stubs the config’s envSecret names into the central credentials file', async (t) => {
	const root = makePluginRoot(t);
	fs.writeFileSync(
		path.join(root, 'playground.config.mjs'),
		"export default {\n\tslug: 'my-payment-gateway',\n\tbasePort: 8890,\n" +
			"\toptions: { all: { key: envSecret('GATEWAY_TEST_KEY') } },\n};\n"
	);
	await runScaffold(root, []);

	const central = fs.readFileSync(path.join(root, 'central.env'), 'utf8');
	assert.match(central, /# --- my-payment-gateway ---\n# GATEWAY_TEST_KEY=/);
	assert.match(central, /# NGROK_AUTHTOKEN=/);
	assert.match(central, /# KROKEDIL_PG_TUNNEL_PASS=/);
});

test('scaffold stubs nothing from the template’s commented examples', async (t) => {
	const root = makePluginRoot(t);
	await runScaffold(root, []);

	// The scaffolded config's envSecret() example is commented out, so a fresh
	// onboard must not push a placeholder into the file every plugin shares.
	const central = fs.readFileSync(path.join(root, 'central.env'), 'utf8');
	assert.ok(!central.includes('MY_TEST_SECRET'));
	assert.ok(!central.includes('# --- my-payment-gateway ---'));
	// The per-user tooling stubs are unconditional and still land.
	assert.match(central, /# NGROK_AUTHTOKEN=/);
});

test('scaffold --update respects a custom basePort from the config', async (t) => {
	const root = makePluginRoot(t);
	await runScaffold(root, []);
	fs.writeFileSync(
		path.join(root, 'playground.config.mjs'),
		"export default { slug: 'my-payment-gateway', basePort: 8890 };\n"
	);
	await runScaffold(root, ['--update']);
	const launch = JSON.parse(
		fs.readFileSync(path.join(root, '.claude', 'launch.json'), 'utf8')
	);
	const start = launch.configurations.find((c) => /-start$/.test(c.name));
	assert.equal(start.port, 8890);
});

/**
 * Read the README's port registry table.
 *
 * @return {{ claimed: Map<number, string>, nextFree: number|null }} Claimed
 *         rows by port, and the port of the "next plugin here" row.
 */
function parsePortRegistry() {
	const readme = fs.readFileSync(
		new URL('../README.md', import.meta.url),
		'utf8'
	);
	const section = /^## Port registry$([\s\S]*?)^## /m.exec(readme);
	assert.ok(section, 'README.md: the "## Port registry" section is missing');

	const claimed = new Map();
	let nextFree = null;
	for (const [, port, plugin] of section[1].matchAll(
		/^\|\s*(\d+)\s*\|\s*(.+?)\s*\|$/gm
	)) {
		if (/next plugin here/.test(plugin)) {
			nextFree = Number(port);
		} else {
			claimed.set(Number(port), plugin);
		}
	}
	return { claimed, nextFree };
}

// The commented-out example in the scaffolded config and the schema example in
// the README are copy-paste bait: a plugin that keeps either verbatim silently
// takes another plugin's ports. That has happened twice (8890 was klarna's row,
// then 8900 became qliro's — see the 1.2.0 changelog entry), so both examples
// are pinned to the registry's free row rather than trusted to be hand-synced.
test('the example basePort in the template and README is the registry’s next free row', () => {
	const { claimed, nextFree } = parsePortRegistry();
	assert.ok(
		claimed.size >= 3 && nextFree !== null,
		'README.md: the port registry table did not parse — it needs claimed rows and a "next plugin here" row'
	);

	const examples = [
		[
			'src/init/templates/playground.config.template.mjs',
			/^\s*\/\/ basePort: (\d+),/m,
		],
		['README.md', /^\tbasePort: (\d+),/m],
	];
	for (const [file, pattern] of examples) {
		const found = pattern.exec(
			fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
		);
		assert.ok(found, `${file}: no example basePort found`);

		const port = Number(found[1]);
		const owner = claimed.get(port);
		assert.equal(
			port,
			nextFree,
			`${file}: the example basePort ${port} ${
				owner
					? `is ${owner}'s claimed registry row`
					: 'is not the registry’s free row'
			} — when a port is claimed, move both examples (and the "next plugin here" row) to ${nextFree}`
		);
	}
});
