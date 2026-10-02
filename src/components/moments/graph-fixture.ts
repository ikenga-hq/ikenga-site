/**
 * graph-fixture.ts — the {nodes, edges} source for MomentGraph (SPIKE-07).
 *
 * HONESTY GATE (G-19): every node here traces to the vendored `cast.json`
 * (byte-identical copy of `plans/site-redesign/designs/_fixtures/cast.json`).
 * Two slices of that fixture are both explicitly "registry-verified" per its
 * own README (`_fixtures/README.md`): `capability_nodes` (9 entries: three
 * skills, a command, two mcps, two engines) and `store_rows` (8 registry
 * UI pkgs — tasks/mail/research/strategy/content/finance/outbound/sales).
 * Both are copied name-for-name from `ikenga-registry/index.json` as of the
 * cast's `verified_on` date. No node below is invented; nothing outside these
 * two arrays is used. Total = 16 nodes.
 *
 * DENSITY NOTE (WP-22 / G-CAST): the SPIKE-07 brief asked for ~14-22 nodes /
 * ~20-30 links. Against the provisional draft the registry-verified surface
 * only supported 11 nodes; the G-CAST lock sweep re-curated against the live
 * 18-pkg registry (updatedAt 2026-07-04) and the honest set now lands at 16
 * nodes / 22 edges — inside the spike target without inventing anything. Still
 * EXCLUDED (real, but not in cast.json — its curators left them out):
 * huashu-design / frontend-design / ikenga-pkg-builder (groundwork composes
 * them "when present"), and the hidden registry stubs (pkg-hello, engine-noop,
 * engine-cursor-agent). The honesty gate still wins over the count target.
 *
 * Edge derivation mirrors the shell's own model (graph-shared.ts): each edge
 * is tagged `declarative` (solid — stated outright in a skill/pkg/registry
 * description) or `heuristic` (dashed — a plausible, inferred relation, e.g.
 * "the iyke control bridge can drive any installed pkg pane" is true of the
 * bridge in general, not cited per-pkg anywhere).
 */
import cast from './cast.json';

export type GraphKind = 'skill' | 'command' | 'mcp' | 'engine' | 'pkg';

export interface GraphNode {
	id: string;
	label: string;
	kind: GraphKind;
	detail: string;
	/** Registry version, when the fixture carries one (mcp/engine/pkg). */
	version?: string;
	/** Human one-liner for the info board (GraphDetailCard `description`).
	 * Empty for the engine rows — cast.json carries only a version for those,
	 * so the card renders no description rather than inventing one. */
	description: string;
}

export interface GraphEdge {
	id: string;
	source: string;
	target: string;
	rel: 'composes' | 'uses' | 'gates' | 'feeds';
	derivation: 'declarative' | 'heuristic';
}

/** Kind → hue. Sourced from the shell's own `--nk-*` tokens
 * (`shell/src/shell/claude-config/claude-config.css`) so the site's palette
 * reads as the same object as the reference screenshot, not a reinvention.
 * `engine` reuses the agent hue (an engine is the thing driving the agent
 * loop); `pkg` reuses `--st-linked`'s blue (same file) — there is no
 * registry-UI-pkg kind in the shell's graph today, so this is the site's own
 * grouping label, not a fabricated shell primitive. */
export const KIND_COLOR: Record<GraphKind, string> = {
	skill: 'hsl(42, 84%, 60%)',
	command: 'hsl(20, 64%, 54%)',
	mcp: 'hsl(170, 44%, 52%)',
	engine: 'hsl(284, 48%, 64%)',
	pkg: 'hsl(212, 48%, 60%)',
};

export const KIND_LABEL: Record<GraphKind, string> = {
	skill: 'Skills',
	command: 'Commands',
	mcp: 'MCPs',
	engine: 'Engines',
	pkg: 'Pkgs',
};

/** Stable draw order for the kind bands (clockwise from 12 o'clock). */
export const KIND_ORDER: GraphKind[] = ['skill', 'command', 'mcp', 'engine', 'pkg'];

/** Kind → glyph. Mirrors the shell's `KIND_GLYPH` (store-matrix.tsx /
 * flow-view.tsx `REF_GLYPH`) so the store map + flow rows read as the same
 * object as the reference screenshots. `pkg` reuses the store-map's ▦. */
export const KIND_GLYPH: Record<GraphKind, string> = {
	skill: '◆',
	command: '⌘',
	mcp: '⬡',
	engine: '★',
	pkg: '▦',
};

function slug(name: string): string {
	return name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

const nodes: GraphNode[] = [
	...cast.capability_nodes.map((n) => {
		const version = 'version' in n && n.version ? n.version : undefined;
		return {
			id: slug(n.name),
			label: n.name,
			kind: n.kind as GraphKind,
			// the 2 engine entries carry no `detail`, only `version` — cast.json
			// as authored, not a gap introduced here.
			detail: n.detail ?? (version ? `v${version}` : ''),
			version,
			// engines carry no human one-liner in the cast → empty description
			// (the card omits it rather than fabricating one). skill/command/mcp
			// use their factual cast `detail` note verbatim.
			description: n.kind === 'engine' ? '' : (n.detail ?? ''),
		};
	}),
	...cast.store_rows.map((p) => ({
		id: slug(p.name),
		label: p.name,
		kind: 'pkg' as GraphKind,
		detail: `v${p.version} — ${p.description}`,
		version: p.version,
		description: p.description,
	})),
];

/** Relation → kind whose hue it borrows (relation semantics, not the node's
 * own kind — mirrors the shell's `REL_COLOR` in intent, not source). */
export const REL_KIND: Record<GraphEdge['rel'], GraphKind> = {
	composes: 'skill',
	uses: 'command',
	gates: 'mcp',
	feeds: 'engine',
};

const edge = (
	source: string,
	target: string,
	rel: GraphEdge['rel'],
	derivation: GraphEdge['derivation'],
): GraphEdge => ({ id: `${source}→${target}`, source: slug(source), target: slug(target), rel, derivation });

const edges: GraphEdge[] = [
	// ── declarative — stated outright in a skill/pkg/registry description ──
	// groundwork's own skill description: "Composes ikenga-artifact-builder,
	// huashu-design, frontend-design, ikenga-pkg-builder when present".
	edge('groundwork', 'ikenga-artifact-builder', 'composes', 'declarative'),
	// /release-status's own description: "Scan all child repos in the Ikenga
	// workspace for unreleased commits, GitHub Releases drift, registry drift,
	// and stale doc claims" — that scan covers EVERY registry pkg, so it reads
	// (uses) each of the eight store UI pkgs. The four post-publish additions
	// (content/finance/outbound/sales) inherit the exact same honest edge as
	// the original four ("densification comes free at G-CAST", R3-b).
	edge('/release-status', '@ikenga/pkg-tasks', 'uses', 'declarative'),
	edge('/release-status', '@ikenga/pkg-mail', 'uses', 'declarative'),
	edge('/release-status', '@ikenga/pkg-research', 'uses', 'declarative'),
	edge('/release-status', '@ikenga/pkg-strategy', 'uses', 'declarative'),
	edge('/release-status', '@ikenga/pkg-content', 'uses', 'declarative'),
	edge('/release-status', '@ikenga/pkg-finance', 'uses', 'declarative'),
	edge('/release-status', '@ikenga/pkg-outbound', 'uses', 'declarative'),
	edge('/release-status', '@ikenga/pkg-sales', 'uses', 'declarative'),
	// mcp-iyke's own description: "drive a running Tauri AI workspace from
	// any MCP client" — that includes swapping/inspecting whichever chat
	// engine a session is pinned to.
	edge('@ikenga/mcp-iyke', '@ikenga/pkg-engine-claude-code', 'gates', 'declarative'),
	edge('@ikenga/mcp-iyke', '@ikenga/pkg-engine-codex', 'gates', 'declarative'),

	// ── heuristic — plausible, inferred (not cited per-pkg anywhere) ──
	// the iyke control bridge's DOM/click/query surface can reach any
	// installed pkg pane in general; not verified against these pkgs by name.
	// Uniform across all eight store panes (singling out a subset would be
	// arbitrary now that all eight are published).
	edge('@ikenga/mcp-iyke', '@ikenga/pkg-tasks', 'gates', 'heuristic'),
	edge('@ikenga/mcp-iyke', '@ikenga/pkg-mail', 'gates', 'heuristic'),
	edge('@ikenga/mcp-iyke', '@ikenga/pkg-research', 'gates', 'heuristic'),
	edge('@ikenga/mcp-iyke', '@ikenga/pkg-strategy', 'gates', 'heuristic'),
	edge('@ikenga/mcp-iyke', '@ikenga/pkg-content', 'gates', 'heuristic'),
	edge('@ikenga/mcp-iyke', '@ikenga/pkg-finance', 'gates', 'heuristic'),
	edge('@ikenga/mcp-iyke', '@ikenga/pkg-outbound', 'gates', 'heuristic'),
	edge('@ikenga/mcp-iyke', '@ikenga/pkg-sales', 'gates', 'heuristic'),
	// ikenga-artifact-builder's own description: "lights up with live data
	// when opened inside the Ikenga shell" — tasks is the most likely first
	// live-data source, not a cited specific.
	edge('ikenga-artifact-builder', '@ikenga/pkg-tasks', 'feeds', 'heuristic'),
	// skill-thunderbird's own description: "read/search the local Thunderbird
	// mbox store and save reply drafts to the IMAP server" — pkg-mail is the
	// shell surface that mail flows into; plausible feed, not cited by name.
	edge('@ikenga/skill-thunderbird', '@ikenga/pkg-mail', 'feeds', 'heuristic'),
	// mcp-browser drives native webview panes onto external portals; pkg-outbound
	// is the surface that reaches external channels — plausible reach, not cited.
	edge('@ikenga/mcp-browser', '@ikenga/pkg-outbound', 'gates', 'heuristic'),
];

export const graphFixture = { nodes, edges };
