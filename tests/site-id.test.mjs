/**
 * Tests for the per-checkout site id that prefixes order numbers.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	computeSiteHash,
	deriveSiteId,
	nextSiteToken,
	publishSiteId,
	readSiteRegistry,
	recordSiteId,
	resolveSiteId,
	siteIdFile,
} from '../src/site-id.mjs';

test('computeSiteHash matches the CLI site key (sha256 of cwd)', () => {
	// Synthetic fixture: any path works, the function is a pure sha256.
	const cwd = '/home/dev/plugins/example-plugin/.claude/worktrees/example-1';
	assert.equal(
		computeSiteHash(cwd),
		crypto.createHash('sha256').update(cwd).digest('hex')
	);
	assert.match(computeSiteHash(cwd), /^[0-9a-f]{64}$/);
});

test('deriveSiteId is stable per checkout and distinct between checkouts', () => {
	const id = deriveSiteId('/repos/qliro');
	assert.match(id, /^[0-9a-f]{8}$/);
	assert.equal(deriveSiteId('/repos/qliro'), id);
	assert.notEqual(deriveSiteId('/repos/qliro-worktree-2'), id);
});

test('nextSiteToken holds steady on warm boots, advances on reprovision', () => {
	const id = 'c345befa';

	// Warm boots must not move it: a provider holding the reference for an
	// existing order compares it against the order number later.
	assert.equal(nextSiteToken(null, { id, provisioning: false }), id);
	assert.equal(nextSiteToken(id, { id, provisioning: false }), id);
	assert.equal(
		nextSiteToken(`${id}-3`, { id, provisioning: false }),
		`${id}-3`
	);

	// First provision is the bare id; each reset advances, because the site
	// renumbers from 1 and would re-send references it already used.
	assert.equal(nextSiteToken(null, { id, provisioning: true }), id);
	assert.equal(nextSiteToken(id, { id, provisioning: true }), `${id}-2`);
	assert.equal(
		nextSiteToken(`${id}-2`, { id, provisioning: true }),
		`${id}-3`
	);
	assert.equal(
		nextSiteToken(`${id}-9`, { id, provisioning: true }),
		`${id}-10`
	);

	// A token from another checkout (copied .playground/, restored backup)
	// must not be inherited — it would recreate the collision it prevents.
	assert.equal(nextSiteToken('deadbeef-4', { id, provisioning: false }), id);

	// Nor one that merely starts with this id: `c345befa2` is a different
	// checkout whose digest happens to share a prefix.
	for (const foreign of [`${id}2`, `${id}beef`, `${id}_2`]) {
		assert.equal(
			nextSiteToken(foreign, { id, provisioning: false }),
			id,
			`inherited ${foreign}`
		);
		assert.equal(
			nextSiteToken(foreign, { id, provisioning: true }),
			id,
			`inherited ${foreign} on reprovision`
		);
	}
});

test('publishSiteId writes the mu-plugin contract file, runtime-readable', (t) => {
	const previousUmask = process.umask(0o077);
	t.after(() => process.umask(previousUmask));

	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-site-id-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	const first = publishSiteId(root);
	const file = siteIdFile(root);
	assert.equal(
		file,
		path.join(root, '.playground', 'site-id.txt'),
		'the mu-plugin contract: .playground/site-id.txt'
	);
	assert.equal(fs.readFileSync(file, 'utf8').trim(), first);
	assert.equal(first, deriveSiteId(root));

	// Owner-only would be invisible to the runtime, and the mu-plugin would
	// silently stop prefixing.
	assert.equal(fs.statSync(file).mode % 0o10, 0o4, 'not runtime-readable');

	assert.equal(publishSiteId(root), first, 'warm boot keeps the token');
	assert.equal(
		publishSiteId(root, { provisioning: true }),
		`${first}-2`,
		'a reprovision advances it'
	);
	assert.equal(fs.readFileSync(file, 'utf8').trim(), `${first}-2`);
});

test('the registry resolves an order prefix back to its checkout', (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-registry-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, 'nested', 'sites.json');

	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-checkout-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const id = deriveSiteId(root);

	assert.equal(resolveSiteId(id, { file }), null, 'unknown before any boot');
	assert.equal(
		recordSiteId(root, id, { slug: 'my-plugin', file, now: 'T0' }),
		true
	);

	const found = resolveSiteId(id, { file });
	assert.equal(found.path, root);
	assert.equal(found.slug, 'my-plugin');
	assert.equal(found.seen, 'T0');

	// The prefix as read off an order (`c345befa-2-38` → `c345befa-2`) must
	// resolve too — that is the string you actually have in a provider portal.
	assert.deepEqual(resolveSiteId(`${id}-2`, { file }), found);
	assert.deepEqual(resolveSiteId(` ${id} `, { file }), found);

	// Re-booting updates in place instead of accumulating entries.
	recordSiteId(root, `${id}-2`, { slug: 'my-plugin', file, now: 'T1' });
	const registry = readSiteRegistry({ file });
	assert.equal(Object.keys(registry).length, 1);
	assert.equal(registry[id].token, `${id}-2`);
	assert.equal(registry[id].seen, 'T1');

	assert.equal(resolveSiteId('deadbeef', { file }), null);
});

test('a broken or unwritable registry never breaks a launch', (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-registry-bad-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	// Corrupt file: readable, not JSON.
	const corrupt = path.join(dir, 'sites.json');
	fs.writeFileSync(corrupt, 'not json at all');
	assert.deepEqual(readSiteRegistry({ file: corrupt }), {});
	assert.equal(resolveSiteId('c345befa', { file: corrupt }), null);
	// …and writing over it recovers rather than throwing.
	assert.equal(recordSiteId(dir, 'c345befa', { file: corrupt }), true);

	// Unwritable location: recordSiteId reports failure, callers carry on.
	const blocked = path.join(dir, 'sites.json', 'nested.json');
	assert.equal(recordSiteId(dir, 'c345befa', { file: blocked }), false);
});
