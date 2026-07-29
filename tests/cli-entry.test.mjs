/**
 * Tests for the cli.mjs direct-execution guard.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

test('cli runs main() when invoked directly', () => {
	const res = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
	assert.match(res.stderr, /usage: krokedil-playground/);
});

test('cli runs main() when argv[1] is a symlink (pnpm bin stub)', (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cli-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const link = path.join(dir, 'cli-link.mjs');
	fs.symlinkSync(CLI, link);

	const res = spawnSync(process.execPath, [link], { encoding: 'utf8' });
	assert.match(res.stderr, /usage: krokedil-playground/);
});
