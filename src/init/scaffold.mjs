/**
 * `krokedil-playground init [--update]` — scaffold (or refresh) a plugin's
 * playground setup. The migration vehicle for rolling the tooling out across
 * plugins.
 *
 * Writes/merges, idempotently:
 *   tools/playground.mjs         the bootstrap shim (generated — refreshed by --update)
 *   playground.config.mjs        starter config (never touched once it exists)
 *   .claude/launch.json          preview entries per mode (generated)
 *   CLAUDE.md                    a marker-delimited playground section (generated;
 *                                everything outside the markers is preserved)
 *   package.json                 playground scripts, dev dep, engines, packageManager
 *   .npmrc / .nvmrc              the Node pin (generated)
 *   .gitignore / .kernlignore    .playground/ + pr-screenshots/ exclusions
 *
 * --update re-stamps the generated files (shim, launch.json, node pins,
 * playground scripts) without touching playground.config.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { CONFIG_FILENAME, MODE_PORT_OFFSETS, loadConfig } from '../config.mjs';

const TEMPLATES = fileURLToPath(new URL('./templates', import.meta.url));

/** package.json script name + command per mode (drives launch.json too). */
const MODE_SCRIPTS = {
	start: ['playground:start', 'node tools/playground.mjs start'],
	development: [
		'playground:server-development',
		'node tools/playground.mjs server development',
	],
	demo: ['playground:server-demo', 'node tools/playground.mjs server demo'],
	e2e: ['playground:server-e2e', 'node tools/playground.mjs server e2e'],
};

/** The Node version pin stamped into consumers (kept next to nodeSatisfiesPin). */
export const NODE_PIN = '20.19.0';

/** The dependency spec written into consumers' package.json. */
export const PACKAGE_SPEC = 'github:krokedil/wp-playground-tools#semver:^1';

/** Markers delimiting the generated section in a consumer's CLAUDE.md. */
export const CLAUDE_MD_BEGIN = '<!-- BEGIN @krokedil/wp-playground-tools -->';
export const CLAUDE_MD_END = '<!-- END @krokedil/wp-playground-tools -->';

/**
 * Emit a scaffold progress line.
 *
 * @param {string} msg Message.
 */
function log(msg) {
	process.stderr.write(`▶ init: ${msg}\n`);
}

/**
 * Infer the plugin slug: the root PHP file carrying a "Plugin Name:" header
 * (WP convention: main file is named after the plugin), else the directory
 * basename.
 *
 * @param {string} root Plugin root.
 * @return {string} The inferred slug.
 */
export function inferSlug(root) {
	for (const entry of fs.readdirSync(root)) {
		if (!entry.endsWith('.php')) {
			continue;
		}
		try {
			const head = fs
				.readFileSync(path.join(root, entry), 'utf8')
				.slice(0, 4096);
			if (/^\s*\*?\s*Plugin Name\s*:/im.test(head)) {
				return entry.replace(/\.php$/, '');
			}
		} catch {
			// Unreadable — skip.
		}
	}
	return path.basename(root);
}

/**
 * Append lines to a file unless already present (creates the file if needed).
 *
 * @param {string}   file  Absolute path.
 * @param {string[]} lines Lines to ensure.
 * @return {boolean} Whether anything was added.
 */
function ensureLines(file, lines) {
	const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
	const existing = new Set(current.split('\n').map((l) => l.trim()));
	const missing = lines.filter((l) => !existing.has(l));
	if (!missing.length) {
		return false;
	}
	const glue = current && !current.endsWith('\n') ? '\n' : '';
	fs.writeFileSync(file, current + glue + missing.join('\n') + '\n');
	return true;
}

/**
 * Detect the indentation used in a JSON file so a rewrite doesn't reformat
 * every line: the whitespace prefix of the first indented line, tab when
 * there is none (new files).
 *
 * @param {string|null} content File content, or null when the file is new.
 * @return {string} The indent string.
 */
function detectIndent(content) {
	return content?.match(/^([ \t]+)\S/m)?.[1] ?? '\t';
}

/**
 * Run the scaffold.
 *
 * @param {string}   root Plugin root (cwd).
 * @param {string[]} args CLI args after "init".
 * @return {Promise<void>} Resolves when done.
 */
export async function scaffold(root, args) {
	// Dogfooding guard: init inside this package itself would inject a
	// self-referential git dependency and rewrite this repo's package.json,
	// .npmrc and .nvmrc. The committed sandbox/ plugin is the way to run the
	// tool against this repo.
	const ownPkgPath = path.join(root, 'package.json');
	if (fs.existsSync(ownPkgPath)) {
		let name = null;
		try {
			name = JSON.parse(fs.readFileSync(ownPkgPath, 'utf8')).name;
		} catch {
			// Unreadable/invalid package.json — not this package; proceed.
		}
		if (name === '@krokedil/wp-playground-tools') {
			process.stderr.write(
				'✖ init: refusing to scaffold @krokedil/wp-playground-tools itself — dogfood via the committed sandbox instead (pnpm run sandbox:http).\n'
			);
			process.exitCode = 1;
			return;
		}
	}

	const update = args.includes('--update');
	const slug = inferSlug(root);

	// --- the shim (generated) ---
	const shimDir = path.join(root, 'tools');
	const shimPath = path.join(shimDir, 'playground.mjs');
	if (!fs.existsSync(shimPath) || update) {
		fs.mkdirSync(shimDir, { recursive: true });
		fs.copyFileSync(path.join(TEMPLATES, 'playground-shim.mjs'), shimPath);
		log('wrote tools/playground.mjs (bootstrap shim)');
	}

	// --- starter config (owned by the plugin — never overwritten) ---
	const configPath = path.join(root, CONFIG_FILENAME);
	if (!fs.existsSync(configPath)) {
		const template = fs.readFileSync(
			path.join(TEMPLATES, 'playground.config.template.mjs'),
			'utf8'
		);
		fs.writeFileSync(configPath, template.replace('__SLUG__', slug));
		log(`wrote ${CONFIG_FILENAME} (slug: ${slug} — review it!)`);
	}

	// --- resolve the config (drives the scripts + launch entries below) ---
	let basePort = 8880;
	let modes = ['start', 'development', 'demo'];
	try {
		({ basePort, modes } = await loadConfig(root));
	} catch {
		// Starter config not filled in yet — defaults.
	}

	// --- node pins (generated) ---
	const nvmrc = path.join(root, '.nvmrc');
	if (!fs.existsSync(nvmrc) || update) {
		fs.writeFileSync(nvmrc, NODE_PIN + '\n');
		log('wrote .nvmrc');
	}
	const npmrc = path.join(root, '.npmrc');
	const npmrcBody = fs.existsSync(npmrc)
		? fs.readFileSync(npmrc, 'utf8')
		: '';
	if (/^use-node-version=/m.test(npmrcBody)) {
		if (update) {
			fs.writeFileSync(
				npmrc,
				npmrcBody.replace(
					/^use-node-version=.*$/m,
					`use-node-version=${NODE_PIN}`
				)
			);
			log('updated .npmrc node pin');
		}
	} else {
		ensureLines(npmrc, [
			"# pnpm downloads/uses this Node for every run (the Playground CLI's --reset path breaks on Node 22+).",
			`use-node-version=${NODE_PIN}`,
		]);
		log('pinned Node in .npmrc');
	}

	// --- package.json (merged) ---
	const pkgPath = path.join(root, 'package.json');
	const pkgRaw = fs.existsSync(pkgPath)
		? fs.readFileSync(pkgPath, 'utf8')
		: null;
	const pkg = pkgRaw
		? JSON.parse(pkgRaw)
		: {
				name: `${slug}-dev`,
				private: true,
				type: 'module',
				version: '0.0.0',
			};
	pkg.scripts = pkg.scripts ?? {};
	const scripts = {
		...Object.fromEntries(modes.map((mode) => MODE_SCRIPTS[mode])),
		'playground:setup': 'node tools/playground.mjs setup',
		screenshots: 'node tools/playground.mjs screenshots',
	};
	let scriptsChanged = false;
	for (const [name, cmd] of Object.entries(scripts)) {
		if (pkg.scripts[name] !== cmd && (update || !pkg.scripts[name])) {
			pkg.scripts[name] = cmd;
			scriptsChanged = true;
		}
	}
	// --update also prunes generated scripts for modes dropped from the
	// config — but only untouched ones, so customized scripts survive.
	if (update) {
		for (const [mode, [name, cmd]] of Object.entries(MODE_SCRIPTS)) {
			if (!modes.includes(mode) && pkg.scripts[name] === cmd) {
				delete pkg.scripts[name];
				scriptsChanged = true;
			}
		}
	}
	pkg.devDependencies = pkg.devDependencies ?? {};
	if (!pkg.devDependencies['@krokedil/wp-playground-tools']) {
		pkg.devDependencies['@krokedil/wp-playground-tools'] = PACKAGE_SPEC;
		scriptsChanged = true;
	}
	pkg.engines = {
		...(pkg.engines ?? {}),
		node: `>=${NODE_PIN} <21`,
		pnpm: pkg.engines?.pnpm ?? '>=9.13.0',
	};
	pkg.packageManager = pkg.packageManager ?? 'pnpm@9.15.9';
	fs.writeFileSync(
		pkgPath,
		JSON.stringify(pkg, null, detectIndent(pkgRaw)) + '\n'
	);
	if (scriptsChanged) {
		log(
			'merged package.json (scripts, dev dependency, engines) — run pnpm install'
		);
	}

	// --- .claude/launch.json (playground entries replaced, others preserved) ---
	const launchPath = path.join(root, '.claude', 'launch.json');
	const launchRaw = fs.existsSync(launchPath)
		? fs.readFileSync(launchPath, 'utf8')
		: null;
	const launch = launchRaw
		? JSON.parse(launchRaw)
		: { version: '0.0.1', configurations: [] };
	launch.configurations = (launch.configurations ?? []).filter(
		(c) => !/^playground-/.test(c.name ?? '')
	);
	for (const mode of modes) {
		launch.configurations.push({
			name: `playground-${slug}-${mode}`,
			runtimeExecutable: 'pnpm',
			runtimeArgs: ['run', MODE_SCRIPTS[mode][0]],
			port: basePort + MODE_PORT_OFFSETS[mode],
			autoPort: true,
		});
	}
	fs.mkdirSync(path.dirname(launchPath), { recursive: true });
	fs.writeFileSync(
		launchPath,
		JSON.stringify(launch, null, detectIndent(launchRaw)) + '\n'
	);
	log('wrote .claude/launch.json preview entries');

	// --- CLAUDE.md section (generated between markers, rest preserved) ---
	// Gives Claude in the plugin repo the playground essentials — commands,
	// where the tunnel/https public URL lives, login, log/DB paths.
	const section =
		CLAUDE_MD_BEGIN +
		'\n' +
		fs
			.readFileSync(path.join(TEMPLATES, 'claude-md-section.md'), 'utf8')
			.replaceAll('__START_PORT__', String(basePort))
			.replaceAll(
				'__DEV_PORT__',
				String(basePort + MODE_PORT_OFFSETS.development)
			)
			.replaceAll(
				'__DEMO_PORT__',
				String(basePort + MODE_PORT_OFFSETS.demo)
			)
			.trim() +
		'\n' +
		CLAUDE_MD_END;
	const claudePath = path.join(root, 'CLAUDE.md');
	const claudeBody = fs.existsSync(claudePath)
		? fs.readFileSync(claudePath, 'utf8')
		: '';
	const beginAt = claudeBody.indexOf(CLAUDE_MD_BEGIN);
	const endAt = claudeBody.indexOf(CLAUDE_MD_END);
	if (beginAt !== -1 && endAt > beginAt) {
		fs.writeFileSync(
			claudePath,
			claudeBody.slice(0, beginAt) +
				section +
				claudeBody.slice(endAt + CLAUDE_MD_END.length)
		);
		log('refreshed the WP Playground section in CLAUDE.md');
	} else {
		const glue = claudeBody
			? (claudeBody.endsWith('\n') ? '' : '\n') + '\n'
			: '';
		fs.writeFileSync(claudePath, claudeBody + glue + section + '\n');
		log(
			claudeBody
				? 'appended the WP Playground section to CLAUDE.md'
				: 'wrote CLAUDE.md (WP Playground section)'
		);
	}

	// --- ignores ---
	if (
		ensureLines(path.join(root, '.gitignore'), [
			'.playground/',
			'/pr-screenshots/',
			'.env',
		])
	) {
		log('appended .gitignore entries');
	}
	const kernlignore = path.join(root, '.kernlignore');
	if (fs.existsSync(kernlignore)) {
		if (
			ensureLines(kernlignore, [
				'.playground',
				'.playground/**/*',
				'playground.config.mjs',
				'.env',
			])
		) {
			log('appended .kernlignore entries');
		}
	}

	log(
		update
			? 'refresh complete.'
			: `scaffold complete — review ${CONFIG_FILENAME}, then: pnpm install && pnpm run playground:start`
	);
}
