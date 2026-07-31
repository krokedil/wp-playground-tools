/**
 * Playground config for the committed sandbox plugin — lets the tooling run
 * against this repo itself (dogfooding), no consumer plugin repo needed.
 *
 * Run from the repo root:
 *   pnpm run sandbox:http | sandbox:https | sandbox:ngrok | sandbox:start
 */
export default {
	slug: 'krokedil-playground-sandbox',

	// The sandbox's row in the README port registry — far above consumer
	// plugins so concurrent dogfooding never collides with real plugin dev.
	basePort: 9880,

	// The company wildcard, same as the plugins use: --tunnel here derives
	// sandbox-<hash of this checkout>.krokedil.ngrok.io, so dogfooding a tunnel
	// never collides with a plugin's run or another worktree's.
	tunnel: { provider: 'ngrok', domain: '*.krokedil.ngrok.io' },
};
