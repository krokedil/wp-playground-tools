/**
 * Staging helpers for files the Playground runtime reads back out of the
 * mounted plugin directory (<plugin>/.playground/).
 *
 * Where the runtime reaches the mount as a uid other than the host process
 * that wrote it, an owner-only file is simply not there as far as the site is
 * concerned — and every consumer of these files fails quietly: an unreadable
 * tunnel-password.txt leaves the default admin password working on a public
 * URL, an unreadable proxy-url.txt leaves the site serving localhost URLs, the
 * seeder finds no seed data and an installPlugin step cannot open its zip, with
 * nothing in any log. From a `umask 077` shell (or a checkout with 0600 files)
 * that is the default outcome, so the mode has to be a deliberate choice
 * rather than whatever the developer's shell happened to hand us.
 *
 * Hence: everything staged for the runtime goes through here, and here always
 * ends in an explicit chmod. `fs.writeFileSync`'s `mode` option and
 * `fs.copyFileSync`'s mode inheritance both go through open(2) and are masked
 * by the caller's umask — under `umask 077` both produce 0600 — so only a
 * separate chmod(2) is deterministic, and it also repairs a file that already
 * exists from an earlier run.
 *
 * Directories get the same treatment (0755): a world-readable file inside a
 * 0700 directory is still unreachable, since reaching it means traversing in.
 * That stops at `.playground/` — this generated staging directory is ours to
 * normalize, while the plugin checkout that contains it is the developer's own
 * umask to answer for.
 *
 * Nothing here is about secrecy: the staging dir holds generated dev assets,
 * and the files that do carry credentials (the tunnel password, private
 * options baked into the blueprint) are already readable by anyone who can
 * read the checkout.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Mode every staged file gets: owner-writable, world-readable. */
const RUNTIME_MODE = 0o644;

/** Mode every staging directory gets: world-readable and traversable. */
const RUNTIME_DIR_MODE = 0o755;

/**
 * Staging directory basename — the boundary the directory walk stops at. Same
 * literal as prepare.mjs's STAGING_DIR, kept local on purpose: prepare.mjs
 * imports compose.mjs, which imports this module, so importing it back would
 * close a cycle.
 */
const STAGING_DIR_NAME = '.playground';

/** Directories already normalized in this process (a chmod is not free). */
const normalizedDirs = new Set();

/**
 * chmod that says what it was for when it fails (a staged file the runtime
 * cannot read is a silent failure, so a loud one here is the better trade).
 *
 * @param {string} target Path to chmod.
 * @param {number} mode   Mode to set.
 */
function chmodOrExplain(target, mode) {
	try {
		fs.chmodSync(target, mode);
	} catch (err) {
		throw new Error(
			`could not make ${target} readable by the Playground runtime: ${err.message}`
		);
	}
}

/**
 * Create a staging directory and make it traversable, along with every level
 * up to and including `.playground` itself. Paths with no `.playground`
 * ancestor (the host-side zip cache, say) are created but left alone.
 *
 * @param {string} dir Absolute directory path.
 */
function ensureRuntimeDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
	if (normalizedDirs.has(dir)) {
		return;
	}

	// Walk up collecting levels first: nothing is chmodded unless the walk
	// actually reaches .playground, so a stray path cannot widen a parent.
	const levels = [];
	let current = dir;
	let staging = false;
	for (;;) {
		levels.push(current);
		if (path.basename(current) === STAGING_DIR_NAME) {
			staging = true;
			break;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	if (!staging) {
		return;
	}

	for (const level of levels) {
		if (!normalizedDirs.has(level)) {
			chmodOrExplain(level, RUNTIME_DIR_MODE);
			normalizedDirs.add(level);
		}
	}
}

/**
 * Write a file the runtime must be able to read.
 *
 * @param {string}        file     Absolute destination path.
 * @param {string|Buffer} contents File contents.
 */
export function writeRuntimeReadable(file, contents) {
	ensureRuntimeDir(path.dirname(file));
	fs.writeFileSync(file, contents);
	chmodOrExplain(file, RUNTIME_MODE);
}

/**
 * Copy a file into the staging dir so the runtime can read it. Unlike a plain
 * copyFileSync the destination mode does not depend on the source's — a
 * repo file checked out 0600 still stages readable.
 *
 * @param {string} source Absolute source path.
 * @param {string} dest   Absolute destination path.
 */
export function copyRuntimeReadable(source, dest) {
	ensureRuntimeDir(path.dirname(dest));
	fs.copyFileSync(source, dest);
	chmodOrExplain(dest, RUNTIME_MODE);
}
