/**
 * PR screenshot + collage generator (Playwright → WordPress Playground).
 *
 * Generic engine — reads the surface list from the plugin's shots manifest
 * (config.screenshots) and drives a running Playground site (default: the
 * seeded demo server on basePort+2). Captures each surface to PNG, then
 * assembles a labeled collage. Nothing here is plugin-specific except what
 * the manifest declares.
 *
 * Layout (everything under the git-ignored pr-screenshots/):
 *   pr-screenshots/<branch>-<sha>.png                 ← collages (kept; distinct per commit)
 *   pr-screenshots/<branch>-<sha>-before-after.png
 *   pr-screenshots/.shots/<branch>-<sha>/*.png        ← transient raw shots
 *
 * Each capture run is keyed by the current commit (`<branch>-<shortsha>`,
 * plus `-dirty` when the tree has uncommitted code), so runs never overwrite
 * each other. Raw-shot dirs are pruned to the newest KROKEDIL_PG_KEEP_SHOTS
 * (default 6); collages to the newest KROKEDIL_PG_KEEP_COLLAGES (default 30).
 *
 * Usage (normally via a /pr-screenshots skill or `pnpm run screenshots`):
 *   krokedil-playground screenshots                    # after-only collage
 *   krokedil-playground screenshots --no-collage
 *   krokedil-playground screenshots --collage --after <ref> --before <ref> \
 *        --before-label develop --after-label my-feature
 *
 * Flags: --only a,b | --no-collage | --id NAME |
 *        --collage --after REF [--before REF] [--before-label T] [--after-label T] [--name OUT] |
 *        --port N | --host H
 *   REF = a `.shots/<id>` dir name, or a path (anything containing "/").
 * Env:   KROKEDIL_PG_SCREENSHOT_PORT, KROKEDIL_PG_SCREENSHOT_HOST,
 *        KROKEDIL_PG_WP_USER, KROKEDIL_PG_WP_PASS,
 *        KROKEDIL_PG_KEEP_SHOTS, KROKEDIL_PG_KEEP_COLLAGES
 *
 * Requires the optional @playwright/test peer dep and a one-time
 * `pnpm exec playwright install chromium` (npm: `npx playwright install chromium`).
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
	mkdir,
	readFile,
	readdir,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { MODE_PORT_OFFSETS } from '../config.mjs';

/**
 * Parse a prune "keep newest N" env value, defending the rm -rf below: a
 * non-numeric or non-positive value must fall back, never reach the prune —
 * `NaN` passes the `length <= keep` guard and `slice(NaN)` selects the whole
 * list for deletion.
 *
 * @param {string|undefined} raw      Raw env value.
 * @param {number}           fallback Default when unset/invalid.
 * @return {number} A positive integer.
 */
export function keepCount(raw, fallback) {
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Load Playwright's chromium — preferring the PLUGIN's @playwright/test (its
 * devDependency, whose browsers the developer installed) over any copy in
 * this package's own tree, so versions and browser revisions always match.
 * Fails with an actionable message when neither resolves.
 *
 * @param {string} root Plugin root to resolve from.
 * @return {Promise<Object>} The chromium browser type.
 */
async function loadChromium(root) {
	try {
		const require = createRequire(path.join(root, 'package.json'));
		const resolved = require.resolve('@playwright/test');
		// CJS entry: named-export interop isn't guaranteed, so check default too.
		const mod = await import(pathToFileURL(resolved).href);
		const chromium = mod.chromium ?? mod.default?.chromium;
		if (chromium) {
			return chromium;
		}
	} catch {
		// Fall through to our own resolution.
	}
	try {
		const { chromium } = await import('@playwright/test');
		return chromium;
	} catch {
		throw new Error(
			"screenshots need @playwright/test — add it to the plugin's devDependencies " +
				'and run `pnpm exec playwright install chromium` (npm: `npx playwright install chromium`).'
		);
	}
}

/**
 * Run the screenshots command.
 *
 * @param {string}   root         Plugin root (absolute).
 * @param {Object}   pluginConfig Normalized playground config.
 * @param {string[]} argv         CLI args after "screenshots".
 * @return {Promise<void>} Resolves when capture/collage is done.
 */
export async function capture(root, pluginConfig, argv) {
	if (!pluginConfig.screenshots) {
		throw new Error(
			'no shots manifest configured — set config.screenshots to a shots.config.mjs path.'
		);
	}
	const manifestPath = path.resolve(root, pluginConfig.screenshots);
	const config = (await import(pathToFileURL(manifestPath).href)).default;

	const OUT_ROOT = path.join(root, 'pr-screenshots'); // collages live here
	const WORK_ROOT = path.join(OUT_ROOT, '.shots'); // transient per-commit raw shots

	const has = (name) => argv.includes(`--${name}`);
	const val = (name, def) => {
		const i = argv.indexOf(`--${name}`);
		return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')
			? argv[i + 1]
			: def;
	};
	const csv = (s) =>
		String(s || '')
			.split(',')
			.map((x) => x.trim())
			.filter(Boolean);
	const slug = (s) =>
		String(s || '')
			.replace(/[^A-Za-z0-9._-]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'work';

	const git = (cmd, def = '') => {
		try {
			return execSync(`git ${cmd}`, { cwd: root }).toString().trim();
		} catch {
			return def;
		}
	};
	// Identify a capture by the commit it was taken at: <branch>-<shortsha>[-dirty].
	const captureId = () => {
		const branch = slug(git('rev-parse --abbrev-ref HEAD', 'work'));
		const sha = git('rev-parse --short HEAD', 'nosha');
		const dirty = git('status --porcelain --untracked-files=no')
			? '-dirty'
			: '';
		return `${branch}-${sha}${dirty}`;
	};
	const refToDir = (ref) =>
		String(ref).includes('/')
			? path.resolve(root, ref)
			: path.join(WORK_ROOT, slug(ref));

	const log = (...a) => console.log('[screenshots]', ...a);
	// Match the Playground site's canonical host (siteurl is 127.0.0.1, not
	// localhost) — browsing the wrong host breaks the auth cookie.
	const HOST = val(
		'host',
		process.env.KROKEDIL_PG_SCREENSHOT_HOST || '127.0.0.1'
	);
	const demoPort = pluginConfig.basePort + MODE_PORT_OFFSETS.demo;

	// Resolve which port the demo Playground server is on. An explicit --port
	// or the env always wins. Otherwise probe $PORT and demoPort..demoPort+3
	// and target the first that answers as WordPress.
	const resolveScreenshotPort = async () => {
		const explicit = val('port') || process.env.KROKEDIL_PG_SCREENSHOT_PORT;
		if (explicit) {
			return Number(explicit);
		}
		if (has('collage')) {
			return demoPort; // collage assembly never contacts a server
		}
		const seen = new Set();
		const candidates = [
			process.env.PORT,
			demoPort,
			demoPort + 1,
			demoPort + 2,
			demoPort + 3,
		]
			.map(Number)
			.filter((p) => p && !seen.has(p) && seen.add(p));
		for (const p of candidates) {
			try {
				const res = await fetch(`http://${HOST}:${p}/wp-login.php`, {
					signal: AbortSignal.timeout(2000),
				});
				if (res.ok) {
					log(`auto-detected Playground on :${p}`);
					return p;
				}
			} catch {
				// Not listening / not WordPress — try the next candidate.
			}
		}
		log(
			`no live Playground on ${demoPort}-${demoPort + 3}; defaulting to :${demoPort}`
		);
		return demoPort;
	};

	const PORT = await resolveScreenshotPort();
	const BASE = `http://${HOST}:${PORT}`;
	const USER = process.env.KROKEDIL_PG_WP_USER || 'admin';
	const PASS = process.env.KROKEDIL_PG_WP_PASS || 'password';
	const VIEWPORT = config.viewport || { width: 1366, height: 900 };
	const KEEP_COLLAGES = keepCount(process.env.KROKEDIL_PG_KEEP_COLLAGES, 30);
	const pageCache = new Map(); // block name → { id, link }, reused within a run

	// Keep the newest `keep` entries (dirs or *.png files) under `dir`.
	const pruneOldest = async (dir, keep, kind) => {
		if (!existsSync(dir)) {
			return;
		}
		const entries = await readdir(dir, { withFileTypes: true });
		const items = entries.filter((e) =>
			kind === 'dir'
				? e.isDirectory()
				: e.isFile() && e.name.endsWith('.png')
		);
		if (items.length <= keep) {
			return;
		}
		const timed = [];
		for (const e of items) {
			const p = path.join(dir, e.name);
			timed.push({ p, t: (await stat(p)).mtimeMs });
		}
		timed.sort((a, b) => b.t - a.t); // newest first
		for (const old of timed.slice(keep)) {
			await rm(old.p, { recursive: true, force: true });
		}
		log(
			`pruned ${timed.length - keep} old ${kind === 'dir' ? 'shot set(s)' : 'collage(s)'} (kept ${keep})`
		);
	};

	// Lay the captured PNGs out in a labeled grid (rows = surfaces, columns =
	// before/after or a single state) and screenshot it through headless
	// Chrome — no image library needed.
	const buildCollage = async ({
		afterDir,
		afterLabel,
		beforeDir,
		beforeLabel,
		name,
	}) => {
		const cols = [];
		if (beforeDir && existsSync(beforeDir)) {
			cols.push({ dir: beforeDir, kind: 'before', label: beforeLabel });
		}
		if (existsSync(afterDir)) {
			cols.push({
				dir: afterDir,
				kind: beforeDir ? 'after' : 'neutral',
				label: afterLabel,
			});
		}
		if (!cols.length) {
			log('collage: no input dirs found');
			return;
		}

		const order = config.shots.map((s) => ({
			name: s.name,
			label: s.label || s.name,
		}));
		for (const c of cols) {
			c.imgs = {};
			c.meta = null;
			const metaPath = path.join(c.dir, '.meta.json');
			if (existsSync(metaPath)) {
				try {
					c.meta = JSON.parse(await readFile(metaPath, 'utf8'));
				} catch {
					// Unreadable meta — fall back to the dir name for the sha.
				}
			}
			for (const s of order) {
				const p = path.join(c.dir, `${s.name}.png`);
				if (existsSync(p)) {
					c.imgs[s.name] =
						'data:image/png;base64,' +
						(await readFile(p)).toString('base64');
				}
			}
		}
		const rows = order.filter((s) => cols.some((c) => c.imgs[s.name]));
		if (!rows.length) {
			log('collage: no images found');
			return;
		}

		await mkdir(OUT_ROOT, { recursive: true });
		const subtitle =
			cols.length === 2 ? `${beforeLabel}  →  ${afterLabel}` : afterLabel;
		const html = collageHtml(
			config.title || 'UI preview',
			subtitle,
			cols,
			rows
		);
		const chromium = await loadChromium(root);
		const b = await chromium.launch({ headless: true });
		const pg = await b.newPage({
			viewport: { width: 2400, height: 1400 },
			deviceScaleFactor: 2,
		});
		await pg.setContent(html, { waitUntil: 'load' });
		const el = pg.locator('#collage');
		await el.waitFor({ state: 'visible' });
		const out = path.join(OUT_ROOT, `${slug(name)}.png`);
		await el.screenshot({ path: out });
		await b.close();
		log(
			'collage →',
			path.relative(root, out),
			`(${cols.length} col × ${rows.length} rows)`
		);
	};

	if (has('collage')) {
		const afterDir = refToDir(val('after', captureId()));
		const beforeArg = val('before', '');
		const beforeDir = beforeArg ? refToDir(beforeArg) : null;
		const afterId = path.basename(afterDir);
		await buildCollage({
			afterDir,
			afterLabel: val('after-label', '') || afterId,
			beforeDir,
			beforeLabel:
				val('before-label', '') ||
				(beforeDir ? path.basename(beforeDir) : ''),
			name:
				val('name', '') ||
				(beforeDir ? `${afterId}-before-after` : afterId),
		});
		await pruneOldest(OUT_ROOT, KEEP_COLLAGES, 'png');
		return;
	}

	// ---- capture mode ----
	const ONLY = csv(val('only', ''));
	const ID = slug(val('id', captureId()));
	const OUT_DIR = path.join(WORK_ROOT, ID);
	const shots = config.shots.filter(
		(s) => !ONLY.length || ONLY.includes(s.name)
	);

	// Wipe this commit's shot dir so a re-run is fresh, never mixed with stale shots.
	await rm(OUT_DIR, { recursive: true, force: true });
	await mkdir(OUT_DIR, { recursive: true });

	// Record which commit these shots were taken at, so the collage can show it.
	await writeFile(
		path.join(OUT_DIR, '.meta.json'),
		JSON.stringify(
			{
				id: ID,
				branch: git('rev-parse --abbrev-ref HEAD', ''),
				sha: git('rev-parse --short HEAD', ''),
				dirty: !!git('status --porcelain --untracked-files=no'),
				date: new Date().toISOString(),
			},
			null,
			2
		)
	);

	// Authenticate this Playwright context (the blueprint's `login:true` only
	// logs in Playground's own browser, not ours).
	const login = async (pg) => {
		await pg.goto(`${BASE}/wp-admin/`, {
			waitUntil: 'domcontentloaded',
			timeout: 60000,
		});
		if (
			pg.url().includes('wp-login.php') ||
			(await pg.locator('#user_login').count())
		) {
			await pg.fill('#user_login', USER);
			await pg.fill('#user_pass', PASS);
			await pg.click('#wp-submit');
			await pg.waitForURL('**/wp-admin/**', { timeout: 60000 });
		}
		await pg.waitForSelector('#wpadminbar', { timeout: 60000 });
		log('logged in as', USER, '@', BASE);
	};

	// Load a block-editor screen so window.wp.apiFetch is available for seeding pages.
	const ensureApiFetch = async (pg) => {
		await pg.goto(`${BASE}/wp-admin/post-new.php?post_type=page`, {
			waitUntil: 'domcontentloaded',
		});
		await pg.waitForFunction(() => window.wp && window.wp.apiFetch, {
			timeout: 45000,
		});
	};

	// Publish a clean page containing just the block, returning { id, link }.
	const blockPage = async (pg, block) => {
		if (pageCache.has(block)) {
			return pageCache.get(block);
		}
		// Neutral, manifest-overridable naming — keeps plugin branding out of the engine.
		const prefix = config.seedPagePrefix || 'pr-screenshot';
		const res = await pg.evaluate(
			async (args) => {
				const r = await window.wp.apiFetch({
					path: '/wp/v2/pages',
					method: 'POST',
					data: {
						title: args.title,
						slug: args.slug,
						status: 'publish',
						content: `<!-- wp:${args.block} /-->`,
					},
				});
				return { id: r.id, link: r.link };
			},
			{
				title: `${prefix}: ${block}`,
				slug: slug(`${prefix}-${block}`),
				block,
			}
		);
		pageCache.set(block, res);
		return res;
	};

	// Screenshot the first matching selector, else the viewport.
	const clip = async (pg, out, selectors) => {
		for (const sel of [].concat(selectors)) {
			const loc = pg.locator(sel).first();
			if (
				(await loc.count()) &&
				(await loc.isVisible().catch(() => false))
			) {
				await loc.screenshot({ path: out });
				return;
			}
		}
		await pg.screenshot({ path: out, fullPage: false });
	};

	const captureShot = async (pg, shot) => {
		const out = path.join(OUT_DIR, `${shot.name}.png`);
		await pg.setViewportSize(shot.viewport || VIEWPORT);

		if (shot.type === 'frontend-block') {
			const { link } = await blockPage(pg, shot.block);
			await pg.goto(link, { waitUntil: 'domcontentloaded' });
			if (shot.waitFor) {
				await pg
					.locator(shot.waitFor)
					.first()
					.waitFor({ state: 'visible' });
			}
			await clip(
				pg,
				out,
				shot.clip || ['.entry-content', 'main', '#primary']
			);
			return;
		}

		if (shot.type === 'editor-block') {
			const { id } = await blockPage(pg, shot.block);
			await pg.goto(`${BASE}/wp-admin/post.php?post=${id}&action=edit`, {
				waitUntil: 'domcontentloaded',
			});
			await pg.waitForFunction(() => window.wp && window.wp.data, {
				timeout: 45000,
			});
			// Fallback: the blueprints already disable the welcome guide for the
			// admin user; this also keeps the canvas clean on sites that don't.
			await pg.evaluate(() => {
				try {
					window.wp.data
						.dispatch('core/preferences')
						.set('core/edit-post', 'welcomeGuide', false);
				} catch {
					// Preference store not present on this build — ignore.
				}
			});
			const block = pg
				.frameLocator('iframe[name="editor-canvas"]')
				.locator(`[data-type="${shot.block}"]`);
			await block.waitFor({ state: 'visible', timeout: 45000 });
			await pg.waitForTimeout(2500); // let the ServerSideRender REST round-trip paint
			await block.screenshot({ path: out });
			return;
		}

		if (shot.type === 'admin') {
			await pg.goto(`${BASE}${shot.path}`, {
				waitUntil: 'domcontentloaded',
			});
			// Optional interaction before capture — e.g. advance a multi-step form.
			// `clickText` matches visible text; `click` is a CSS selector.
			if (shot.clickText) {
				await pg
					.getByText(shot.clickText, { exact: false })
					.first()
					.click();
				await pg.waitForTimeout(700);
			} else if (shot.click) {
				await pg.locator(shot.click).first().click();
				await pg.waitForTimeout(700);
			}
			if (shot.waitFor) {
				await pg
					.locator(shot.waitFor)
					.first()
					.waitFor({ state: 'visible' });
			}
			await clip(pg, out, shot.clip || ['.wrap', 'body']);
			return;
		}

		throw new Error(`unknown shot type: ${shot.type}`);
	};

	const chromium = await loadChromium(root);
	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({
		viewport: VIEWPORT,
		deviceScaleFactor: 2,
	});
	const page = await context.newPage();
	page.setDefaultTimeout(45000); // PHP-in-WASM is slow; be generous.

	let ok = 0;
	try {
		await login(page);
		await ensureApiFetch(page);
		for (const shot of shots) {
			// One retry — Playground (PHP-in-WASM) occasionally stalls a page load.
			for (let attempt = 1; attempt <= 2; attempt++) {
				try {
					await captureShot(page, shot);
					ok++;
					log('✓', shot.name);
					break;
				} catch (e) {
					const msg = e.message.split('\n')[0];
					if (attempt < 2) {
						log('… retry', shot.name, '—', msg);
					} else {
						log('✗', shot.name, '—', msg);
					}
				}
			}
		}
	} finally {
		await browser.close();
	}
	log(`captured ${ok}/${shots.length} → ${path.relative(root, OUT_DIR)}`);
	const failed = shots.length - ok;
	if (failed > 0) {
		// Surface failures to automation/CI; still build the collage from what succeeded.
		log(`⚠ ${failed} shot(s) failed`);
		process.exitCode = 1;
	}
	const KEEP_SHOTS = keepCount(process.env.KROKEDIL_PG_KEEP_SHOTS, 6);
	await pruneOldest(WORK_ROOT, KEEP_SHOTS, 'dir');

	if (!has('no-collage') && ok > 0) {
		await buildCollage({
			afterDir: OUT_DIR,
			afterLabel: config.afterLabel || ID,
			beforeDir: null,
			beforeLabel: '',
			name: ID,
		});
		await pruneOldest(OUT_ROOT, KEEP_COLLAGES, 'png');
	}
}

/**
 * Render the collage HTML grid.
 *
 * @param {string}   title    Collage heading.
 * @param {string}   subtitle Sub-heading (labels / before→after).
 * @param {Object[]} cols     Column descriptors with imgs/meta.
 * @param {Object[]} rows     Row descriptors (name/label).
 * @return {string} HTML document.
 */
function collageHtml(title, subtitle, cols, rows) {
	const esc = (s) =>
		String(s).replace(
			/[&<>"]/g,
			(c) =>
				({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
		);
	const badge = (c) => {
		if (c.kind === 'before') {
			return '<span class="badge before">BEFORE</span>';
		}
		if (c.kind === 'after') {
			return '<span class="badge after">AFTER</span>';
		}
		return '';
	};
	const fmtDate = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') : '');
	const metaLine = (c) =>
		c.meta
			? `${c.meta.sha}${c.meta.dirty ? ' · dirty' : ''} · ${fmtDate(c.meta.date)}`
			: path.basename(c.dir);
	const heads = cols
		.map(
			(c) =>
				`<th class="col ${c.kind}">${badge(c)}<div class="sub">${esc(c.label)}</div><div class="meta">${esc(metaLine(c))}</div></th>`
		)
		.join('');
	const body = rows
		.map((r) => {
			const cells = cols
				.map((c) =>
					c.imgs[r.name]
						? `<td class="${c.kind}"><img src="${c.imgs[r.name]}"></td>`
						: `<td class="${c.kind}"><div class="missing">not present<small>${esc(c.label)}</small></div></td>`
				)
				.join('');
			return `<tr><th class="r">${esc(r.label)}</th>${cells}</tr>`;
		})
		.join('');
	return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#fff;font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1e1e1e}
#collage{display:inline-block;padding:30px}
h1{font-size:26px;margin:0 0 2px}
.subtitle{font-size:14px;color:#777;margin:0 0 18px}
table{border-collapse:separate;border-spacing:20px}
thead th{vertical-align:bottom;padding-bottom:8px}
.badge{display:inline-block;padding:5px 14px;border-radius:999px;font-size:14px;font-weight:700;letter-spacing:.05em;color:#fff}
.badge.before{background:#b3261e}
.badge.after{background:#1e7e34}
.sub{font-size:13px;color:#555;margin-top:6px;font-weight:600}
.meta{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#999;margin-top:3px;font-weight:500}
th.r{text-align:right;vertical-align:middle;width:150px;color:#555;font-weight:600;padding-right:6px;font-size:15px}
td{vertical-align:top}
td img{display:block;max-width:740px;height:auto;border:1px solid #d8d8d8;border-radius:8px;box-shadow:0 1px 5px rgba(0,0,0,.09)}
td.before img{border-top:4px solid #b3261e}
td.after img{border-top:4px solid #1e7e34}
.missing{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:340px;min-height:140px;border:2px dashed #d2d2d2;border-radius:8px;background:#fafafa;color:#9a9a9a;font-size:15px;font-weight:600}
.missing small{margin-top:5px;font-size:12px;font-weight:500;color:#bcbcbc}
</style></head><body><div id="collage"><h1>${esc(title)}</h1><p class="subtitle">${esc(subtitle)}</p>
<table><thead><tr><th></th>${heads}</tr></thead><tbody>${body}</tbody></table>
</div></body></html>`;
}
