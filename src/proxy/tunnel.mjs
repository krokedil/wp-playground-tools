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

/** Registered tunnel providers. cloudflared etc. are later drop-ins. */
const PROVIDERS = {
	ngrok: () => import('./ngrok.mjs'),
};

/**
 * Write a file the Playground runtime has to read back.
 *
 * The runtime reads the mount as a different uid than the host process, so an
 * owner-only file is unreadable there — and the mu-plugins fail quietly when
 * that happens (an unreadable tunnel-password.txt used to leave the default
 * admin password working on a public URL; an unreadable proxy-url.txt leaves
 * the site serving localhost URLs). Hence an explicit chmod: the mode passed
 * to writeFileSync goes through open(2) and is masked by the caller's umask,
 * so `umask 077` would recreate exactly that bug, while chmod is absolute and
 * also fixes a file that already exists.
 *
 * @param {string} file     Absolute path to write.
 * @param {string} contents File contents.
 */
function writeRuntimeReadable(file, contents) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, contents);
	try {
		fs.chmodSync(file, 0o644);
	} catch (err) {
		throw new Error(
			`could not make ${file} readable by the Playground runtime: ${err.message}`
		);
	}
}

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
 * worktrees share the same committed config, so a second instance needs its
 * own reserved domain — or 'none' for an ephemeral URL. Exported for tests.
 *
 * @param {Object}      config         Normalized plugin config.
 * @param {string|null} [tunnelDomain] Per-run override ('none' forces ephemeral).
 * @return {string|null} The domain to serve, or null for an ephemeral URL.
 */
export function resolveTunnelDomain(config, tunnelDomain = null) {
	if (tunnelDomain === 'none') {
		return null;
	}
	return tunnelDomain ?? config.tunnel?.domain ?? null;
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
		const domain = resolveTunnelDomain(config, tunnelDomain);

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
				tunnelDomain === 'none'
					? '⚠ playground: ephemeral tunnel (--tunnel-domain=none) — webhook ' +
							'registrations at your payment provider will target this run’s random URL.\n'
					: '⚠ playground: tunneling without a reserved domain — this URL changes on every run, ' +
							'so webhook registrations at your payment provider will go stale. ' +
							'Set config.tunnel.domain to a reserved ngrok domain for stable callbacks.\n'
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
