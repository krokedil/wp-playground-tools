/**
 * Tests for the screenshot engine's pure helpers. The prune "keep" values
 * guard an `rm -rf` — an invalid value must fall back to the default, never
 * become NaN/0 (both of which select the entire list for deletion).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { keepCount } from '../src/screenshots/capture.mjs';

test('keepCount accepts positive integers', () => {
	assert.equal(keepCount('5', 30), 5);
	assert.equal(keepCount('1', 30), 1);
});

test('keepCount falls back when unset', () => {
	assert.equal(keepCount(undefined, 30), 30);
	assert.equal(keepCount('', 6), 6);
});

test('keepCount rejects values that would wipe everything', () => {
	assert.equal(keepCount('abc', 30), 30); // NaN passes `length <= keep`…
	assert.equal(keepCount('0', 30), 30); // …and 0 keeps nothing.
	assert.equal(keepCount('-3', 6), 6);
	assert.equal(keepCount('3.5', 6), 6);
});
