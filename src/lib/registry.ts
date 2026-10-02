// Build-time Ikenga package-registry loader for the storefront (WP-17).
//
// The catalog + per-pkg detail headers are generated from the published
// registry index at build time. On ANY failure — fetch error, non-200,
// empty/malformed payload, or when forced via IKENGA_REGISTRY_FALLBACK=1 —
// we fall back to the committed snapshot (src/data/registry-snapshot.json)
// so a Cloudflare Pages build NEVER breaks on registry downtime.
//
// Runnable standalone (node/bun) for verification: import { loadRegistry }
// and call it with { forceFallback } to exercise both paths.

import snapshot from '../data/registry-snapshot.json';

export const REGISTRY_URL = 'https://royalti-io.github.io/ikenga-registry/index.json';

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
	fetchedAt?: string;
	source?: string;
}

const FALLBACK = snapshot as unknown as SnapshotShape;

function fallbackResult(error?: string): LoadResult {
	return {
		index: { $schemaVersion: FALLBACK.$schemaVersion, updatedAt: FALLBACK.updatedAt, pkgs: FALLBACK.pkgs },
		source: 'snapshot',
		fetchedAt: FALLBACK.fetchedAt ?? FALLBACK.updatedAt,
		...(error ? { error } : {}),
	};
}

function forcedFallback(): boolean {
	return typeof process !== 'undefined' && process.env?.IKENGA_REGISTRY_FALLBACK === '1';
}

/**
 * Load the registry index at build time. Live fetch first; committed
 * snapshot on any failure. Never throws — always resolves to a LoadResult.
 */
export async function loadRegistry(
	opts: { forceFallback?: boolean; timeoutMs?: number } = {},
): Promise<LoadResult> {
	if (opts.forceFallback ?? forcedFallback()) {
		return fallbackResult();
	}

	const timeoutMs = opts.timeoutMs ?? 8000;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(REGISTRY_URL, { signal: controller.signal });
		if (!res.ok) throw new Error(`registry responded ${res.status}`);
		const index = (await res.json()) as RegistryIndex;
		if (!index || !Array.isArray(index.pkgs) || index.pkgs.length === 0) {
			throw new Error('registry index empty or malformed');
		}
		return { index, source: 'live', fetchedAt: new Date().toISOString() };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return fallbackResult(message);
	} finally {
		clearTimeout(timer);
	}
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
// Honest per G-21/DEC-1: these six app pkgs exist in ikenga-pkgs but are NOT
// published to the registry, so they appear ONLY as a labelled "coming" strip
// with NO install affordance and NO version claim. Domain one-liners only —
// zero fabricated metrics, zero music-vertical flavor (G-19).

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
 * and is never double-listed. G-21 honesty by construction.
 */
export function comingPkgs(index: RegistryIndex): ComingPkg[] {
	const published = new Set((index.pkgs ?? []).map((p) => p.name));
	return COMING_PKGS.filter((c) => !published.has(`@ikenga/pkg-${c.name}`));
}
