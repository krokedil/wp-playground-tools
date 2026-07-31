/**
 * Tests for the per-checkout site id that prefixes order numbers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	deriveSiteId,
	nextSiteToken,
	publishSiteId,
	siteIdFile,
} from '../src/site-id.mjs';

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
