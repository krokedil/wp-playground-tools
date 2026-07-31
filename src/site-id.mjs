/**
 * The site id: a short, stable name for one checkout's playground site.
 *
 * Every playground site starts numbering orders at 1, so several of them
 * sharing a payment provider's test merchant collide the moment two sites send
 * an order reference — Qliro answers "Order with reference '38' already
 * exists" and the purchase fails. The id prefixes this site's order numbers
 * (see assets/mu-plugins/playground-order-prefix.php) so references are unique
 * across checkouts without anyone coordinating.
 *
 * It is the same `sha256(cwd)` digest that keys the persistent site and the
 * wildcard tunnel host, so a site, its public URL and its order numbers all
 * carry one identity — `c345befa-38` came from the checkout serving
 * `…-c345befa.krokedil.ngrok.io`.
 *
 * The contract with the site mirrors proxy-url.txt: the id is written to
 * <plugin>/.playground/site-id.txt and read at runtime by the mu-plugin. No DB
 * writes, so warm boots and reprovisions both pick up the current value.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { globalEnvFile } from './env.mjs';
import { writeRuntimeReadable } from './runtime-file.mjs';

/** Digest characters kept — collision-safe across one team's checkouts. */
const ID_LENGTH = 8;

/**
 * Compute the persistent-site directory key the CLI uses: sha256 of the cwd.
 *
 * Lives here rather than in prepare.mjs because everything derived from it is
 * checkout identity — the site directory, the wildcard tunnel host's label and
 * the order-number prefix are one identity seen from three places.
 *
 * @param {string} cwd Working directory the CLI is launched from.
 * @return {string} Lowercase hex sha256 digest.
 */
export function computeSiteHash(cwd) {
	return crypto.createHash('sha256').update(cwd).digest('hex');
}

/**
 * Path of the site id file inside the plugin's staging dir.
 *
 * @param {string} root Plugin root.
 * @return {string} Absolute path.
 */
export function siteIdFile(root) {
	return path.join(root, '.playground', 'site-id.txt');
}

/**
 * Derive a checkout's site id.
 *
 * @param {string} cwd Plugin root (the site's identity).
 * @return {string} 8 hex characters.
 */
export function deriveSiteId(cwd) {
	return computeSiteHash(cwd).slice(0, ID_LENGTH);
}

/**
 * Work out the token this run should stamp on order numbers.
 *
 * A reprovision (`--fresh`) wipes the site and WooCommerce starts again at
 * order 1 — which the provider still holds references for from before the
 * reset, from this very site. So each reprovision advances a counter: the
 * first provision is the bare id, the next `<id>-2`, and so on. Warm boots
 * keep whatever the last provision wrote, because the reference a provider
 * stored for an existing order must not drift under it (klarna-checkout
 * hard-compares the two).
 *
 * @param {string|null} previous          Token from a previous run, if any.
 * @param {Object}      opts              Options.
 * @param {string}      opts.id           This checkout's site id.
 * @param {boolean}     opts.provisioning Whether this run reprovisions.
 * @return {string} The token to publish.
 */
export function nextSiteToken(previous, { id, provisioning }) {
	// Exactly the id, or the id plus a counter — not merely a value starting
	// with it: another checkout's `c345befa2` must not be inherited, or this
	// site adopts a token that is already stamped on someone else's orders.
	const mine =
		previous === id || previous?.startsWith(`${id}-`) ? previous : null;
	if (!provisioning) {
		return mine ?? id;
	}
	if (!mine) {
		return id;
	}
	const [, n] = /-(\d+)$/.exec(mine) ?? [];
	return `${id}-${n ? Number(n) + 1 : 2}`;
}

/**
 * Publish this run's site id token, advancing it when the run reprovisions.
 *
 * @param {string}  root                Plugin root.
 * @param {Object}  [opts]              Options.
 * @param {boolean} [opts.provisioning] Whether this run reprovisions.
 * @return {string} The published token.
 */
export function publishSiteId(root, { provisioning = false } = {}) {
	const file = siteIdFile(root);
	const previous = fs.existsSync(file)
		? fs.readFileSync(file, 'utf8').trim()
		: null;
	const token = nextSiteToken(previous, {
		id: deriveSiteId(root),
		provisioning,
	});
	writeRuntimeReadable(file, token + '\n');
	return token;
}

/**
 * Path of the machine-wide registry of checkouts that have booted.
 *
 * Sibling of the central credentials file — one directory for "things every
 * plugin checkout on this machine shares".
 *
 * @return {string} Absolute path.
 */
export function siteRegistryFile() {
	return path.join(path.dirname(globalEnvFile()), 'sites.json');
}

/**
 * Read the registry.
 *
 * @param {Object} [opts]      Options.
 * @param {string} [opts.file] Registry path (a seam for tests).
 * @return {Object} Entries keyed by site id; {} when there is no readable file.
 */
export function readSiteRegistry({ file = siteRegistryFile() } = {}) {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		// Absent, unreadable or corrupt: the registry is a convenience, and
		// callers get "unknown id" rather than an error.
		return {};
	}
}

/**
 * Read the current branch of a checkout, for the registry entry.
 *
 * The id names a path, and a path outlives the branch checked out in it — so
 * recording the branch at boot is the only way to answer "which branch placed
 * this order" after the worktree has moved on.
 *
 * @param {string} root Plugin root.
 * @return {string|null} Branch name, or null outside a git checkout.
 */
function currentBranch(root) {
	const res = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
		cwd: root,
		encoding: 'utf8',
	});
	const name = res.status === 0 ? res.stdout.trim() : '';
	return name && name !== 'HEAD' ? name : null;
}

/**
 * Record this checkout in the registry, so `site-id <id>` can resolve an order
 * prefix seen in a provider's portal back to a checkout and branch.
 *
 * Never throws: a read-only home directory or a CI runner must not fail a
 * launch over a lookup convenience.
 *
 * @param {string} root        Plugin root.
 * @param {string} token       The published token.
 * @param {Object} [opts]      Options.
 * @param {string} [opts.slug] Plugin slug, when known.
 * @param {string} [opts.file] Registry path (a seam for tests).
 * @param {string} [opts.now]  ISO timestamp (a seam for tests).
 * @return {boolean} Whether the entry was written.
 */
export function recordSiteId(root, token, { slug, file, now } = {}) {
	const target = file ?? siteRegistryFile();
	try {
		const registry = readSiteRegistry({ file: target });
		registry[deriveSiteId(root)] = {
			token,
			path: root,
			slug: slug ?? path.basename(root),
			branch: currentBranch(root),
			seen: now ?? new Date().toISOString(),
		};
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, JSON.stringify(registry, null, '\t') + '\n');
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve a site id — or a full order prefix like `c345befa-2` — back to the
 * checkout that produced it.
 *
 * @param {string} idOrToken   Site id, with or without the reprovision counter.
 * @param {Object} [opts]      Options.
 * @param {string} [opts.file] Registry path (a seam for tests).
 * @return {Object|null} The registry entry plus its id, or null when unknown.
 */
export function resolveSiteId(idOrToken, { file = siteRegistryFile() } = {}) {
	const id = String(idOrToken ?? '')
		.trim()
		.replace(/-\d+$/, '');
	const entry = readSiteRegistry({ file })[id];
	return entry ? { id, ...entry } : null;
}

/**
 * `site-id [<id>]` — print this checkout's token, or resolve someone else's.
 *
 * @param {string}   root   Plugin root.
 * @param {string[]} [args] CLI args after the subcommand.
 * @return {number} Process exit code.
 */
export function runSiteId(root, args = []) {
	const [wanted] = args.filter((a) => !a.startsWith('-'));

	if (!wanted) {
		const file = siteIdFile(root);
		// Before a first boot there is no file yet, but the id is derivable —
		// answer anyway rather than telling the user to boot a site first.
		const token = fs.existsSync(file)
			? fs.readFileSync(file, 'utf8').trim()
			: deriveSiteId(root);
		const branch = currentBranch(root);
		process.stdout.write(`${token}\n`);
		process.stderr.write(
			`  ${root}${branch ? ` (${branch})` : ''}\n` +
				`  order numbers on this site read ${token}-<n>\n`
		);
		return 0;
	}

	const found = resolveSiteId(wanted);
	if (!found) {
		process.stderr.write(
			`✖ playground: no checkout known for "${wanted}". The registry lists ` +
				`checkouts that have booted a playground on this machine — boot that ` +
				`site once, or look for the id in another machine's registry.\n`
		);
		return 1;
	}
	process.stdout.write(`${found.path}\n`);
	process.stderr.write(
		`  site id ${found.id}, token ${found.token}, plugin ${found.slug}\n` +
			`  branch at last boot: ${found.branch ?? '(unknown)'}\n` +
			`  last seen: ${found.seen}\n`
	);
	return 0;
}
