/**
 * Public API of @krokedil/wp-playground-tools.
 *
 * The CLI (./cli) is the primary consumer surface; these exports exist for
 * tests and advanced tooling built on top of the same primitives.
 */
export {
	CONFIG_FILENAME,
	KNOWN_MODES,
	MODE_PORT_OFFSETS,
	loadConfig,
	normalizeConfig,
	normalizePerMode,
	wpVersionFor,
} from './config.mjs';
export { applyEnvFile, envSecret, globalEnvFile } from './env.mjs';
export {
	ensureCredentialStubs,
	runCredentials,
	scanEnvSecretNames,
} from './credentials.mjs';
export {
	buildLaunchArgs,
	buildModes,
	decideBlueprint,
	ensurePrereqs,
	isProvisioned,
	launch,
	nodeSatisfiesPin,
	resolvePlaygroundBin,
} from './prepare.mjs';
export {
	computeSiteHash,
	deriveSiteId,
	nextSiteToken,
	publishSiteId,
	readSiteRegistry,
	recordSiteId,
	resolveSiteId,
	siteIdFile,
	siteRegistryFile,
} from './site-id.mjs';
export { findFreePort, isPortFree, resolvePort } from './port.mjs';
export { composeAndStage, composeBlueprint } from './blueprint/compose.mjs';
export * as blueprintSteps from './blueprint/steps.mjs';
