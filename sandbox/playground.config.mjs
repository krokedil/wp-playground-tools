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

	// No domain on purpose: developers with a reserved ngrok domain add it
	// locally; the loud free-tier warning on --tunnel is expected.
	tunnel: { provider: 'ngrok' },
};
