/**
 * Cross-platform port resolver for the playground launch commands.
 *
 * Resolves a port, appends "--port=<resolved>" to the command (unless the
 * command already carries --port), and runs it. Resolution precedence:
 *
 *   1. An explicit --port in the forwarded command -> used verbatim (manual override).
 *   2. The PORT environment variable               -> used verbatim, no probing.
 *      Set by Claude's preview "autoPort" (which already picked a free port and
 *      will navigate to exactly it) or exported manually to pin a port (CI/e2e).
 *   3. Otherwise                                    -> probe for a free port,
 *      starting at <defaultPort> and incrementing. This is what lets a plain
 *      terminal "pnpm run playground:*" fall back to a free port instead of dying
 *      with EADDRINUSE when another worktree already holds the default port.
 *
 * Why Node instead of "--port=${PORT:-8880}" inline in an npm script: that is
 * POSIX shell parameter-expansion, so it only works in sh/bash and breaks on
 * Windows (cmd.exe passes the literal "${PORT:-8880}"). Reading process.env in
 * Node behaves identically on Windows, macOS and Linux.
 *
 * Uses cross-spawn (argv array, no shell) rather than spawn(..., { shell: true }):
 * shell:true does not escape array args (injection surface) and is deprecated in
 * Node 22 (DEP0190), and spawning "npx.cmd" with shell:false throws EINVAL on
 * Node >=20.12 (CVE-2024-27980). cross-spawn resolves .cmd shims on Windows and
 * escapes args, so it is the portable, safe option.
 */
import net from 'node:net';
import os from 'node:os';

const PORT_PROBE_ATTEMPTS = 20;

/**
 * Resolve whether `port` can be bound right now.
 *
 * Binds with no host so it mirrors the playground CLI's default dual-stack "::"
 * bind (the collision we detect surfaces as ":::8880"); probing a different
 * interface than the CLI uses would give false negatives.
 *
 * @param {number} port Port to test.
 * @return {Promise<boolean>} Whether the port is free.
 */
export function isPortFree(port) {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once('error', () => resolve(false));
		server.once('listening', () => {
			server.close(() => resolve(true));
		});
		server.listen(port);
	});
}

/**
 * Find the first free port at or above `start`.
 *
 * @param {number} start       Port to start probing from.
 * @param {number} maxAttempts How many consecutive ports to try.
 * @return {Promise<number>} The first free port found.
 * @throws {Error} If no free port is found within the range.
 */
export async function findFreePort(start, maxAttempts = PORT_PROBE_ATTEMPTS) {
	for (let port = start; port < start + maxAttempts; port++) {
		if (await isPortFree(port)) {
			return port;
		}
	}
	throw new Error(
		`playground-port: no free port in ${start}-${start + maxAttempts - 1}`
	);
}

/**
 * Resolve the port to use, following the precedence documented in the header.
 *
 * @param {number}   defaultPort The fallback port to probe from.
 * @param {string[]} args        The forwarded command args (post-command).
 * @param {Object}   env         Environment to read PORT from (default process.env).
 * @return {Promise<number|null>} The resolved port, or null when the command
 *   already carries an explicit --port (so the caller injects nothing).
 * @throws {Error} On an invalid PORT env value or exhausted probe range.
 */
export async function resolvePort(defaultPort, args, env = process.env) {
	// 1. Respect an explicit --port in the forwarded command (manual override).
	if (args.some((arg) => arg === '--port' || arg.startsWith('--port='))) {
		return null;
	}

	// 2. An explicit PORT env (preview autoPort, or a manual pin) wins verbatim.
	if (env.PORT) {
		if (!/^\d+$/.test(env.PORT)) {
			throw new Error(`playground-port: invalid PORT "${env.PORT}"`);
		}
		return Number(env.PORT);
	}

	// 3. Probe for a free port starting at the default.
	const start = Number(defaultPort);
	if (!Number.isInteger(start) || start <= 0) {
		throw new Error(`playground-port: invalid port "${defaultPort}"`);
	}
	const port = await findFreePort(start);
	if (port !== start) {
		process.stderr.write(
			`playground-port: ${start} in use -> using ${port}\n`
		);
	}
	return port;
}

/**
 * Resolve a port, inject --port=<n> into `args`, and spawn `command`.
 *
 * @param {number}   defaultPort Port to probe from when nothing pins one.
 * @param {string}   command     Executable to spawn.
 * @param {string[]} args        Arguments for the command.
 * @param {Object}   [options]   Extra child_process options (env, cwd, ...).
 * @return {Promise<{port: number|null, exitCode: number}>} The resolved port
 *   (null when the caller carried --port) and the child's mapped exit code —
 *   signal terminations map to the conventional 128+signum, so interrupted
 *   runs are not reported as success.
 */
export async function runWithFreePort(
	defaultPort,
	command,
	args,
	options = {}
) {
	const port = await resolvePort(
		defaultPort,
		args,
		options.env ?? process.env
	);
	const finalArgs = port !== null ? [...args, `--port=${port}`] : args;

	const { default: spawn } = await import('cross-spawn');
	const child = spawn(command, finalArgs, { stdio: 'inherit', ...options });

	const exitCode = await new Promise((resolve, reject) => {
		child.on('exit', (code, signal) => {
			resolve(
				signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 0)
			);
		});
		child.on('error', reject);
	});

	return { port, exitCode };
}
