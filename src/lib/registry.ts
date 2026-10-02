// Build-time Ikenga package-registry loader for the storefront.
//
// The catalog + per-pkg detail headers are generated from the published
// registry index at build time. On ANY failure — fetch error, non-200,
// empty/malformed payload, or when forced via IKENGA_REGISTRY_FALLBACK=1 —
// we fall back to the committed last-good snapshot
// (src/data/registry-snapshot.json) so a Cloudflare Pages build NEVER breaks
// on registry downtime. The fallback is never silent: it emits a loud
// build-log warning naming the snapshot's `asOf`, and the /packages page
// labels itself "from committed snapshot".
//
// Env knobs (build-time only):
//   IKENGA_REGISTRY_FALLBACK=1   skip the network, use the snapshot
//   IKENGA_REGISTRY_URL=<url>    override the index URL (e.g. to prove the
//                                failure path with a deliberately bad URL)
//
// Runnable standalone (node/bun) for verification: import { loadRegistry }
// and call it with { forceFallback } to exercise both paths.

import snapshot from '../data/registry-snapshot.json';

export const REGISTRY_URL = 'https://registry.ikenga.dev/index.json';

export type RegistryKind = 'embedded' | 'engine' | 'skill' | (string & {});

export interface RegistryPkg {
	name: string;
	latest: string;
	detail?: string;
	description: string;
	kind: RegistryKind;
	/** The registry's own source-of-truth hide flag (fixtures/stubs). */
	visibility?: 'hidden' | (string & {});
}

export interface RegistryIndex {
	$schemaVersion?: number;
	updatedAt: string;
	pkgs: RegistryPkg[];
}

export interface LoadResult {
	index: RegistryIndex;
	/** `live` = fetched this build; `snapshot` = committed fallback. */
	source: 'live' | 'snapshot';
	/** ISO stamp: when the data was obtained (live=now, snapshot=its stamp). */
	fetchedAt: string;
	/** Present only on the fallback path — the reason the live fetch failed. */
	error?: string;
}

interface SnapshotShape extends RegistryIndex {
	/** ISO stamp: when the committed copy was fetched from the live registry. */
	asOf: string;
	/** Always `last-good` for the committed copy (the shared `RegistrySnapshot` shape). */
	origin?: 'last-good';
	/** The index the copy was fetched from. */
	url?: string;
}

const FALLBACK = snapshot as unknown as SnapshotShape;

function fallbackResult(error?: string): LoadResult {
	return {
		index: { $schemaVersion: FALLBACK.$schemaVersion, updatedAt: FALLBACK.updatedAt, pkgs: FALLBACK.pkgs },
		source: 'snapshot',
		fetchedAt: FALLBACK.asOf,
		...(error ? { error } : {}),
	};
}

function forcedFallback(): boolean {
	return typeof process !== 'undefined' && process.env?.IKENGA_REGISTRY_FALLBACK === '1';
}

function registryUrl(): string {
	return (typeof process !== 'undefined' && process.env?.IKENGA_REGISTRY_URL) || REGISTRY_URL;
}

/**
 * Loud, single-line build-summary note for the fallback path. A silently
 * stale catalog is a real failure, so this always prints — including
 * for a forced fallback — and names the snapshot `asOf` and its age.
 */
function warnFallback(result: LoadResult, reason: string): void {
	const ageDays = Math.floor((Date.now() - Date.parse(result.fetchedAt)) / 86_400_000);
	const age = Number.isFinite(ageDays) ? `, ${ageDays} day${ageDays === 1 ? '' : 's'} old` : '';
	const line =
		`[registry] WARNING: live registry unavailable (${reason}) - building from the COMMITTED SNAPSHOT ` +
		`asOf ${result.fetchedAt}${age} (${result.index.pkgs.length} pkgs). ` +
		`The /packages catalog may be stale; fix the registry fetch or refresh src/data/registry-snapshot.json.`;
	// Leading newline: Astro's progress line is still open when page frontmatter runs.
	console.warn(`\n${line}`);
	// Surface it on the GitHub Actions run summary too.
	if (typeof process !== 'undefined' && process.env?.GITHUB_ACTIONS) {
		console.warn(`::warning title=Registry snapshot fallback::${line}`);
	}
}

/** One timed fetch of the index; throws on any failure. */
async function fetchIndex(url: string, timeoutMs: number): Promise<RegistryIndex> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) throw new Error(`registry responded ${res.status}`);
		const index = (await res.json()) as RegistryIndex;
		if (!index || !Array.isArray(index.pkgs) || index.pkgs.length === 0) {
			throw new Error('registry index empty or malformed');
		}
		return index;
	} finally {
		clearTimeout(timer);
	}
}

// A single stalled connection (seen on a loaded Windows box: one fetch hung for
// the full timeout while the next took 120 ms) must not demote a build to the
// snapshot, so the live fetch gets one retry before we fall back.
const FETCH_ATTEMPTS = 2;

async function fetchRegistry(timeoutMs: number): Promise<LoadResult> {
	const url = registryUrl();
	let lastErr: unknown;
	for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
		try {
			const index = await fetchIndex(url, timeoutMs);
			console.log(`\n[registry] live: ${index.pkgs.length} pkgs (updatedAt ${index.updatedAt}) from ${url}`);
			return { index, source: 'live', fetchedAt: new Date().toISOString() };
		} catch (err) {
			lastErr = err;
		}
	}
	const base = lastErr instanceof Error ? lastErr.message : String(lastErr);
	// undici reports network failures as a bare "fetch failed"; the useful part is the cause.
	const code = (lastErr as { cause?: { code?: string } } | null)?.cause?.code;
	const message = `${code ? `${base} (${code})` : base}, after ${FETCH_ATTEMPTS} attempts`;
	const result = fallbackResult(message);
	warnFallback(result, `${url}: ${message}`);
	return result;
}

// One load per process (shared across every page's frontmatter), so a build
// fetches once, warns once, and every page renders the SAME registry data. The
// short TTL keeps `astro dev` from pinning a stale or failed result forever.
const CACHE_KEY = Symbol.for('ikenga-site.registry.load');
const CACHE_TTL_MS = 5 * 60_000;
type Cached = { at: number; result: Promise<LoadResult> };

/**
 * Load the registry index at build time. Live fetch first; committed
 * snapshot on any failure (with a loud warning). Never throws — always
 * resolves to a LoadResult.
 *
 * Calls with no options share one load per process. Passing an option
 * (tests, one-off probes) bypasses that cache.
 */
export async function loadRegistry(
	opts: { forceFallback?: boolean; timeoutMs?: number } = {},
): Promise<LoadResult> {
	const load = (): Promise<LoadResult> => {
		if (opts.forceFallback ?? forcedFallback()) {
			const result = fallbackResult();
			warnFallback(result, 'fallback forced via IKENGA_REGISTRY_FALLBACK=1 or forceFallback');
			return Promise.resolve(result);
		}
		return fetchRegistry(opts.timeoutMs ?? 8000);
	};

	if (opts.forceFallback !== undefined || opts.timeoutMs !== undefined) return load();

	const g = globalThis as unknown as Record<symbol, Cached | undefined>;
	const cached = g[CACHE_KEY];
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;
	const entry: Cached = { at: Date.now(), result: load() };
	g[CACHE_KEY] = entry;
	return entry.result;
}

// ── Selection + presentation helpers ───────────────────────────────────────

/** Belt-and-suspenders hide list, alongside each pkg's `visibility` flag. */
export const HIDDEN_NAMES = new Set<string>([
	'@ikenga/pkg-engine-cursor-agent',
	'@ikenga/pkg-engine-noop',
	'@ikenga/pkg-hello',
]);

export function isVisible(pkg: RegistryPkg): boolean {
	return pkg.visibility !== 'hidden' && !HIDDEN_NAMES.has(pkg.name);
}

export function visiblePkgs(index: RegistryIndex): RegistryPkg[] {
	return (index.pkgs ?? []).filter(isVisible);
}

/** `@ikenga/pkg-tasks` → `pkg-tasks`. */
export function label(name: string): string {
	return name.replace(/^@ikenga\//, '');
}

/** First sentence of a description, hard-capped so cards stay even. */
export function oneLine(description: string | undefined): string {
	const first = (description ?? '').split(/(?<=\.)\s/)[0].trim();
	return first.length > 140 ? `${first.slice(0, 137).trimEnd()}…` : first;
}

/** The in-shell install one-liner for a registry pkg. */
export function installCmd(pkg: RegistryPkg): string {
	return `ikenga add ${pkg.name}`;
}

export function pkgByName(index: RegistryIndex, name: string): RegistryPkg | undefined {
	return (index.pkgs ?? []).find((p) => p.name === name);
}

/** Registry `latest` for a pkg, or a caller-supplied fallback if absent. */
export function pkgVersion(index: RegistryIndex, name: string, fallback = ''): string {
	return pkgByName(index, name)?.latest ?? fallback;
}

// ── Catalog grouping (by the registry's own `kind`) ─────────────────────────

export interface CatalogCategory {
	key: string;
	blurb: string;
	match: (pkg: RegistryPkg) => boolean;
}

export const CATALOG_CATEGORIES: CatalogCategory[] = [
	{ key: 'Apps', blurb: 'iframe mini-apps that run inside the shell', match: (p) => p.kind === 'embedded' },
	{ key: 'MCP servers', blurb: 'tool servers any MCP client can drive', match: (p) => p.kind === 'skill' && p.name.includes('mcp-') },
	{ key: 'Engines', blurb: 'pluggable reasoning adapters — same setup, different backend', match: (p) => p.kind === 'engine' },
	{ key: 'Skills', blurb: 'Claude Code skill packages', match: (p) => p.kind === 'skill' && !p.name.includes('mcp-') },
];

export interface GroupedCategory extends CatalogCategory {
	rows: RegistryPkg[];
}

/** Group the visible pkgs by kind, dropping empty categories. */
export function groupByKind(index: RegistryIndex): GroupedCategory[] {
	const visible = visiblePkgs(index);
	return CATALOG_CATEGORIES.map((c) => ({
		...c,
		rows: visible.filter(c.match).sort((a, b) => a.name.localeCompare(b.name)),
	})).filter((c) => c.rows.length > 0);
}

// ── "Coming" strip: built in ikenga-pkgs, not yet in the registry ───────────
//
// Honest by construction: these six app pkgs exist in ikenga-pkgs but are NOT
// published to the registry, so they appear ONLY as a labelled "coming" strip
// with NO install affordance and NO version claim. Domain one-liners only —
// zero fabricated metrics, zero music-vertical flavor.

export interface ComingPkg {
	name: string;
	line: string;
}

export const COMING_PKGS: ComingPkg[] = [
	{ name: 'studio', line: 'The orchestration spine for AI film — script to breakdown, cast, storyboard, generation, and final cut on one board.' },
	{ name: 'agent-ops', line: 'Operate and monitor your scheduled agents from inside the shell.' },
	{ name: 'finance', line: 'A money-in / money-out workspace for your books, in one pane.' },
	{ name: 'outbound', line: 'Draft, queue, and track outbound messages.' },
	{ name: 'sales', line: 'A lightweight pipeline for deals and follow-ups.' },
	{ name: 'content', line: 'Plan and track content from idea to published.' },
];

/**
 * Self-correcting "coming" strip: drop any pkg that the registry now
 * publishes (it appears in the catalog grid instead). As the atelier-parity
 * publishes land, each app pkg moves coming → catalog with zero code change,
 * and is never double-listed. Honest by construction.
 */
export function comingPkgs(index: RegistryIndex): ComingPkg[] {
	const published = new Set((index.pkgs ?? []).map((p) => p.name));
	return COMING_PKGS.filter((c) => !published.has(`@ikenga/pkg-${c.name}`));
}
