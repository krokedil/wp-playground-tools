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
 *   credentials                 scan the config for envSecret() names and stub
 *                               missing ones in ~/.config/krokedil-playground/.env
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
import {
	buildModes,
	decideBlueprint,
	isMuPluginLinked,
	isProvisioned,
	launch,
	log,
} from './prepare.mjs';
import { clearProxyUrl, clearTunnelPassword } from './proxy/tunnel.mjs';

/** The mu-plugin that gates logins while a tunnel is running. */
const TUNNEL_GUARD = 'playground-tunnel-guard.php';

/**
 * Why a warm persistent site can't be tunnelled, if it can't.
 *
 * The guard mu-plugin is symlinked into the site by the blueprint's link step,
 * so a site provisioned before this package shipped the guard would boot
 * without it — and publish a site whose wp-login still accepts the default
 * password. Refuse instead, and say how to fix it. Blueprint modes (server
 * development|demo|e2e) apply a blueprint on every run, so they always have it.
 *
 * @param {string}   root     Plugin root.
 * @param {Object}   config   Normalized plugin config.
 * @param {string}   modeName Mode about to launch.
 * @param {string[]} args     Args forwarded to launch().
 * @return {string|null} An error message, or null when the run is safe.
 */
function tunnelGuardBlocker(root, config, modeName, args) {
	const mode = buildModes(config)[modeName];
	if (!mode?.persistent || !isProvisioned(root)) {
		return null;
	}
	if (decideBlueprint(mode.blueprint, args, true).provisioning) {
		return null; // Reprovisioning links it.
	}
	if (isMuPluginLinked(root, TUNNEL_GUARD)) {
		return null;
	}
	return (
		`this site was provisioned before the tunnel admin guard existed, so ` +
		`publishing it would expose wp-login with the default password. ` +
		`Re-run once with --fresh to install the guard (site data is reset), ` +
		`or drop --tunnel to keep working locally.`
	);
}

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
		case 'credentials': {
			const { runCredentials } = await import('./credentials.mjs');
			runCredentials(root);
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
				`usage: krokedil-playground <start|server <mode>|setup|compose|screenshots|credentials|init> [flags…]\n`
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

	// Stale files from a crashed proxied run would silently point the site at a
	// dead URL, or demand a password nobody has any more — always start clean.
	clearProxyUrl(root);
	clearTunnelPassword(root);

	if (wantsTunnel) {
		const blocker = tunnelGuardBlocker(root, config, modeName, forwarded);
		if (blocker) {
			process.stderr.write(`✖ playground: ${blocker}\n`);
			process.exitCode = 1;
			return;
		}
	}

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
		clearTunnelPassword(root);
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
// Compare realpaths: pnpm bin stubs pass a node_modules symlink as argv[1]
// while import.meta.url is already resolved, so a plain comparison silently
// no-ops every `pnpm exec krokedil-playground …` invocation.
if (process.argv[1]) {
	const { pathToFileURL } = await import('node:url');
	const { realpathSync } = await import('node:fs');
	let entry = process.argv[1];
	try {
		entry = realpathSync(entry);
	} catch {
		// argv[1] not resolvable — keep it verbatim.
	}
	if (import.meta.url === pathToFileURL(entry).href) {
		await main();
	}
}
