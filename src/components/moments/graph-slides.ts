/**
 * graph-slides.ts — the store-map (Beat 3) + flow-view (Beat 4) slide data for
 * MomentGraph, derived from the same registry-verified cast slice as the
 * radial graph (./graph-fixture.ts → ./cast.json).
 *
 * HONESTY GATE (G-19 / G-21):
 *   · Store rows are the SAME 17 registry-published capabilities as the graph
 *     nodes (G-CAST lock sweep, WP-22) — no new entries are invented here.
 *   · Scope columns are real: the cast's workspace scope, its project, and the
 *     personal `user` scope (cast.workspace / cast.project).
 *   · The per-scope PRESENCE encoding is a *staged demo* — it illustrates how
 *     the shell's Ọba store map reads (enabled / local / absent per scope), not
 *     a live install state. The section labels it "staged demo" in its footer,
 *     exactly as the shell's own reference does. No metric is fabricated.
 *   · The flow is groundwork's real, documented pipeline
 *     (research → design → plan → orchestrate → act); step 2 references the
 *     ikenga-artifact-builder skill it composes.
 */
import cast from './cast.json';
import { KIND_LABEL, KIND_ORDER, graphFixture, type GraphKind } from './graph-fixture';

export type Presence = 'enabled' | 'local' | 'none';
export type StoreStatus = 'enabled' | 'local';

export interface StoreScope {
	key: string;
	label: string;
}

/** Columns: workspace scope · project · personal `user` scope (all real). */
export const STORE_SCOPES: StoreScope[] = [
	{ key: 'workspace', label: cast.workspace.scope_label },
	{ key: 'project', label: cast.project.slug },
	{ key: 'user', label: 'user' },
];

/**
 * Staged per-scope presence, keyed by the registry NAME (label). The entries
 * are real; only the presence pattern is staged (see the honesty note above).
 * Mirrors the WP-12 board so the shipped section matches the reviewed design.
 */
const STAGED: Record<string, { status: StoreStatus; cells: [Presence, Presence, Presence] }> = {
	groundwork: { status: 'enabled', cells: ['enabled', 'local', 'enabled'] },
	'ikenga-artifact-builder': { status: 'enabled', cells: ['enabled', 'none', 'enabled'] },
	'@ikenga/skill-thunderbird': { status: 'local', cells: ['local', 'none', 'enabled'] },
	'/release-status': { status: 'enabled', cells: ['enabled', 'none', 'local'] },
	'@ikenga/mcp-iyke': { status: 'enabled', cells: ['enabled', 'enabled', 'none'] },
	'@ikenga/mcp-browser': { status: 'enabled', cells: ['enabled', 'none', 'local'] },
	'@ikenga/pkg-engine-claude-code': { status: 'enabled', cells: ['enabled', 'enabled', 'enabled'] },
	'@ikenga/pkg-engine-codex': { status: 'local', cells: ['local', 'none', 'enabled'] },
	'@ikenga/': { status: 'local', cells: ['none', 'none', 'enabled'] },
	'@ikenga/pkg-tasks': { status: 'enabled', cells: ['enabled', 'enabled', 'none'] },
	'@ikenga/pkg-mail': { status: 'enabled', cells: ['enabled', 'local', 'none'] },
	'@ikenga/pkg-research': { status: 'local', cells: ['local', 'enabled', 'none'] },
	'@ikenga/pkg-strategy': { status: 'local', cells: ['none', 'local', 'none'] },
	'@ikenga/pkg-content': { status: 'enabled', cells: ['enabled', 'enabled', 'none'] },
	'@ikenga/pkg-finance': { status: 'local', cells: ['local', 'none', 'none'] },
	'@ikenga/pkg-outbound': { status: 'enabled', cells: ['enabled', 'local', 'none'] },
	'@ikenga/pkg-sales': { status: 'local', cells: ['none', 'local', 'none'] },
};

export interface StoreRow {
	id: string;
	label: string;
	kind: GraphKind;
	status: StoreStatus;
	cells: Presence[];
}

export interface StoreGroup {
	kind: GraphKind;
	label: string;
	rows: StoreRow[];
}

export const storeGroups: StoreGroup[] = KIND_ORDER.map((kind) => ({
	kind,
	label: KIND_LABEL[kind],
	rows: graphFixture.nodes
		.filter((n) => n.kind === kind)
		.map((n) => {
			const staged = STAGED[n.label] ?? {
				status: 'local' as StoreStatus,
				cells: ['none', 'none', 'none'] as [Presence, Presence, Presence],
			};
			return { id: n.id, label: n.label, kind, status: staged.status, cells: staged.cells };
		}),
})).filter((g) => g.rows.length > 0);

const allRows = storeGroups.flatMap((g) => g.rows);
export const storeTotals = {
	rows: allRows.length,
	scopes: STORE_SCOPES.length,
	enabled: allRows.filter((r) => r.status === 'enabled').length,
	local: allRows.filter((r) => r.status === 'local').length,
};

// ── Flow (Beat 4) — groundwork's real research→design→plan→orchestrate→act ──
export interface FlowRef {
	name: string;
	kind: GraphKind;
}
export interface FlowStep {
	n: number;
	label: string;
	refs: FlowRef[];
}

export const FLOW_SOURCE = {
	label: 'groundwork',
	kind: 'skill' as GraphKind,
	meta: 'skill · 5-step pipeline',
};

export const FLOW_STEPS: FlowStep[] = [
	{ n: 1, label: 'research — sweep sources; stamp the 02/03 research docs', refs: [] },
	{
		n: 2,
		label: 'design — draft boards + interactive prototypes',
		refs: [{ name: 'ikenga-artifact-builder', kind: 'skill' }],
	},
	{ n: 3, label: 'plan — cut the spine into cuttable work packages', refs: [] },
	{ n: 4, label: 'orchestrate — fan work packages out to subagents', refs: [] },
	{ n: 5, label: 'act — augment the plan docs in place, no clobber', refs: [] },
];

/** Default info-board node (Beat 2 static frame): the single mcp hub. */
export const featuredNodeId =
	graphFixture.nodes.find((n) => n.kind === 'mcp')?.id ?? graphFixture.nodes[0]?.id ?? '';
