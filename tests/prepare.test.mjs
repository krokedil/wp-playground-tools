/**
 * Tests for the pure decision helpers in src/prepare.mjs.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { normalizeConfig } from '../src/config.mjs';
import {
	buildLaunchArgs,
	buildModes,
	computeSiteHash,
	decideBlueprint,
	nodeSatisfiesPin,
} from '../src/prepare.mjs';

test('nodeSatisfiesPin accepts only >=20.19', () => {
	assert.equal(nodeSatisfiesPin('20.19.0'), true);
	assert.equal(nodeSatisfiesPin('20.20.5'), true);
	assert.equal(nodeSatisfiesPin('22.23.2'), true);
	assert.equal(nodeSatisfiesPin('24.18.0'), true);
	assert.equal(nodeSatisfiesPin('20.18.3'), false);
	assert.equal(nodeSatisfiesPin('18.20.0'), false);
});

test('computeSiteHash matches the CLI site key (sha256 of cwd)', () => {
	// Synthetic fixture: any path works, the function is a pure sha256.
	const cwd = '/home/dev/plugins/example-plugin/.claude/worktrees/example-1';
	assert.equal(
		computeSiteHash(cwd),
		crypto.createHash('sha256').update(cwd).digest('hex')
	);
	assert.match(computeSiteHash(cwd), /^[0-9a-f]{64}$/);
});

test('decideBlueprint: first run provisions with reset + blueprint', () => {
	const decision = decideBlueprint('bp.json', [], false);
	assert.deepEqual(decision.injected, ['--reset', '--blueprint=bp.json']);
	assert.equal(decision.provisioning, true);
	assert.equal(decision.reason, 'first-run');
});

test('decideBlueprint: --fresh reprovisions an existing site', () => {
	const decision = decideBlueprint('bp.json', ['--fresh'], true);
	assert.deepEqual(decision.injected, ['--reset', '--blueprint=bp.json']);
	assert.equal(decision.reason, 'reprovision');
});

test('decideBlueprint: a user --blueprint gets --reset paired in', () => {
	const decision = decideBlueprint(
		'bp.json',
		['--blueprint=other.json'],
		true
	);
	assert.deepEqual(decision.injected, ['--reset']);
	assert.equal(decision.reason, 'pair-reset');
});

test('decideBlueprint: warm boot injects nothing', () => {
	const decision = decideBlueprint('bp.json', [], true);
	assert.deepEqual(decision.injected, []);
	assert.equal(decision.provisioning, false);
	assert.equal(decision.reason, 'warm');
});

test('buildModes derives ports, mount and blueprints from config', () => {
	const config = normalizeConfig({ slug: 'my-plugin', basePort: 9000 });
	const modes = buildModes(config);

	assert.equal(modes.start.port, 9000);
	assert.equal(modes.development.port, 9001);
	assert.equal(modes.demo.port, 9002);
	assert.equal(modes.e2e, undefined); // e2e is opt-in
	assert.ok(modes.setup.setupOnly);

	const mount = '.:/wordpress/wp-content/plugins/my-plugin';
	// --no-login (start defaults login to true): the CLI's per-client
	// auto-login redirect-loops cookie-less clients;
	// playground-dev-login.php owns local login (see buildModes).
	assert.deepEqual(modes.start.flags, [
		'--no-login',
		'--no-auto-mount',
		`--mount=${mount}`,
	]);
	assert.equal(
		modes.start.blueprint,
		`.playground/blueprint.development.json`
	);
	assert.ok(modes.start.persistent);
	assert.deepEqual(modes.demo.flags, [
		'--blueprint=.playground/blueprint.demo.json',
		`--mount=${mount}`,
	]);
});

test('buildModes includes e2e only when configured', () => {
	const config = normalizeConfig({
		slug: 'my-plugin',
		modes: ['start', 'development', 'demo', 'e2e'],
	});
	assert.equal(buildModes(config).e2e.port, 8883);
});

test('buildLaunchArgs orders subcommand, flags, injected, forwarded', () => {
	const mode = { subcommand: 'start', flags: ['--no-auto-mount'] };
	assert.deepEqual(buildLaunchArgs(mode, ['--reset'], ['--xdebug']), [
		'start',
		'--no-auto-mount',
		'--reset',
		'--xdebug',
	]);
});
