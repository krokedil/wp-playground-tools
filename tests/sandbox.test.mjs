/**
 * Guards the committed sandbox: its config must keep normalizing and
 * composing as the schema evolves, so `pnpm run sandbox:*` cannot silently
 * rot. Also covers the ensurePrereqs package.json gate the sandbox relies on
 * (sandbox/ has no package.json of its own).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { composeBlueprint } from '../src/blueprint/compose.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { ensurePrereqs } from '../src/prepare.mjs';
import sandboxRawConfig from '../sandbox/playground.config.mjs';

const sandboxConfig = normalizeConfig(sandboxRawConfig, {
	hasComposerJson: false,
});

test('sandbox config normalizes with the expected identity', () => {
	assert.equal(sandboxConfig.slug, 'krokedil-playground-sandbox');
	assert.equal(sandboxConfig.basePort, 9880);
	assert.equal(sandboxConfig.tunnel.provider, 'ngrok');
	assert.equal(sandboxConfig.composer, null);
	assert.equal(sandboxConfig.build, null);
	assert.deepEqual(sandboxConfig.activate, ['krokedil-playground-sandbox']);
	assert.deepEqual(sandboxConfig.https.hosts, ['localhost']);
});

test('sandbox blueprints compose for every configured server mode', () => {
	for (const mode of sandboxConfig.modes.filter((m) => m !== 'start')) {
		const blueprint = composeBlueprint(sandboxConfig, mode);
		assert.ok(
			Array.isArray(blueprint.steps) && blueprint.steps.length > 0,
			`${mode}: blueprint has steps`
		);
		const json = JSON.stringify(blueprint);
		assert.ok(
			json.includes(
				'/wordpress/wp-content/plugins/krokedil-playground-sandbox'
			),
			`${mode}: container paths derive from the sandbox slug`
		);
		assert.ok(
			json.includes('plugin activate krokedil-playground-sandbox'),
			`${mode}: the sandbox plugin is activated`
		);
	}
});

test('ensurePrereqs is a no-op for a root without package.json', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sandbox-prereqs-'));
	try {
		ensurePrereqs(dir, sandboxConfig, false);
		assert.ok(
			!fs.existsSync(path.join(dir, 'node_modules')),
			'no node_modules was created'
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
