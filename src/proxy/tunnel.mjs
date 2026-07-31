/**
 * Proxy orchestration for --tunnel (public https via a tunnel provider) and
 * --https (local mkcert reverse proxy).
 *
 * Both mechanisms share one contract with the site: the public URL is written
 * to <plugin>/.playground/proxy-url.txt, which the always-staged
 * playground-proxy-url.php mu-plugin reads at runtime (no DB writes, warm-boot
 * safe, self-reverting when the file is deleted).
 *
 * --tunnel adds a second file on the same contract:
 * .playground/tunnel-password.txt, read by playground-tunnel-guard.php. A
 * tunnel URL is reachable by anyone who has it, and the Playground admin
 * password is the well-known default — so while a tunnel runs, logging in
 * through it requires this per-run password instead.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { computeSiteHash } from '../prepare.mjs';
import { writeRuntimeReadable } from '../runtime-file.mjs';

/** Registered tunnel providers. cloudflared etc. are later drop-ins. */
const PROVIDERS = {
	ngrok: () => import('./ngrok.mjs'),
};

/**
 * Path of the proxy URL file inside the plugin's staging dir.
 *
 * @param {string} root Plugin root.
 * @return {string} Absolute path.
 */
export function proxyUrlFile(root) {
	return path.join(root, '.playground', 'proxy-url.txt');
}

/**
 * Publish the active proxy URL to the site.
 *
 * @param {string} root Plugin root.
 * @param {string} url  Public URL.
 */
export function writeProxyUrl(root, url) {
	writeRuntimeReadable(proxyUrlFile(root), url + '\n');
}

/**
 * Remove the proxy URL file (defensively — also called before every
 * non-proxied launch so a crashed proxy run can't leave the site pointing at
 * a dead URL).
 *
 * @param {string} root Plugin root.
 */
export function clearProxyUrl(root) {
	fs.rmSync(proxyUrlFile(root), { force: true });
}

/**
 * Path of the tunnel admin password file inside the plugin's staging dir.
 *
 * @param {string} root Plugin root.
 * @return {string} Absolute path.
 */
export function tunnelPasswordFile(root) {
	return path.join(root, '.playground', 'tunnel-password.txt');
}

/**
 * Publish the tunnel admin password to the site.
 *
 * @param {string} root     Plugin root.
 * @param {string} password The password wp-login accepts over the tunnel.
 */
export function writeTunnelPassword(root, password) {
	writeRuntimeReadable(tunnelPasswordFile(root), password + '\n');
}

/**
 * Remove the tunnel password file, which disarms the guard mu-plugin.
 *
 * Also called before every launch: a crashed tunnel run must not leave a site
 * demanding a password nobody knows any more.
 *
 * @param {string} root Plugin root.
 */
export function clearTunnelPassword(root) {
	fs.rmSync(tunnelPasswordFile(root), { force: true });
}

/**
 * Resolve the admin password to require over the tunnel.
 *
 * KROKEDIL_PG_TUNNEL_PASS (shell profile or the plugin's .env, which
 * loadConfig has already applied) gives every Krokedil playground the same
 * public login, so it can be documented in a team runbook instead of read off
 * a terminal. Empty counts as unset — same rule as envSecret(), where CI
 * renders missing secrets as ''. Without it, a random per-run password is
 * generated and printed. Exported for tests.
 *
 * @param {Object} [options]     Options.
 * @param {Object} [options.env] Env map to read (default process.env).
 * @return {{ password: string, fromEnv: boolean }} The password and its origin.
 */
export function resolveTunnelPassword({ env = process.env } = {}) {
	const name = 'KROKEDIL_PG_TUNNEL_PASS';
	// Own properties only — env.constructor etc. must read as unset.
	const configured = Object.hasOwn(env, name) ? env[name] : undefined;
	if (configured !== undefined && configured !== '') {
		return { password: configured, fromEnv: true };
	}
	// base32-ish alphabet: no look-alike characters, safe to read aloud or
	// paste from the terminal banner.
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	const bytes = crypto.randomBytes(20);
	let password = '';
	for (const byte of bytes) {
		password += alphabet[byte % alphabet.length];
	}
	return { password, fromEnv: false };
}

/**
 * Resolve the tunnel domain a run should serve.
 *
 * A per-run --tunnel-domain override wins over config.tunnel.domain: parallel
 * worktrees share the same committed config, so a second instance can point
 * itself elsewhere — or pass 'none' to let the provider choose. Exported for
 * tests.
 *
 * @param {Object}      config         Normalized plugin config.
 * @param {string|null} [tunnelDomain] Per-run override ('none' = provider default).
 * @return {string|null} The domain to serve, or null for the provider default.
 */
export function resolveTunnelDomain(config, tunnelDomain = null) {
	if (tunnelDomain === 'none') {
		return null;
	}
	return tunnelDomain ?? config.tunnel?.domain ?? null;
}

/** Longest a single DNS label may be. */
const MAX_LABEL = 63;

/**
 * Expand a wildcard tunnel domain into this worktree's own hostname.
 *
 * A wildcard reservation (`*.krokedil.ngrok.io`) serves any single-label
 * subdomain without reserving it first, which is what lets parallel worktrees
 * tunnel at the same time: one reservation, a hostname per checkout. The label
 * is derived rather than random — same worktree, same URL on every run — so
 * callback registrations at a payment provider keep working, while a second
 * checkout of the same plugin gets a different host and no collision.
 *
 * The label is `<slug>-<first 8 hex of sha256(cwd)>` — the same digest that
 * keys the persistent site, so a site and its public URL share one identity.
 * DNS caps a label at 63 characters; an over-long slug is what gets truncated
 * to fit, never those 8 digest characters, since they carry the uniqueness. A
 * slug that sanitizes away to nothing leaves the digest alone as the label.
 *
 * @param {string|null} domain    Wildcard, bare hostname, or null.
 * @param {Object}      opts      Options.
 * @param {string}      opts.slug Plugin slug.
 * @param {string}      opts.cwd  Plugin root (the site's identity).
 * @return {string|null} A concrete hostname, or the input unchanged.
 */
export function expandTunnelDomain(domain, { slug, cwd }) {
	if (!domain?.startsWith('*.')) {
		return domain ?? null;
	}
	const base = domain.slice(2);
	const digest = computeSiteHash(cwd).slice(0, 8);
	const room = MAX_LABEL - digest.length - 1;
	const name = slug
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, room)
		.replace(/-+$/, '');
	// `-<digest>` would be an illegal label (leading hyphen). normalizeConfig
	// rejects a slug that could sanitize away, but this helper is exported and
	// must not depend on its caller for DNS validity.
	return name ? `${name}-${digest}.${base}` : `${digest}.${base}`;
}

/**
 * Start a proxy of the requested kind against the playground port, publish
 * its URL, and return a stoppable handle.
 *
 * @param {string}      root                Plugin root.
 * @param {Object}      config              Normalized plugin config.
 * @param {Object}      opts                Options.
 * @param {number}      opts.port           The playground's local port.
 * @param {string}      opts.kind           'tunnel' | 'https'.
 * @param {string|null} [opts.tunnelDomain] Per-run tunnel domain override
 *                                          (bare hostname, or 'none').
 * @param {Object}      [opts.providers]    Provider loaders; a seam for tests,
 *                                          which must not spawn real agents.
 * @return {Promise<{url: string, stop: Function}>} The running proxy.
 */
export async function startProxy(
	root,
	config,
	{ port, kind, tunnelDomain, providers = PROVIDERS }
) {
	if (!port) {
		throw new Error(
			'cannot start a proxy without a resolved port (pass --port or let the tool pick one).'
		);
	}

	let handle;
	let login = null;
	if (kind === 'https') {
		const { startLocalHttps } = await import('./https-local.mjs');
		handle = await startLocalHttps({ port, hosts: config.https.hosts });
	} else {
		const providerName = config.tunnel?.provider ?? 'ngrok';
		const load = providers[providerName];
		if (!load) {
			throw new Error(
				`unknown tunnel provider "${providerName}" — available: ${Object.keys(
					providers
				).join(', ')}.`
			);
		}
		const { startTunnel } = await load();
		const requested = resolveTunnelDomain(config, tunnelDomain);
		const domain = expandTunnelDomain(requested, {
			slug: config.slug,
			cwd: root,
		});

		// Arm the guard mu-plugin *before* the tunnel exists — the password
		// doesn't depend on the URL, and there must be no window in which the
		// site is world-reachable while wp-login still accepts the default
		// password. A failure here aborts the run instead of publishing.
		login = resolveTunnelPassword();
		writeTunnelPassword(root, login.password);

		try {
			handle = await startTunnel({ port, domain });
		} catch (err) {
			// startTunnel kills its own agent, so only our file is left.
			clearTunnelPassword(root);
			throw err;
		}

		if (!domain) {
			process.stderr.write(
				'⚠ playground: tunneling without a domain — the provider picks the URL, ' +
					'and with one account-wide default domain a second worktree collides with this run. ' +
					'Set config.tunnel.domain to a wildcard like "*.krokedil.ngrok.io" for a stable ' +
					'per-worktree URL.\n'
			);
		} else if (requested !== domain) {
			process.stderr.write(
				`▶ playground: tunnel host ${domain} (derived from ${requested} — stable for this worktree).\n`
			);
		}
	}

	// From here on the proxy is running, so anything that throws has to take it
	// down: an abandoned ngrok agent keeps serving (and holds the reserved
	// domain, so the next run can't start), and an abandoned local https
	// listener keeps the event loop alive so the CLI never exits.
	try {
		writeProxyUrl(root, handle.url);
		process.stderr.write(
			`\n▶ playground: public URL: ${handle.url}\n` +
				`  WordPress home/siteurl and webhook callbacks now use this URL.\n` +
				`  The local http://127.0.0.1:${port} stays reachable for tooling.\n` +
				(login
					? `  wp-admin over the public URL: admin / ${
							login.fromEnv
								? '<your $KROKEDIL_PG_TUNNEL_PASS>'
								: login.password
						}` +
						`${
							login.fromEnv
								? ''
								: ' (set KROKEDIL_PG_TUNNEL_PASS for a password you already know)'
						}\n` +
						`  The default admin/password is refused through the tunnel; requests from this machine are untouched.\n`
					: '') +
				'\n'
		);
	} catch (err) {
		// Stop the proxy first — that is the part that leaks — then drop the
		// contract files, secret first. Both steps are best-effort: a failure
		// while cleaning up must not replace the error that ended the run.
		await handle.stop().catch(() => {});
		try {
			clearTunnelPassword(root);
			clearProxyUrl(root);
		} catch {
			// Nothing useful to do here; the next launch clears both files.
		}
		throw err;
	}

	return {
		url: handle.url,
		stop: async () => {
			clearProxyUrl(root);
			clearTunnelPassword(root);
			await handle.stop();
		},
	};
}
