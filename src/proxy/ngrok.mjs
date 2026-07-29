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
 * Actionable hints for the ngrok error codes devs actually hit, keyed by code.
 *
 * The multi-instance failure modes (108, 334) matter most: parallel worktrees
 * on one plugin hit them first. Codes verified against ngrok.com/docs/errors.
 */
const NGROK_ERROR_HINTS = {
	ERR_NGROK_4018:
		'No ngrok authtoken configured. Get your personal token under the Krokedil ' +
		'pay-as-you-go account (dashboard.ngrok.com) and run `ngrok config add-authtoken <token>` ' +
		'or set NGROK_AUTHTOKEN.',
	ERR_NGROK_105:
		'The configured ngrok authtoken is malformed. Re-copy it from the Krokedil ' +
		'account dashboard and run `ngrok config add-authtoken <token>`.',
	ERR_NGROK_107:
		'The configured ngrok authtoken was rejected (revoked, reset, or you were ' +
		'removed from the Krokedil account). Get a fresh token from the company dashboard.',
	ERR_NGROK_108:
		'The account has hit its simultaneous-agent-session limit. Free personal accounts ' +
		'allow 1 agent — authenticate with your Krokedil pay-as-you-go token instead; or ' +
		'stop your other --tunnel runs / check dashboard.ngrok.com → Agents.',
	ERR_NGROK_313:
		'Custom domains need a paid plan — your authtoken belongs to a free personal ' +
		'account. Use your personal token under the Krokedil pay-as-you-go account instead.',
	ERR_NGROK_320:
		'The domain is not reserved under the account your authtoken belongs to. ' +
		'Authenticate with the Krokedil pay-as-you-go token and verify the domain at ' +
		'dashboard.ngrok.com/domains (see the tunnel domain registry in the shared README).',
	ERR_NGROK_334:
		'This tunnel domain is already online — another worktree (yours or a teammate’s) ' +
		'is serving it. Rerun with --tunnel-domain=none for an ephemeral URL, or use a ' +
		'second reserved domain via --tunnel-domain=<domain>.',
};

/**
 * Look up the actionable hint for an ngrok error code.
 *
 * @param {string|null} code An ERR_NGROK_* code, or null.
 * @return {string|null} The hint, or null for unknown/absent codes.
 */
export function hintForNgrokError(code) {
	return (code && NGROK_ERROR_HINTS[code]) || null;
}

/**
 * Extract an error from one line of ngrok output, if it is one.
 *
 * With --log=stdout ngrok reports failures as JSON log lines on stdout
 * (lvl "eror"/"crit", or an `err` field — which is the literal string "<nil>"
 * on some info lines); some versions also print a plain-text "ERROR: …" block
 * for fatal startup errors. Exported for tests.
 *
 * @param {string} line One line of ngrok output.
 * @return {{code: string|null, text: string}|null} The error (with any
 *   ERR_NGROK_* code found in it), or null for non-error lines.
 */
export function parseNgrokErrorLine(line) {
	let text = null;
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		event = null;
	}
	if (event && typeof event === 'object') {
		const err =
			typeof event.err === 'string' && event.err !== '<nil>'
				? event.err.trim()
				: '';
		if (event.lvl === 'eror' || event.lvl === 'crit' || err) {
			text = [event.msg, err].filter(Boolean).join(': ').trim();
		}
	} else if (/ERR_NGROK_\d+/.test(line) || /^ERROR:/.test(line.trim())) {
		text = line.trim();
	}
	if (!text) {
		return null;
	}
	const code = text.match(/(ERR_NGROK_\d+)/)?.[1] ?? null;
	return { code, text };
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
 * @param {Object}      opts        Options.
 * @param {number}      opts.port   Local port to expose.
 * @param {string|null} opts.domain Reserved domain to serve, or null for an
 *                                  ephemeral random URL.
 * @return {Promise<{url: string, stop: Function}>} The running tunnel.
 */
export async function startTunnel({ port, domain = null }) {
	const args = ['http', String(port), '--log=stdout', '--log-format=json'];
	if (domain) {
		args.push(`--url=${domain}`);
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
		/** Last few error lines ngrok logged (stdout JSON under --log=stdout). */
		const errorLines = [];

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
				const error = parseNgrokErrorLine(line);
				if (error) {
					errorLines.push(error);
					if (errorLines.length > 5) {
						errorLines.shift();
					}
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
			// Exited before producing a URL: auth/domain/session errors land
			// here. Under --log=stdout ngrok reports them as JSON on stdout,
			// so the collected errorLines are the real story; stderr is a
			// fallback for anything that bypassed the logger.
			const details =
				[...new Set(errorLines.map((e) => e.text))].join('\n') ||
				stderrTail.trim();
			let hint = hintForNgrokError(
				errorLines.find((e) => e.code)?.code ?? null
			);
			if (!hint && !process.env.NGROK_AUTHTOKEN) {
				hint =
					'set NGROK_AUTHTOKEN or run `ngrok config add-authtoken <token>`.';
			}
			pollApi(Date.now() + 1).then(() =>
				settle(
					null,
					`ngrok exited (code ${code}) before the tunnel came up.` +
						(details ? `\n${details}` : '') +
						(hint ? `\nHint: ${hint}` : '')
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
