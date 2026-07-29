#!/usr/bin/env node
/**
 * krokedil-playground — CLI entry.
 *
 * Subcommands:
 *   start [flags…]              boot the persistent dev site (worktree-isolated)
 *   server <mode> [flags…]      ephemeral server: development | demo | e2e
 *   setup                       install prerequisites only
 *   compose [mode…]             write the generated blueprint(s) for inspection
 *   screenshots [args…]         run the PR screenshot capture
 *   init [--update]             scaffold (or refresh) a plugin's playground setup
 *
 * Cross-cutting flags for start/server:
 *   --fresh     reprovision the persistent site (start only)
 *   --tunnel    expose the site over https via ngrok (public URL, webhooks)
 *   --tunnel-domain=<host|none>  per-run tunnel domain override (implies
 *               --tunnel; 'none' forces an ephemeral URL — parallel worktrees)
 *   --https     serve https locally via mkcert + reverse proxy (no tunnel)
 * Everything else is forwarded to the Playground CLI (--xdebug, --php=…, …).
 */
import process from 'node:process';

import { composeAndStage } from './blueprint/compose.mjs';
import { loadConfig, validateTunnelDomain } from './config.mjs';
import { launch, log } from './prepare.mjs';
import { clearProxyUrl } from './proxy/tunnel.mjs';

/**
 * Run the CLI.
 *
 * @param {string[]} argv Arguments after the bin name.
 * @return {Promise<void>} Resolves when the command completes (long-running
 *   commands resolve on child exit and set process.exitCode).
 */
export async function main(argv = process.argv.slice(2)) {
	const [command, ...rest] = argv;
	const root = process.cwd();

	switch (command) {
		case 'init': {
			const { scaffold } = await import('./init/scaffold.mjs');
			await scaffold(root, rest);
			return;
		}
		case 'screenshots': {
			const config = await loadConfig(root);
			const { capture } = await import('./screenshots/capture.mjs');
			await capture(root, config, rest);
			return;
		}
		case 'compose': {
			const config = await loadConfig(root);
			const modes = rest.length
				? rest
				: config.modes.filter((m) => m !== 'start');
			for (const mode of modes) {
				const { blueprintPath } = await composeAndStage(
					root,
					config,
					mode
				);
				log(`composed ${blueprintPath}`);
			}
			return;
		}
		case 'setup':
		case 'start': {
			await runMode(root, command, rest);
			return;
		}
		case 'server': {
			const [mode, ...args] = rest;
			await runMode(root, mode, args);
			return;
		}
		default:
			process.stderr.write(
				`usage: krokedil-playground <start|server <mode>|setup|compose|screenshots|init> [flags…]\n`
			);
			process.exitCode = command ? 1 : 0;
	}
}

/**
 * Launch a playground mode, optionally behind a tunnel or local https proxy,
 * and wire cleanup for both.
 *
 * @param {string}   root     Plugin root.
 * @param {string}   modeName Mode to launch.
 * @param {string[]} args     User args (ours + forwarded).
 */
async function runMode(root, modeName, args) {
	// --tunnel-domain=<host|none> overrides config.tunnel.domain for this run
	// (parallel worktrees share the committed config) and implies --tunnel.
	const domainArg = args.find((a) => a.startsWith('--tunnel-domain='));
	const tunnelDomain = domainArg
		? domainArg.slice('--tunnel-domain='.length)
		: null;
	const wantsTunnel = args.includes('--tunnel') || tunnelDomain !== null;
	const wantsHttps = args.includes('--https');
	if (wantsTunnel && wantsHttps) {
		process.stderr.write(
			'✖ playground: --tunnel and --https are mutually exclusive (one public URL per site).\n'
		);
		process.exitCode = 1;
		return;
	}
	if (tunnelDomain !== null && tunnelDomain !== 'none') {
		try {
			validateTunnelDomain(tunnelDomain, '--tunnel-domain');
		} catch (err) {
			process.stderr.write(`✖ playground: ${err.message}\n`);
			process.exitCode = 1;
			return;
		}
	}
	const forwarded = args.filter(
		(a) =>
			a !== '--tunnel' &&
			a !== '--https' &&
			!a.startsWith('--tunnel-domain=')
	);

	const config = await loadConfig(root);

	// A stale proxy-url.txt from a crashed proxied run would silently point
	// the site at a dead URL — always start clean.
	clearProxyUrl(root);

	const handle = await launch(root, config, modeName, forwarded);
	if (!handle) {
		return; // setup-only
	}

	let proxy = null;
	const stopProxy = async () => {
		if (proxy) {
			const p = proxy;
			proxy = null;
			await p.stop().catch(() => {});
		}
		clearProxyUrl(root);
	};

	if (wantsTunnel || wantsHttps) {
		try {
			const { startProxy } = await import('./proxy/tunnel.mjs');
			proxy = await startProxy(root, config, {
				port: handle.port,
				kind: wantsTunnel ? 'tunnel' : 'https',
				tunnelDomain,
			});
		} catch (err) {
			process.stderr.write(`✖ playground: ${err.message}\n`);
			handle.child.kill('SIGTERM');
			await handle.done;
			process.exitCode = 1;
			return;
		}
	}

	// Mirror Ctrl+C into the child; cleanup runs when the child exits.
	for (const signal of ['SIGINT', 'SIGTERM']) {
		process.on(signal, () => handle.child.kill(signal));
	}

	const exitCode = await handle.done;
	await stopProxy();
	process.exitCode = exitCode;
}

// Only run when executed directly (bin), not when imported (shim calls main()).
if (
	process.argv[1] &&
	import.meta.url ===
		(await import('node:url')).pathToFileURL(process.argv[1]).href
) {
	await main();
}
