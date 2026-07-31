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
import fs from 'node:fs';
import path from 'node:path';

import { computeSiteHash } from './prepare.mjs';
import { writeRuntimeReadable } from './runtime-file.mjs';

/** Digest characters kept — collision-safe across one team's checkouts. */
const ID_LENGTH = 8;

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
	const mine = previous?.startsWith(`${id}`) ? previous : null;
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
