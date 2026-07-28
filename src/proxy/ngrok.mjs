/**
 * ngrok tunnel provider.
 *
 * Spawns the developer's ngrok binary (no npm ngrok package: the binary is
 * what Krokedil devs already have and authenticate) and resolves the public
 * URL from ngrok's JSON log stream, falling back to the local ngrok API.
 * Log parsing is primary because the API port (4040) shifts to 4041+ when
 * multiple agents run — likely with 30 plugins.
 *
 * Auth: ngrok reads NGROK_AUTHTOKEN natively, or the token configured via
 * `ngrok config add-authtoken`. We never store or handle the token ourselves.
 */
import process from 'node:process';

/** How long to wait for a tunnel URL before giving up. */
const START_TIMEOUT_MS = 20000;

/**
 * Extract the public URL from one ngrok JSON log line, if present.
 *
 * Matches the "started tunnel" event ({"msg":"started tunnel","url":"https://…"}).
 * Exported for tests.
 *
 * @param {string} line One line of `--log=stdout --log-format=json` output.
 * @return {string|null} The https public URL, or null.
 */
export function parseNgrokLogLine(line) {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		return null;
	}
	if (
		event &&
		event.msg === 'started tunnel' &&
		typeof event.url === 'string' &&
		event.url.startsWith('https://')
	) {
		return event.url;
	}
	return null;
}

/**
 * Extract the first https tunnel URL from an ngrok API /api/tunnels payload.
 * Exported for tests.
 *
 * @param {Object} payload Parsed JSON from http://127.0.0.1:4040/api/tunnels.
 * @return {string|null} The https public URL, or null.
 */
export function parseTunnelsApi(payload) {
	const tunnels = payload?.tunnels ?? [];
	const https = tunnels.find((t) =>
		String(t.public_url ?? '').startsWith('https://')
	);
	return https?.public_url ?? null;
}

/**
 * Poll the local ngrok API for a tunnel URL (fallback when log parsing missed
 * the event, e.g. an unexpected log schema).
 *
 * @param {number} deadline Epoch ms to stop trying.
 * @return {Promise<string|null>} The URL, or null when the deadline passes.
 */
async function pollApi(deadline) {
	// The web-interface port shifts when several agents run; scan a few.
	const ports = [4040, 4041, 4042, 4043];
	while (Date.now() < deadline) {
		for (const apiPort of ports) {
			try {
				const res = await fetch(
					`http://127.0.0.1:${apiPort}/api/tunnels`,
					{ signal: AbortSignal.timeout(1000) }
				);
				const url = parseTunnelsApi(await res.json());
				if (url) {
					return url;
				}
			} catch {
				// Not this port / not up yet.
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return null;
}

/**
 * Start an ngrok tunnel to the local playground port.
 *
 * @param {Object} opts        Options.
 * @param {number} opts.port   Local port to expose.
 * @param {Object} opts.config Normalized plugin config (tunnel.domain).
 * @return {Promise<{url: string, stop: Function}>} The running tunnel.
 */
export async function startTunnel({ port, config }) {
	const args = ['http', String(port), '--log=stdout', '--log-format=json'];
	if (config.tunnel?.domain) {
		args.push(`--url=${config.tunnel.domain}`);
	}

	const { default: spawn } = await import('cross-spawn');
	const child = spawn('ngrok', args, {
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	const stop = () =>
		new Promise((resolve) => {
			if (child.exitCode !== null) {
				return resolve();
			}
			child.once('exit', resolve);
			child.kill('SIGTERM');
		});

	const url = await new Promise((resolve, reject) => {
		const deadline = Date.now() + START_TIMEOUT_MS;
		let settled = false;
		let stderrTail = '';
		let buffer = '';

		/**
		 * Settle the promise exactly once.
		 *
		 * @param {string|null} value     Resolved URL, or null to reject.
		 * @param {string}      [message] Rejection message.
		 */
		const settle = (value, message) => {
			if (settled) {
				return;
			}
			settled = true;
			if (value) {
				resolve(value);
			} else {
				reject(new Error(message));
			}
		};

		child.stdout.on('data', (chunk) => {
			buffer += String(chunk);
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				const found = parseNgrokLogLine(line);
				if (found) {
					settle(found);
				}
			}
		});
		child.stderr.on('data', (chunk) => {
			stderrTail = (stderrTail + String(chunk)).slice(-2000);
		});

		child.on('error', (err) => {
			settle(
				null,
				err.code === 'ENOENT'
					? 'ngrok not found on PATH. Install it (https://ngrok.com/download) and ' +
							'authenticate with NGROK_AUTHTOKEN or `ngrok config add-authtoken <token>`.'
					: `failed to start ngrok: ${err.message}`
			);
		});
		child.on('exit', (code) => {
			// Exited before producing a URL: auth/domain errors land here.
			pollApi(Date.now() + 1).then(() =>
				settle(
					null,
					`ngrok exited (code ${code}) before the tunnel came up.` +
						(stderrTail ? `\n${stderrTail.trim()}` : '') +
						(process.env.NGROK_AUTHTOKEN
							? ''
							: '\nHint: set NGROK_AUTHTOKEN or run `ngrok config add-authtoken <token>`.')
				)
			);
		});

		// Fallback: if the log event never matched, ask the local API.
		setTimeout(async () => {
			if (settled) {
				return;
			}
			const found = await pollApi(deadline);
			settle(
				found,
				'timed out waiting for the ngrok tunnel URL (log stream and local API both silent).'
			);
		}, 4000);
	}).catch(async (err) => {
		await stop();
		throw err;
	});

	return { url, stop };
}
