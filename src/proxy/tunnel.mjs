/**
 * Proxy orchestration for --tunnel (public https via a tunnel provider) and
 * --https (local mkcert reverse proxy).
 *
 * Both mechanisms share one contract with the site: the public URL is written
 * to <plugin>/.playground/proxy-url.txt, which the always-staged
 * playground-proxy-url.php mu-plugin reads at runtime (no DB writes, warm-boot
 * safe, self-reverting when the file is deleted).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

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
	fs.mkdirSync(path.dirname(proxyUrlFile(root)), { recursive: true });
	fs.writeFileSync(proxyUrlFile(root), url + '\n');
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
 * @return {Promise<{url: string, stop: Function}>} The running proxy.
 */
export async function startProxy(root, config, { port, kind, tunnelDomain }) {
	if (!port) {
		throw new Error(
			'cannot start a proxy without a resolved port (pass --port or let the tool pick one).'
		);
	}

	let handle;
	if (kind === 'https') {
		const { startLocalHttps } = await import('./https-local.mjs');
		handle = await startLocalHttps({ port, hosts: config.https.hosts });
	} else {
		const providerName = config.tunnel?.provider ?? 'ngrok';
		const load = PROVIDERS[providerName];
		if (!load) {
			throw new Error(
				`unknown tunnel provider "${providerName}" — available: ${Object.keys(
					PROVIDERS
				).join(', ')}.`
			);
		}
		const { startTunnel } = await load();
		const domain = resolveTunnelDomain(config, tunnelDomain);
		handle = await startTunnel({ port, domain });

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

	writeProxyUrl(root, handle.url);
	process.stderr.write(
		`\n▶ playground: public URL: ${handle.url}\n` +
			`  WordPress home/siteurl and webhook callbacks now use this URL.\n` +
			`  The local http://127.0.0.1:${port} stays reachable for tooling.\n\n`
	);

	return {
		url: handle.url,
		stop: async () => {
			clearProxyUrl(root);
			await handle.stop();
		},
	};
}
