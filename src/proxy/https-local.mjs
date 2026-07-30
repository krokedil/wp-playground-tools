/**
 * Local https reverse proxy for secure-context-only needs (payment iframes,
 * SDKs requiring https) — no tunnel account, nothing leaves the machine.
 *
 * Certificates come from mkcert (locally-trusted CA). They are cached under
 * ~/.config/krokedil-playground/certs/ and regenerated when the requested
 * hosts change. The proxy forwards plain HTTP to the playground port with
 * X-Forwarded-Proto: https, which the playground-proxy-url.php mu-plugin
 * trusts from loopback.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

/** Offset from the playground port for the https listener. */
const HTTPS_PORT_OFFSET = 400;

/**
 * Certificate cache directory.
 *
 * @return {string} Absolute path.
 */
function certDir() {
	return path.join(os.homedir(), '.config', 'krokedil-playground', 'certs');
}

/**
 * Ensure an mkcert certificate for the given hosts exists, generating it when
 * missing or when the host list changed.
 *
 * @param {string[]} hosts SANs (e.g. ['localhost']).
 * @return {{ cert: string, key: string }} PEM file paths.
 */
function ensureCert(hosts) {
	const probe = spawnSync('mkcert', ['-CAROOT'], { encoding: 'utf8' });
	if (probe.error || probe.status !== 0) {
		throw new Error(
			'mkcert not found. Install it (macOS: `brew install mkcert && mkcert -install`; ' +
				'see https://github.com/FiloSottile/mkcert) — or use --tunnel, which needs no local CA.'
		);
	}

	const dir = certDir();
	fs.mkdirSync(dir, { recursive: true });
	const sans = [...new Set([...hosts, '127.0.0.1', '::1'])];
	const cert = path.join(dir, 'cert.pem');
	const key = path.join(dir, 'key.pem');
	const manifest = path.join(dir, 'hosts.json');

	const current = fs.existsSync(manifest)
		? fs.readFileSync(manifest, 'utf8')
		: '';
	if (
		!fs.existsSync(cert) ||
		!fs.existsSync(key) ||
		current !== JSON.stringify(sans)
	) {
		const res = spawnSync(
			'mkcert',
			['-cert-file', cert, '-key-file', key, ...sans],
			{ stdio: 'inherit' }
		);
		if (res.error || res.status !== 0) {
			throw new Error(
				'mkcert failed to issue a certificate. Run `mkcert -install` once and retry.'
			);
		}
		fs.writeFileSync(manifest, JSON.stringify(sans));
	}
	return { cert, key };
}

/**
 * Start the https reverse proxy in front of the playground.
 *
 * @param {Object}   opts             Options.
 * @param {number}   opts.port        The playground's local http port.
 * @param {string[]} opts.hosts       Hostnames the certificate must cover.
 * @param {number}   [opts.httpsPort] Listener port (default port + 400).
 * @return {Promise<{url: string, stop: Function}>} The running proxy.
 */
export async function startLocalHttps({ port, hosts, httpsPort }) {
	const listenPort = httpsPort ?? port + HTTPS_PORT_OFFSET;
	const { cert, key } = ensureCert(hosts);

	const server = https.createServer({
		cert: fs.readFileSync(cert),
		key: fs.readFileSync(key),
	});

	server.on('request', (req, res) => {
		const upstream = http.request(
			{
				host: '127.0.0.1',
				port,
				method: req.method,
				path: req.url,
				headers: {
					...req.headers,
					'x-forwarded-proto': 'https',
					'x-forwarded-host': req.headers.host ?? '',
				},
			},
			(upstreamRes) => {
				res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
				upstreamRes.pipe(res);
			}
		);
		upstream.on('error', () => {
			res.writeHead(502);
			res.end('playground upstream unavailable');
		});
		req.pipe(upstream);
	});

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(listenPort, resolve);
	});

	const host = hosts[0] ?? 'localhost';
	return {
		url: `https://${host}:${listenPort}`,
		stop: () => new Promise((resolve) => server.close(() => resolve())),
	};
}
